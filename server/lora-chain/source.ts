import type { AppConfig } from "../config";
import {
  LORA_BURN_ADDRESS,
  LORA_BUSINESS_TIME_ZONE,
  LORA_CHAIN_ID_HEX,
  LARGE_TRANSFER_THRESHOLD_WEI,
  LORA_PAIR_ADDRESS,
  LORA_ROUTER_ADDRESS,
  LORA_SWAP_TOPIC,
  LORA_USDT_ADDRESS,
  LORA_WLRB_ADDRESS,
} from "./constants";
import { divideToDecimal, normalizeAddress, normalizeHash } from "./math";
import { shanghaiDayBounds } from "./time";
import type {
  LoraCollectionBatch,
  LoraDailyAddressBaseline,
  LoraIndexedBlock,
  LoraIndexedInternalTransaction,
  LoraIndexedSwap,
  LoraIndexedTransaction,
  LoraPendingInternalTransaction,
  LoraPriceSnapshot,
} from "./types";
import type {
  LoraChainDataSource,
  LoraCollectionContext,
} from "./collector";

type Cursor = Record<string, string | number> | null;

interface ExplorerPage {
  items: unknown[];
  next_page_params: Cursor;
}

interface RpcEnvelope<T> {
  jsonrpc?: string;
  id?: number;
  result?: T;
  error?: { code?: number; message?: string };
}

interface LiveRpcBlock {
  blockHex: string;
  blockNumber: number;
  timestamp: string;
  averageBlockTimeMs: string | null;
}

interface ParsedExplorerPage<T> {
  items: T[];
  next: Cursor;
  oldestTimestamp: string | null;
}

const REQUEST_TIMEOUT_MS = 20_000;
const REQUEST_ATTEMPTS = 2;
const REQUEST_SPACING_MS = 25;
const REQUEST_CONCURRENCY = 4;
// Cloudflare Workers Free allows 50 external subrequests per invocation.
// Keep the whole cycle below that ceiling, including price/RPC validation and
// retry headroom, so a busy history backfill never discards its partial page.
const MAX_REQUEST_ATTEMPTS_PER_TICK = 48;
const MAX_HEAD_PAGES_PER_TICK = 2;
const MAX_TRANSACTION_LIVE_PAGES_PER_TICK = 4;
const MAX_HISTORY_PAGES_PER_TICK = 24;
const MAX_CORE_HISTORY_PAGES_PER_TICK = 4;
const MAX_BURN_DAILY_PAGES_PER_TICK = 1;
const MAX_BURN_LIFETIME_PAGES_PER_TICK = 1;
const MAX_DETAIL_PAGES = 100;
const PAIR_LOG_WINDOW_BLOCKS = 5_000;
const MAX_PAIR_WINDOWS_PER_TICK = 2;
const PAIR_CONFIRMATIONS = 6;
const PAIR_RESERVE_STALE_SECONDS = 10 * 60;
export const MAX_PENDING_INTERNAL_TRANSACTIONS = 5_000;

/** Nominal first-attempt budget used by production-scale regression tests. */
export const LORA_SOURCE_REQUEST_BUDGET_LIMITS = {
  totalAttempts: MAX_REQUEST_ATTEMPTS_PER_TICK,
  priceRequests: 10,
  explorerHeadStreams: 3,
  headPagesPerStream: MAX_HEAD_PAGES_PER_TICK,
  transactionLiveExtraPages:
    MAX_TRANSACTION_LIVE_PAGES_PER_TICK - MAX_HEAD_PAGES_PER_TICK,
  resumePagesPerStream: 1,
  coreHistoryStreams: 2,
  coreHistoryPagesPerStream: MAX_CORE_HISTORY_PAGES_PER_TICK,
  burnDailyPages: MAX_BURN_DAILY_PAGES_PER_TICK,
  burnLifetimePages: MAX_BURN_LIFETIME_PAGES_PER_TICK,
  statsRequests: 1,
  pairBoundaryRequests: 1,
  pairLogWindows: MAX_PAIR_WINDOWS_PER_TICK,
} as const;

class HttpStatusError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryable: boolean,
  ) {
    super(`HTTP ${status}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : typeof value === "string" && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
      ? Number(value)
      : null;
}

function nestedHash(value: unknown): string | null {
  const record = asRecord(value);
  return normalizeAddress(stringValue(record?.hash));
}

function timestampFromItem(value: unknown): string | null {
  const record = asRecord(value);
  const timestamp = stringValue(record?.timestamp);
  return timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : null;
}

function pageOldestTimestamp(items: unknown[]): string | null {
  const timestamps = items
    .map(timestampFromItem)
    .filter((value): value is string => value !== null)
    .sort();
  return timestamps[0] ?? null;
}

function crossedBoundary(
  page: ParsedExplorerPage<unknown>,
  boundary: Date,
): boolean {
  return (
    page.next === null ||
    (page.oldestTimestamp !== null &&
      Date.parse(page.oldestTimestamp) < boundary.getTime())
  );
}

function strictParseItems<T>(
  items: unknown[],
  parse: (value: unknown) => T | null,
  label: string,
): T[] {
  return items.map((item, index) => {
    const parsed = parse(item);
    if (!parsed) throw new Error(`${label} schema mismatch at item ${index}`);
    return parsed;
  });
}

export interface PaginatedHeadResult<T> {
  items: T[];
  newestKey: string | null;
  connected: boolean;
  resumeCursor: Cursor;
  pendingNewestKey: string | null;
  startedAtHead: boolean;
  firstPageNext: Cursor;
  firstPageOldestTimestamp: string | null;
}

/**
 * Reads enough newest-first pages to reconnect to the prior head. The caller
 * must only persist newestKey when connected is true, otherwise the same gap is
 * retried next cycle and no item can fall between checkpoints.
 */
export async function collectPaginatedHead<T>(options: {
  fetchPage: (cursor: Cursor) => Promise<ParsedExplorerPage<unknown>>;
  parse: (value: unknown) => T | null;
  key: (value: T) => string;
  previousKey: string | null;
  resumeCursor?: Cursor;
  pendingNewestKey?: string | null;
  label: string;
  maxPages?: number;
  livePages?: number;
}): Promise<PaginatedHeadResult<T>> {
  const maxPages = options.maxPages ?? MAX_HEAD_PAGES_PER_TICK;
  const livePages = options.livePages ?? maxPages;
  const collected: T[] = [];
  const collectedKeys = new Set<string>();
  const appendUnique = (items: T[]) => {
    for (const item of items) {
      const itemKey = options.key(item);
      if (collectedKeys.has(itemKey)) continue;
      collectedKeys.add(itemKey);
      collected.push(item);
    }
  };
  const isResume = options.resumeCursor !== undefined && options.resumeCursor !== null;
  let cursor: Cursor = options.resumeCursor ?? null;
  let newestKey: string | null =
    isResume ? options.pendingNewestKey ?? options.previousKey : null;
  let firstPageNext: Cursor = null;
  let firstPageOldestTimestamp: string | null = null;
  let connected = false;
  let liveNewestKey: string | null = null;
  let liveCursor: Cursor = null;

  // Always replay a bounded newest-first overlap window. Explorer items can be
  // indexed late behind the last checkpoint, so slicing only the rows before
  // previousKey would permanently miss them. Downstream aggregation is keyed
  // and idempotent, making the overlap safe.
  for (let pageIndex = 0; pageIndex < livePages; pageIndex += 1) {
    const page = await options.fetchPage(liveCursor);
    const parsed = strictParseItems(page.items, options.parse, options.label);
    if (pageIndex === 0) {
      liveNewestKey = parsed[0] ? options.key(parsed[0]) : options.previousKey;
      firstPageNext = page.next;
      firstPageOldestTimestamp = page.oldestTimestamp;
    }
    appendUnique(parsed);
    if (options.previousKey === null) {
      connected = true;
      newestKey = liveNewestKey;
    }
    const priorIndex = parsed.findIndex(
      (item) => options.key(item) === options.previousKey,
    );
    if (priorIndex >= 0) {
      connected = true;
      newestKey = liveNewestKey;
    }
    if (page.next === null) {
      connected = true;
      newestKey = liveNewestKey;
      break;
    }
    liveCursor = page.next;
  }

  if (!connected && !isResume) {
    newestKey = liveNewestKey;
    cursor = liveCursor;
  }

  // If an older continuity repair is still pending, spend one additional page
  // on it after the live overlap. This keeps current data moving without ever
  // advancing the durable checkpoint across an unproven gap.
  if (!connected && isResume) {
    const page = await options.fetchPage(cursor);
    const parsed = strictParseItems(page.items, options.parse, options.label);
    appendUnique(parsed);
    if (options.previousKey === null) {
      connected = true;
      newestKey = liveNewestKey;
    } else {
      const priorIndex = parsed.findIndex(
        (item) => options.key(item) === options.previousKey,
      );
      if (priorIndex >= 0 || page.next === null) {
        connected = true;
      } else {
        cursor = page.next;
      }
    }
  }

  return {
    items: collected,
    newestKey,
    connected,
    resumeCursor: connected ? null : cursor,
    pendingNewestKey: connected ? null : newestKey,
    startedAtHead: true,
    firstPageNext,
    firstPageOldestTimestamp,
  };
}

interface BackfillResult<T> {
  items: T[];
  next: Cursor;
  complete: boolean;
}

async function collectBackfill<T>(options: {
  fetchPage: (cursor: Cursor) => Promise<ParsedExplorerPage<unknown>>;
  parse: (value: unknown) => T | null;
  timestamp: (value: T) => string;
  initialCursor: Cursor;
  seedCursor: Cursor;
  seedOldestTimestamp: string | null;
  seedPageLoaded: boolean;
  alreadyComplete: boolean;
  boundary: Date;
  label: string;
  maxPages?: number;
}): Promise<BackfillResult<T>> {
  if (options.alreadyComplete) {
    return { items: [], next: null, complete: true };
  }
  if (
    options.seedPageLoaded &&
    options.initialCursor === null &&
    (options.seedCursor === null ||
      (options.seedOldestTimestamp !== null &&
        Date.parse(options.seedOldestTimestamp) < options.boundary.getTime()))
  ) {
    return { items: [], next: null, complete: true };
  }

  let cursor = options.initialCursor ?? options.seedCursor;
  let mustFetchHead =
    !options.seedPageLoaded && options.initialCursor === null;
  const collected: T[] = [];
  const maxPages = options.maxPages ?? MAX_HISTORY_PAGES_PER_TICK;
  for (
    let pageIndex = 0;
    (cursor || mustFetchHead) && pageIndex < maxPages;
    pageIndex += 1
  ) {
    const page = await options.fetchPage(cursor);
    mustFetchHead = false;
    const parsed = strictParseItems(page.items, options.parse, options.label);
    collected.push(...parsed);
    const oldest = parsed
      .map((item) => options.timestamp(item))
      .sort()[0] ?? page.oldestTimestamp;
    if (
      page.next === null ||
      (oldest !== null && Date.parse(oldest) < options.boundary.getTime())
    ) {
      return { items: collected, next: null, complete: true };
    }
    cursor = page.next;
  }
  return { items: collected, next: cursor, complete: false };
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (index < items.length) {
        const current = index;
        index += 1;
        results[current] = await operation(items[current]);
      }
    }),
  );
  return results;
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export class RetryingJsonClient {
  private lastRequestAt = 0;
  private activeRequests = 0;
  private readonly waiters: Array<() => void> = [];
  private remainingAttempts = Number.POSITIVE_INFINITY;

  beginCycle(maxAttempts = MAX_REQUEST_ATTEMPTS_PER_TICK): void {
    this.remainingAttempts = maxAttempts;
  }

  remainingAttemptBudget(): number {
    return Math.max(0, this.remainingAttempts);
  }

  async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    await this.acquire();
    try {
      return await this.perform<T>(url, init);
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.activeRequests < REQUEST_CONCURRENCY) {
      this.activeRequests += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.activeRequests += 1;
  }

  private release(): void {
    this.activeRequests -= 1;
    this.waiters.shift()?.();
  }

  private async perform<T>(url: string, init: RequestInit): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt += 1) {
      if (this.remainingAttempts <= 0) {
        throw new Error("LORA_SOURCE_REQUEST_BUDGET_EXHAUSTED");
      }
      this.remainingAttempts -= 1;
      const spacing = REQUEST_SPACING_MS - (Date.now() - this.lastRequestAt);
      if (spacing > 0) await wait(spacing);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        this.lastRequestAt = Date.now();
        const response = await fetch(url, {
          ...init,
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            ...(init.body ? { "Content-Type": "application/json" } : {}),
            ...(init.headers ?? {}),
          },
        });
        if (!response.ok) {
          throw new HttpStatusError(
            response.status,
            response.status === 429 || response.status >= 500,
          );
        }
        return (await response.json()) as T;
      } catch (error) {
        lastError = error;
        const retryable =
          !(error instanceof HttpStatusError) || error.retryable;
        if (retryable && attempt + 1 < REQUEST_ATTEMPTS) {
          await wait(150 * 2 ** attempt);
        } else {
          break;
        }
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("request failed");
  }
}

export function appendExplorerQuery(
  baseUrl: string,
  fixed: Record<string, string>,
  cursor: Cursor,
): string {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(fixed)) {
    url.searchParams.set(key, value);
  }
  if (cursor) {
    for (const [key, value] of Object.entries(cursor)) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export function buildExplorerBlockByTimeUrl(
  explorerApi: string,
  timestampSeconds: number,
): string {
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds < 0) {
    throw new Error("invalid Explorer block timestamp");
  }
  const url = new URL("/api", explorerApi);
  url.searchParams.set("module", "block");
  url.searchParams.set("action", "getblocknobytime");
  url.searchParams.set("timestamp", String(timestampSeconds));
  url.searchParams.set("closest", "after");
  return url.toString();
}

/** Parses Blockscout's legacy getblocknobytime response without coercion. */
export function parseExplorerBlockNumberByTime(payload: unknown): number | null {
  const record = asRecord(payload);
  if (!record || (record.status !== "1" && record.status !== 1)) return null;
  const result = record.result;
  const blockNumber = asRecord(result)
    ? numberValue(asRecord(result)?.blockNumber)
    : numberValue(result);
  return blockNumber !== null && blockNumber >= 0 ? blockNumber : null;
}

function parseCursor(value: unknown): Cursor {
  const record = asRecord(value);
  if (!record) return null;
  const result: Record<string, string | number> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string" || typeof entry === "number") {
      result[key] = entry;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

export function parseExplorerPagePayload(
  payload: unknown,
  label = "Explorer",
): ParsedExplorerPage<unknown> {
  const record = asRecord(payload);
  if (!record || !Array.isArray(record.items)) {
    throw new Error(`${label} page items schema mismatch`);
  }
  const nextValue = record.next_page_params;
  if (
    nextValue !== null &&
    (nextValue === undefined ||
      typeof nextValue !== "object" ||
      Array.isArray(nextValue))
  ) {
    throw new Error(`${label} next_page_params schema mismatch`);
  }
  const nextRecord = asRecord(nextValue);
  if (
    nextRecord &&
    Object.values(nextRecord).some(
      (value) => typeof value !== "string" && typeof value !== "number",
    )
  ) {
    throw new Error(`${label} next_page_params value schema mismatch`);
  }
  return {
    items: record.items,
    next: parseCursor(nextValue),
    oldestTimestamp: pageOldestTimestamp(record.items),
  };
}

export function parseExplorerBlock(value: unknown): LoraIndexedBlock | null {
  const record = asRecord(value);
  const height = numberValue(record?.height);
  const hash = normalizeHash(stringValue(record?.hash));
  const parentHash = normalizeHash(stringValue(record?.parent_hash));
  const timestamp = stringValue(record?.timestamp);
  const gasUsed = stringValue(record?.gas_used);
  if (
    height === null ||
    !hash ||
    !parentHash ||
    !timestamp ||
    !Number.isFinite(Date.parse(timestamp)) ||
    !gasUsed ||
    !/^\d+$/.test(gasUsed)
  ) {
    return null;
  }
  return { height, hash, parentHash, timestamp, gasUsed };
}

export function parseExplorerTransaction(
  value: unknown,
): LoraIndexedTransaction | null {
  const record = asRecord(value);
  if (!record) return null;
  const hash = normalizeHash(stringValue(record?.hash));
  const blockNumber = numberValue(record?.block_number);
  const timestamp = stringValue(record?.timestamp);
  const from = nestedHash(record?.from);
  const to = nestedHash(record?.to);
  const valueWei = stringValue(record?.value);
  const gasUsed = stringValue(record?.gas_used);
  const gasPriceWei = stringValue(record?.gas_price);
  const input = stringValue(record?.raw_input) ?? "0x";
  const toRecord = asRecord(record?.to);
  const status = stringValue(record?.status);
  const result = stringValue(record?.result);
  const validOutcome =
    (status === "ok" && result === "success") ||
    (status === "error" && result !== null && result.length > 0 && result !== "success");
  if (
    !hash ||
    blockNumber === null ||
    !timestamp ||
    !Number.isFinite(Date.parse(timestamp)) ||
    !from ||
    (record.to !== null && record.to !== undefined && !to) ||
    (toRecord !== null && typeof toRecord.is_contract !== "boolean") ||
    !validOutcome ||
    !valueWei ||
    !gasUsed ||
    !gasPriceWei ||
    !/^\d+$/.test(valueWei) ||
    !/^\d+$/.test(gasUsed) ||
    !/^\d+$/.test(gasPriceWei)
  ) {
    return null;
  }
  return {
    hash,
    blockNumber,
    timestamp,
    from,
    to,
    valueWei,
    success: status === "ok" && result === "success",
    gasUsed,
    gasPriceWei,
    input,
    toIsContract: toRecord?.is_contract === true,
  };
}

export function parseExplorerInternalTransaction(
  value: unknown,
): LoraIndexedInternalTransaction | null {
  const record = asRecord(value);
  if (!record) return null;
  const transactionHash = normalizeHash(stringValue(record?.transaction_hash));
  const index = numberValue(record?.index);
  const blockNumber = numberValue(record?.block_number);
  const timestamp = stringValue(record?.timestamp);
  const from = nestedHash(record?.from);
  const to = nestedHash(record?.to);
  const valueWei = stringValue(record?.value);
  const callTypeValue = stringValue(record?.type);
  const callType = callTypeValue?.toUpperCase() ?? null;
  if (
    !transactionHash ||
    index === null ||
    blockNumber === null ||
    !timestamp ||
    !Number.isFinite(Date.parse(timestamp)) ||
    !from ||
    (record.to !== null && record.to !== undefined && !to) ||
    !valueWei ||
    !callType ||
    typeof record.success !== "boolean" ||
    !/^\d+$/.test(valueWei)
  ) {
    return null;
  }
  return {
    transactionHash,
    index: String(index),
    blockNumber,
    timestamp,
    from,
    to,
    valueWei,
    success: record.success === true,
    callType,
  };
}

function parseStoredIndexedTransaction(
  value: unknown,
): LoraIndexedTransaction | null {
  const record = asRecord(value);
  if (!record) return null;
  const hash = normalizeHash(stringValue(record.hash));
  const blockNumber = numberValue(record.blockNumber);
  const timestamp = stringValue(record.timestamp);
  const from = normalizeAddress(stringValue(record.from));
  const toValue = record.to;
  const to = toValue === null ? null : normalizeAddress(stringValue(toValue));
  const valueWei = stringValue(record.valueWei);
  const gasUsed = stringValue(record.gasUsed);
  const gasPriceWei = stringValue(record.gasPriceWei);
  const input = stringValue(record.input);
  if (
    !hash ||
    blockNumber === null ||
    !timestamp ||
    !Number.isFinite(Date.parse(timestamp)) ||
    !from ||
    (toValue !== null && !to) ||
    !valueWei ||
    !/^\d+$/.test(valueWei) ||
    typeof record.success !== "boolean" ||
    !gasUsed ||
    !/^\d+$/.test(gasUsed) ||
    !gasPriceWei ||
    !/^\d+$/.test(gasPriceWei) ||
    input === null ||
    (record.toIsContract !== undefined &&
      typeof record.toIsContract !== "boolean")
  ) {
    return null;
  }
  return {
    hash,
    blockNumber,
    timestamp,
    from,
    to,
    valueWei,
    success: record.success,
    gasUsed,
    gasPriceWei,
    input,
    ...(typeof record.toIsContract === "boolean"
      ? { toIsContract: record.toIsContract }
      : {}),
  };
}

function parseStoredCursor(value: unknown): Cursor {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (
    entries.length === 0 ||
    entries.some(
      ([, item]) => typeof item !== "string" && typeof item !== "number",
    )
  ) {
    return null;
  }
  return Object.fromEntries(entries) as Record<string, string | number>;
}

const LEGACY_PENDING_QUEUED_AT = "1970-01-01T00:00:00.000Z";

function pendingQueuedAt(
  record: Record<string, unknown>,
  fallback: string | null,
): string {
  const queuedAt = stringValue(record.queuedAt);
  if (queuedAt && Number.isFinite(Date.parse(queuedAt))) return queuedAt;
  return fallback && Number.isFinite(Date.parse(fallback))
    ? fallback
    : LEGACY_PENDING_QUEUED_AT;
}

/** Accepts both the current cursor wrapper and the legacy bare transaction JSON. */
export function normalizePendingInternalTransactions(
  value: unknown,
): LoraPendingInternalTransaction[] {
  if (!Array.isArray(value)) return [];
  const normalized = new Map<string, LoraPendingInternalTransaction>();
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const compactHash = stringValue(record.transactionHash);
    if (compactHash && /^0x[0-9a-f]{64}$/i.test(compactHash)) {
      const hash = compactHash.toLowerCase();
      if (normalized.has(hash)) continue;
      normalized.set(hash, {
        transaction: {
          hash,
          blockNumber: 0,
          timestamp: "1970-01-01T00:00:00.000Z",
          from: "0x0000000000000000000000000000000000000000",
          to: null,
          valueWei: "0",
          success: true,
          gasUsed: "0",
          gasPriceWei: "0",
          input: "0x",
        },
        nextPageParams: parseStoredCursor(record.nextPageParams),
        queuedAt: pendingQueuedAt(record, null),
      });
      continue;
    }
    const wrapped = record.transaction !== undefined;
    const transaction = parseStoredIndexedTransaction(
      wrapped ? record.transaction : record,
    );
    if (!transaction || normalized.has(transaction.hash)) continue;
    normalized.set(transaction.hash, {
      transaction,
      nextPageParams: wrapped
        ? parseStoredCursor(record.nextPageParams)
        : null,
      queuedAt: pendingQueuedAt(record, transaction.timestamp),
    });
  }
  return [...normalized.values()];
}

export interface BoundedPendingInternalTransactions {
  queue: LoraPendingInternalTransaction[];
  overflow: boolean;
}

/**
 * Keeps only work queued during the active business day and applies a hard
 * memory/persistence cap. Once overflowed, the day remains partial even after
 * the retained work drains because dropped traces cannot be reconstructed.
 */
export function boundPendingInternalTransactions(
  entries: LoraPendingInternalTransaction[],
  todayStart: Date,
  now: Date,
  previousOverflow = false,
): BoundedPendingInternalTransactions {
  const start = todayStart.getTime();
  const end = now.getTime();
  const unique = new Map<string, LoraPendingInternalTransaction>();
  for (const entry of entries) {
    const queuedAt = Date.parse(entry.queuedAt);
    if (
      !Number.isFinite(queuedAt) ||
      queuedAt < start ||
      queuedAt > end ||
      unique.has(entry.transaction.hash)
    ) {
      continue;
    }
    unique.set(entry.transaction.hash, entry);
  }
  const currentDay = [...unique.values()];
  return {
    queue: currentDay.slice(0, MAX_PENDING_INTERNAL_TRANSACTIONS),
    overflow:
      previousOverflow ||
      currentDay.length > MAX_PENDING_INTERNAL_TRANSACTIONS,
  };
}

export interface InternalDetailRoundResult {
  items: LoraIndexedInternalTransaction[];
  pending: LoraPendingInternalTransaction[];
  attempted: number;
  failed: number;
}

/**
 * Fetches at most one page per transaction, then rotates incomplete/failed
 * work behind untouched entries. This keeps a bad transaction from starving
 * later work and makes every next_page_params checkpoint durable per hash.
 */
export async function collectInternalDetailRound(options: {
  queue: LoraPendingInternalTransaction[];
  maxTransactions: number;
  fetchPage: (
    transaction: LoraIndexedTransaction,
    cursor: Cursor,
  ) => Promise<ParsedExplorerPage<unknown>>;
}): Promise<InternalDetailRoundResult> {
  const capacity = Math.max(
    0,
    Math.min(options.queue.length, Math.floor(options.maxTransactions)),
  );
  const work = options.queue.slice(0, capacity);
  const untouched = options.queue.slice(capacity);
  const results = await mapConcurrent(
    work,
    REQUEST_CONCURRENCY,
    async (entry) => {
      try {
        const page = await options.fetchPage(
          entry.transaction,
          entry.nextPageParams,
        );
        const items = strictParseItems(
          page.items,
          parseExplorerInternalTransaction,
          `internal transaction ${entry.transaction.hash}`,
        );
        return {
          items,
          pending: page.next
            ? [{ ...entry, nextPageParams: page.next }]
            : [],
          failed: false,
        };
      } catch {
        return { items: [], pending: [entry], failed: true };
      }
    },
  );
  return {
    items: results.flatMap((result) => result.items),
    pending: [
      ...untouched,
      ...results.flatMap((result) => result.pending),
    ],
    attempted: work.length,
    failed: results.filter((result) => result.failed).length,
  };
}

function decodedParameter(
  log: Record<string, unknown>,
  name: string,
  wordIndex: number,
): string | null {
  const decoded = asRecord(log.decoded);
  const parameters = Array.isArray(decoded?.parameters)
    ? decoded.parameters
    : [];
  for (const parameterValue of parameters) {
    const parameter = asRecord(parameterValue);
    if (parameter?.name === name) return stringValue(parameter.value);
  }
  const data = stringValue(log.data);
  const decodedWord = data ? decodeAbiUint(data, wordIndex) : null;
  return decodedWord?.toString() ?? null;
}

function indexedTopicAddress(value: unknown): string | null {
  const topic = stringValue(value);
  if (!topic || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return null;
  return normalizeAddress(`0x${topic.slice(-40)}`);
}

function tokenTransferMatches(
  value: unknown,
  token: string,
  pairMustBeFrom: boolean,
  amount: string,
): boolean {
  const record = asRecord(value);
  const tokenRecord = asRecord(record?.token);
  const total = asRecord(record?.total);
  const tokenAddress = normalizeAddress(stringValue(tokenRecord?.address_hash));
  const from = nestedHash(record?.from);
  const to = nestedHash(record?.to);
  return (
    tokenAddress === token &&
    stringValue(total?.value) === amount &&
    (pairMustBeFrom ? from === LORA_PAIR_ADDRESS : to === LORA_PAIR_ADDRESS)
  );
}

export function parseExplorerSwap(
  transaction: LoraIndexedTransaction,
  logValue: unknown,
  tokenTransfers: unknown[],
  currentNativeBalanceWei: string | null,
): LoraIndexedSwap | null {
  if (
    !transaction.success ||
    normalizeAddress(transaction.to) !== LORA_ROUTER_ADDRESS
  ) {
    return null;
  }
  const log = asRecord(logValue);
  if (!log) return null;
  const address = nestedHash(log?.address);
  const topics = Array.isArray(log?.topics) ? log.topics : [];
  const firstTopic = stringValue(topics[0])?.toLowerCase();
  const eventSender = indexedTopicAddress(topics[1]);
  if (
    address !== LORA_PAIR_ADDRESS ||
    eventSender !== LORA_ROUTER_ADDRESS ||
    firstTopic !== LORA_SWAP_TOPIC
  ) {
    return null;
  }
  const amount0In = decodedParameter(log, "amount0In", 0);
  const amount1In = decodedParameter(log, "amount1In", 1);
  const amount0Out = decodedParameter(log, "amount0Out", 2);
  const amount1Out = decodedParameter(log, "amount1Out", 3);
  if (
    !amount0In ||
    !amount1In ||
    !amount0Out ||
    !amount1Out ||
    ![amount0In, amount1In, amount0Out, amount1Out].every((item) => /^\d+$/.test(item))
  ) {
    return null;
  }
  const isBuy = BigInt(amount1Out) > 0n && BigInt(amount0In) > 0n;
  const isSell = BigInt(amount1In) > 0n && BigInt(amount0Out) > 0n;
  if (isBuy === isSell) return null;
  const lrbWei = isBuy ? amount1Out : amount1In;
  const usdtUnits = isBuy ? amount0In : amount0Out;
  const transferProof =
    tokenTransfers.some((transfer) =>
      tokenTransferMatches(
        transfer,
        LORA_USDT_ADDRESS,
        isSell,
        usdtUnits,
      ),
    ) &&
    tokenTransfers.some((transfer) =>
      tokenTransferMatches(
        transfer,
        LORA_WLRB_ADDRESS,
        isBuy,
        lrbWei,
      ),
    );
  if (!transferProof) return null;
  const logIndex = numberValue(log.index);
  if (logIndex === null) return null;
  const priceUsdt = divideToDecimal(BigInt(usdtUnits), BigInt(lrbWei), 8);
  if (!priceUsdt) return null;
  return {
    transactionHash: transaction.hash,
    logIndex,
    blockNumber: transaction.blockNumber,
    timestamp: transaction.timestamp,
    side: isBuy ? "买入" : "卖出",
    lrbWei,
    usdtUnits,
    priceUsdt,
    initiator: transaction.from,
    currentNativeBalanceWei,
  };
}

function decodeAbiAddress(value: string): string | null {
  if (!/^0x[0-9a-fA-F]{64,}$/.test(value)) return null;
  return normalizeAddress(`0x${value.slice(-40)}`);
}

function decodeAbiUint(value: string, wordIndex = 0): bigint | null {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) return null;
  const hex = value.slice(2);
  const start = wordIndex * 64;
  const word = hex.slice(start, start + 64);
  return word.length === 64 ? BigInt(`0x${word}`) : null;
}

function rpcQuantity(value: unknown): number | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)
    ? Number(BigInt(value))
    : null;
}

interface ParsedRpcSwapLog {
  transactionHash: string;
  blockNumber: number;
  logIndex: number;
  lrbWei: bigint;
  explorerLog: Record<string, unknown>;
}

function isStructurallyValidRpcSwapLog(value: unknown): boolean {
  const record = asRecord(value);
  const topics = Array.isArray(record?.topics) ? record.topics : [];
  const data = stringValue(record?.data);
  return Boolean(
    record &&
      record.removed !== true &&
      normalizeAddress(stringValue(record.address)) === LORA_PAIR_ADDRESS &&
      stringValue(topics[0])?.toLowerCase() === LORA_SWAP_TOPIC &&
      indexedTopicAddress(topics[1]) &&
      indexedTopicAddress(topics[2]) &&
      normalizeHash(stringValue(record.transactionHash)) &&
      rpcQuantity(record.blockNumber) !== null &&
      rpcQuantity(record.logIndex) !== null &&
      data &&
      decodeAbiUint(data, 0) !== null &&
      decodeAbiUint(data, 1) !== null &&
      decodeAbiUint(data, 2) !== null &&
      decodeAbiUint(data, 3) !== null,
  );
}

export function parseRpcSwapLog(value: unknown): ParsedRpcSwapLog | null {
  const record = asRecord(value);
  if (!record || record.removed === true) return null;
  const address = normalizeAddress(stringValue(record.address));
  const transactionHash = normalizeHash(stringValue(record.transactionHash));
  const blockNumber = rpcQuantity(record.blockNumber);
  const logIndex = rpcQuantity(record.logIndex);
  const topics = Array.isArray(record.topics) ? record.topics : [];
  const topic0 = stringValue(topics[0])?.toLowerCase();
  const eventSender = indexedTopicAddress(topics[1]);
  const data = stringValue(record.data);
  const amount1In = data ? decodeAbiUint(data, 1) : null;
  const amount1Out = data ? decodeAbiUint(data, 3) : null;
  if (
    address !== LORA_PAIR_ADDRESS ||
    topic0 !== LORA_SWAP_TOPIC ||
    eventSender !== LORA_ROUTER_ADDRESS ||
    !transactionHash ||
    blockNumber === null ||
    logIndex === null ||
    !data ||
    amount1In === null ||
    amount1Out === null ||
    (amount1In > 0n) === (amount1Out > 0n)
  ) {
    return null;
  }
  return {
    transactionHash,
    blockNumber,
    logIndex,
    lrbWei: amount1In > 0n ? amount1In : amount1Out,
    explorerLog: {
      address: { hash: address },
      index: logIndex,
      data,
      topics,
    },
  };
}

export function validatePairConfiguration(values: {
  chainId: string;
  token0: string;
  token1: string;
  token0Decimals: bigint;
  token1Decimals: bigint;
  reserve0: bigint;
  reserve1: bigint;
  blockNumber: number;
  updatedAt: string;
}): LoraPriceSnapshot {
  const valid =
    values.chainId.toLowerCase() === LORA_CHAIN_ID_HEX &&
    normalizeAddress(values.token0) === LORA_USDT_ADDRESS &&
    normalizeAddress(values.token1) === LORA_WLRB_ADDRESS &&
    values.token0Decimals === 18n &&
    values.token1Decimals === 18n;
  if (!valid) {
    return {
      status: "config-error",
      priceUsdt: null,
      reserveUsdt: values.reserve0.toString(),
      reserveWlrb: values.reserve1.toString(),
      blockNumber: values.blockNumber,
      updatedAt: values.updatedAt,
      source: "WLRB/USDT Pair getReserves",
      configError: "PAIR_CONFIGURATION_MISMATCH",
    };
  }
  const priceUsdt =
    values.reserve0 === 0n || values.reserve1 === 0n
      ? null
      : divideToDecimal(
          values.reserve0 * 10n ** values.token1Decimals,
          values.reserve1 * 10n ** values.token0Decimals,
          8,
        );
  return {
    status: priceUsdt ? "ready" : "unavailable",
    priceUsdt,
    reserveUsdt: values.reserve0.toString(),
    reserveWlrb: values.reserve1.toString(),
    blockNumber: values.blockNumber,
    updatedAt: values.updatedAt,
    source: "WLRB/USDT Pair getReserves",
    configError: null,
  };
}

export function isPairReserveFresh(
  reserveTimestampSeconds: bigint,
  blockTimestampSeconds: bigint,
  maxAgeSeconds = BigInt(PAIR_RESERVE_STALE_SECONDS),
): boolean {
  return (
    reserveTimestampSeconds > 0n &&
    blockTimestampSeconds >= reserveTimestampSeconds &&
    blockTimestampSeconds - reserveTimestampSeconds <= maxAgeSeconds
  );
}

export class ExplorerLoraChainDataSource implements LoraChainDataSource {
  private readonly client = new RetryingJsonClient();
  private rpcId = 0;

  constructor(
    private readonly explorerApi: string,
    private readonly rpcUrl: string,
  ) {}

  static fromConfig(config: AppConfig): ExplorerLoraChainDataSource {
    return new ExplorerLoraChainDataSource(
      config.loraExplorerApi,
      config.loraRpcUrl,
    );
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const envelope = await this.client.request<RpcEnvelope<T>>(this.rpcUrl, {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++this.rpcId,
        method,
        params,
      }),
    });
    if (envelope.error || envelope.result === undefined) {
      throw new Error(envelope.error?.message ?? `RPC ${method} failed`);
    }
    return envelope.result;
  }

  private async explorerPage(
    path: string,
    fixed: Record<string, string>,
    cursor: Cursor,
  ): Promise<ParsedExplorerPage<unknown>> {
    const payload = await this.client.request<unknown>(
      appendExplorerQuery(`${this.explorerApi}${path}`, fixed, cursor),
    );
    return parseExplorerPagePayload(payload, path);
  }

  private async explorerObject(
    path: string,
  ): Promise<Record<string, unknown>> {
    const payload = await this.client.request<unknown>(
      `${this.explorerApi}${path}`,
    );
    const record = asRecord(payload);
    if (!record) throw new Error(`${path} schema mismatch`);
    return record;
  }

  private async explorerAllPages(
    path: string,
    fixed: Record<string, string> = {},
  ): Promise<unknown[]> {
    const items: unknown[] = [];
    let cursor: Cursor = null;
    for (let pageIndex = 0; pageIndex < MAX_DETAIL_PAGES; pageIndex += 1) {
      const page = await this.explorerPage(path, fixed, cursor);
      items.push(...page.items);
      if (!page.next) return items;
      cursor = page.next;
    }
    throw new Error(`${path} exceeded detail page budget`);
  }

  private async collectLiveBlock(): Promise<LiveRpcBlock> {
    const blockHex = await this.rpc<string>("eth_blockNumber", []);
    if (!/^0x[0-9a-fA-F]+$/.test(blockHex)) {
      throw new Error("invalid live block number");
    }
    const block = await this.rpc<Record<string, unknown>>(
      "eth_getBlockByNumber",
      [blockHex, false],
    );
    const blockTimestampRaw = stringValue(block.timestamp);
    if (!blockTimestampRaw || !/^0x[0-9a-fA-F]+$/.test(blockTimestampRaw)) {
      throw new Error("invalid live block timestamp");
    }
    const liveBlockAt = new Date(Number(BigInt(blockTimestampRaw)) * 1_000);
    if (Number.isNaN(liveBlockAt.getTime())) {
      throw new Error("invalid live block timestamp");
    }
    const blockNumber = Number(BigInt(blockHex));
    let averageBlockTimeMs: string | null = null;
    const sampleBlockNumber = Math.max(0, blockNumber - 300);
    if (sampleBlockNumber < blockNumber) {
      try {
        const sample = await this.rpc<Record<string, unknown>>(
          "eth_getBlockByNumber",
          [`0x${sampleBlockNumber.toString(16)}`, false],
        );
        const sampleTimestampRaw = stringValue(sample.timestamp);
        if (
          sampleTimestampRaw &&
          /^0x[0-9a-fA-F]+$/.test(sampleTimestampRaw)
        ) {
          const sampleTimestamp = Number(BigInt(sampleTimestampRaw)) * 1_000;
          const elapsed = liveBlockAt.getTime() - sampleTimestamp;
          const heights = blockNumber - sampleBlockNumber;
          if (elapsed > 0 && heights > 0) {
            averageBlockTimeMs = (elapsed / heights).toString();
          }
        }
      } catch {
        // Explorer's rolling average remains available as a fallback.
      }
    }
    return {
      blockHex,
      blockNumber,
      timestamp: liveBlockAt.toISOString(),
      averageBlockTimeMs,
    };
  }

  private async collectPrice(
    liveBlock: LiveRpcBlock,
  ): Promise<LoraPriceSnapshot> {
    const chainId = await this.rpc<string>("eth_chainId", []);
    const token0Raw = await this.rpc<string>("eth_call", [
      { to: LORA_PAIR_ADDRESS, data: "0x0dfe1681" },
      liveBlock.blockHex,
    ]);
    const token1Raw = await this.rpc<string>("eth_call", [
      { to: LORA_PAIR_ADDRESS, data: "0xd21220a7" },
      liveBlock.blockHex,
    ]);
    const token0DecimalsRaw = await this.rpc<string>("eth_call", [
      { to: LORA_USDT_ADDRESS, data: "0x313ce567" },
      liveBlock.blockHex,
    ]);
    const token1DecimalsRaw = await this.rpc<string>("eth_call", [
      { to: LORA_WLRB_ADDRESS, data: "0x313ce567" },
      liveBlock.blockHex,
    ]);
    const reservesRaw = await this.rpc<string>("eth_call", [
      { to: LORA_PAIR_ADDRESS, data: "0x0902f1ac" },
      liveBlock.blockHex,
    ]);
    const token0 = decodeAbiAddress(token0Raw);
    const token1 = decodeAbiAddress(token1Raw);
    const token0Decimals = decodeAbiUint(token0DecimalsRaw);
    const token1Decimals = decodeAbiUint(token1DecimalsRaw);
    const reserve0 = decodeAbiUint(reservesRaw, 0);
    const reserve1 = decodeAbiUint(reservesRaw, 1);
    const reserveTimestamp = decodeAbiUint(reservesRaw, 2);
    if (
      !token0 ||
      !token1 ||
      token0Decimals === null ||
      token1Decimals === null ||
      reserve0 === null ||
      reserve1 === null ||
      reserveTimestamp === null
    ) {
      throw new Error("invalid pair response");
    }
    const validated = {
      ...validatePairConfiguration({
        chainId,
        token0,
        token1,
        token0Decimals,
        token1Decimals,
        reserve0,
        reserve1,
        blockNumber: liveBlock.blockNumber,
        updatedAt: new Date(Number(reserveTimestamp) * 1_000).toISOString(),
      }),
      blockTimestamp: liveBlock.timestamp,
      averageBlockTimeMs: liveBlock.averageBlockTimeMs,
    };
    if (
      validated.status === "ready" &&
      !isPairReserveFresh(
        reserveTimestamp,
        BigInt(Math.floor(Date.parse(liveBlock.timestamp) / 1_000)),
      )
    ) {
      return {
        ...validated,
        status: "stale",
        priceUsdt: null,
      };
    }
    return validated;
  }

  private async collectTransactionInternals(
    queue: LoraPendingInternalTransaction[],
    maxTransactions: number,
  ): Promise<InternalDetailRoundResult> {
    return collectInternalDetailRound({
      queue,
      maxTransactions,
      fetchPage: (transaction, cursor) =>
        this.explorerPage(
          `/transactions/${transaction.hash}/internal-transactions`,
          {},
          cursor,
        ),
    });
  }

  private async blockNumberAtOrAfter(timestampSeconds: number): Promise<number> {
    const payload = await this.client.request<unknown>(
      buildExplorerBlockByTimeUrl(this.explorerApi, timestampSeconds),
    );
    const blockNumber = parseExplorerBlockNumberByTime(payload);
    if (blockNumber === null) {
      throw new Error("Explorer getblocknobytime schema mismatch");
    }
    return blockNumber;
  }

  private async proveSwap(
    candidate: ParsedRpcSwapLog,
  ): Promise<LoraIndexedSwap | null> {
    const [transactionValue, receipt] = await Promise.all([
      this.explorerObject(`/transactions/${candidate.transactionHash}`),
      this.rpc<Record<string, unknown>>("eth_getTransactionReceipt", [
        candidate.transactionHash,
      ]),
    ]);
    const transaction = parseExplorerTransaction(transactionValue);
    if (!transaction) {
      throw new Error(`transaction ${candidate.transactionHash} schema mismatch`);
    }
    const receiptStatus = stringValue(receipt.status);
    if (
      !receiptStatus ||
      !/^0x[0-9a-fA-F]+$/.test(receiptStatus)
    ) {
      throw new Error(`receipt ${candidate.transactionHash} schema mismatch`);
    }
    if (
      BigInt(receiptStatus) !== 1n ||
      !transaction.success ||
      normalizeAddress(transaction.to) !== LORA_ROUTER_ADDRESS
    ) {
      return null;
    }
    const tokenTransfers = await this.explorerAllPages(
      `/transactions/${candidate.transactionHash}/token-transfers`,
    );
    let balance: string | null = null;
    try {
      const balanceHex = await this.rpc<string>("eth_getBalance", [
        transaction.from,
        "latest",
      ]);
      if (/^0x[0-9a-fA-F]+$/.test(balanceHex)) {
        balance = BigInt(balanceHex).toString();
      }
    } catch {
      // The balance is an optional display field; proof remains valid without it.
    }
    const swap = parseExplorerSwap(
      transaction,
      candidate.explorerLog,
      tokenTransfers,
      balance,
    );
    if (!swap) {
      // The Pair log, Router transaction and successful receipt already prove
      // this is a Swap candidate. Missing token legs usually means Blockscout
      // has not indexed the detail yet, so advancing would lose it forever.
      throw new Error(`Swap proof ${candidate.transactionHash} not ready`);
    }
    return swap;
  }

  private async collectPairSwaps(options: {
    checkpoint: number | null;
    boundary: Date;
    latestBlock: number;
  }): Promise<{
    items: LoraIndexedSwap[];
    checkpoint: number | null;
    complete: boolean;
    healthy: boolean;
  }> {
    const confirmedTip = Math.max(0, options.latestBlock - PAIR_CONFIRMATIONS);
    let checkpoint = options.checkpoint;
    try {
      if (checkpoint === null) {
        const firstBlock = await this.blockNumberAtOrAfter(
          Math.floor(options.boundary.getTime() / 1_000),
        );
        checkpoint = Math.max(0, Math.min(firstBlock, confirmedTip + 1) - 1);
      }
      const collected: LoraIndexedSwap[] = [];
      for (
        let windowIndex = 0;
        checkpoint < confirmedTip && windowIndex < MAX_PAIR_WINDOWS_PER_TICK;
        windowIndex += 1
      ) {
        const fromBlock = checkpoint + 1;
        const toBlock = Math.min(
          confirmedTip,
          fromBlock + PAIR_LOG_WINDOW_BLOCKS - 1,
        );
        const rawLogs = await this.rpc<unknown[]>("eth_getLogs", [
          {
            address: LORA_PAIR_ADDRESS,
            fromBlock: `0x${fromBlock.toString(16)}`,
            toBlock: `0x${toBlock.toString(16)}`,
            topics: [LORA_SWAP_TOPIC],
          },
        ]);
        if (!Array.isArray(rawLogs)) {
          throw new Error("RPC logs schema mismatch");
        }
        const parsedLogs = rawLogs.map((log, index) => {
          const parsed = parseRpcSwapLog(log);
          if (!parsed && !isStructurallyValidRpcSwapLog(log)) {
            throw new Error(`RPC Swap log schema mismatch at ${index}`);
          }
          return parsed;
        }).filter((log): log is ParsedRpcSwapLog => log !== null);
        const candidates = parsedLogs.filter(
          (log) => log.lrbWei > LARGE_TRANSFER_THRESHOLD_WEI,
        );
        const latest = parsedLogs.at(-1);
        if (
          latest &&
          !candidates.some(
            (candidate) =>
              candidate.transactionHash === latest.transactionHash &&
              candidate.logIndex === latest.logIndex,
          )
        ) {
          candidates.push(latest);
        }
        const proofs = await mapConcurrent(
          candidates,
          REQUEST_CONCURRENCY,
          (candidate) => this.proveSwap(candidate),
        );
        collected.push(...proofs.filter((swap): swap is LoraIndexedSwap => swap !== null));
        checkpoint = toBlock;
      }
      return {
        items: collected,
        checkpoint,
        complete: checkpoint >= confirmedTip,
        healthy: true,
      };
    } catch {
      return {
        items: [],
        checkpoint: options.checkpoint,
        complete: false,
        healthy: false,
      };
    }
  }

  async collect(context: LoraCollectionContext): Promise<LoraCollectionBatch> {
    this.client.beginCycle();
    const now = context.now;
    const { todayStart, yesterdayStart, reportDate } = shanghaiDayBounds(now);
    const crossedDate = context.state.bootstrapDate !== reportDate;
    let rpcHealthy = false;
    let pairConfigurationVerified = false;
    let liveBlock: LiveRpcBlock | null = null;
    let burnBalanceWei: string | null = null;
    let burnBalanceBlockNumber: number | null = null;
    let burnBalanceUpdatedAt: string | null = null;
    let price: LoraPriceSnapshot = {
      status: "unavailable",
      priceUsdt: null,
      reserveUsdt: null,
      reserveWlrb: null,
      blockNumber: null,
      updatedAt: null,
      source: "WLRB/USDT Pair getReserves",
      configError: null,
    };
    try {
      liveBlock = await this.collectLiveBlock();
      rpcHealthy = true;
      price = {
        ...price,
        blockNumber: liveBlock.blockNumber,
        blockTimestamp: liveBlock.timestamp,
        averageBlockTimeMs: liveBlock.averageBlockTimeMs,
      };
    } catch {
      rpcHealthy = false;
    }
    if (liveBlock) {
      try {
        const balanceHex = await this.rpc<string>("eth_getBalance", [
          LORA_BURN_ADDRESS,
          "latest",
        ]);
        if (!/^0x[0-9a-fA-F]+$/.test(balanceHex)) {
          throw new Error("invalid burn balance");
        }
        burnBalanceWei = BigInt(balanceHex).toString();
        burnBalanceBlockNumber = liveBlock.blockNumber;
        burnBalanceUpdatedAt = liveBlock.timestamp;
      } catch {
        // Event history remains a lower bound when the independent RPC balance
        // is unavailable; never replace a previous exact balance with null.
      }
      try {
        price = await this.collectPrice(liveBlock);
        pairConfigurationVerified = price.status !== "config-error";
      } catch {
        // Chain head remains usable even when Pair calls are unavailable.
        pairConfigurationVerified = false;
      }
    }

    const blocks: LoraIndexedBlock[] = [];
    const transactions: LoraIndexedTransaction[] = [];
    const internalTransactions: LoraIndexedInternalTransaction[] = [];
    let swaps: LoraIndexedSwap[] = [];
    let currentTotalAddresses: string | null = null;
    let addressBaseline: LoraDailyAddressBaseline | undefined;
    let nextBlockCursor = crossedDate ? null : context.state.blockCursor;
    let nextTransactionCursor = crossedDate
      ? null
      : context.state.transactionCursor;
    let nextBurnCursor = crossedDate ? null : context.state.burnCursor;
    let nextBurnHistoryCursor = context.state.burnHistoryCursor;
    let blockTodayComplete = crossedDate
      ? false
      : context.state.blockTodayComplete;
    let transactionTodayComplete = crossedDate
      ? false
      : context.state.transactionTodayComplete;
    let transactionYesterdayComplete = crossedDate
      ? false
      : context.state.transactionYesterdayComplete;
    let burnTodayComplete = crossedDate
      ? false
      : context.state.burnTodayComplete;
    let historyComplete = context.state.historyComplete;
    // A previous day's head key falls outside the small live replay window
    // after midnight. Start a fresh continuity proof for the new report day,
    // while retaining cumulative aggregates and the lifetime repair cursor.
    let checkpointBlock = crossedDate ? null : context.state.checkpointBlock;
    let checkpointHash = crossedDate ? null : context.state.checkpointHash;
    let headTransactionHash = crossedDate
      ? null
      : context.state.headTransactionHash ?? null;
    let headBurnKey = crossedDate ? null : context.state.headBurnKey ?? null;
    let blockHeadCursor = crossedDate
      ? null
      : context.state.blockHeadCursor ?? null;
    let blockHeadCandidateKey = crossedDate
      ? null
      : context.state.blockHeadCandidateKey ?? null;
    let transactionHeadCursor = crossedDate
      ? null
      : context.state.transactionHeadCursor ?? null;
    let transactionHeadCandidateHash =
      crossedDate
        ? null
        : context.state.transactionHeadCandidateHash ?? null;
    let burnHeadCursor = crossedDate
      ? null
      : context.state.burnHeadCursor ?? null;
    let burnHeadCandidateKey = crossedDate
      ? null
      : context.state.burnHeadCandidateKey ?? null;
    let blockHeadConnected = false;
    let transactionHeadConnected = false;
    let burnHeadConnected = false;
    let statsHealthy = false;

    const blockTask = (async () => {
      const previousKey =
        checkpointBlock !== null && checkpointHash
          ? `${checkpointBlock}:${checkpointHash}`
          : null;
      const fetchPage = (cursor: Cursor) =>
        this.explorerPage("/blocks", { type: "block" }, cursor);
      const head = await collectPaginatedHead({
        fetchPage,
        parse: parseExplorerBlock,
        key: (block) => `${block.height}:${block.hash}`,
        previousKey,
        resumeCursor: blockHeadCursor,
        pendingNewestKey: blockHeadCandidateKey,
        label: "block",
      });
      const history = await collectBackfill({
        fetchPage,
        parse: parseExplorerBlock,
        timestamp: (block) => block.timestamp,
        initialCursor: nextBlockCursor,
        seedCursor: head.firstPageNext,
        seedOldestTimestamp: head.firstPageOldestTimestamp,
        seedPageLoaded: head.startedAtHead,
        alreadyComplete: blockTodayComplete,
        boundary: todayStart,
        label: "block backfill",
        maxPages: MAX_CORE_HISTORY_PAGES_PER_TICK,
      });
      return { head, history };
    })();

    const transactionTask = (async () => {
      const fetchPage = (cursor: Cursor) =>
        this.explorerPage(
          "/transactions",
          { filter: "validated" },
          cursor,
        );
      const head = await collectPaginatedHead({
        fetchPage,
        parse: parseExplorerTransaction,
        key: (transaction) => transaction.hash,
        previousKey: headTransactionHash,
        resumeCursor: transactionHeadCursor,
        pendingNewestKey: transactionHeadCandidateHash,
        label: "transaction",
        livePages: MAX_TRANSACTION_LIVE_PAGES_PER_TICK,
      });
      const repairingYesterday = !transactionYesterdayComplete;
      const history = await collectBackfill({
        fetchPage,
        parse: parseExplorerTransaction,
        timestamp: (transaction) => transaction.timestamp,
        initialCursor: nextTransactionCursor,
        seedCursor: head.firstPageNext,
        seedOldestTimestamp: head.firstPageOldestTimestamp,
        seedPageLoaded: head.startedAtHead,
        alreadyComplete: repairingYesterday
          ? transactionYesterdayComplete
          : transactionTodayComplete,
        boundary: repairingYesterday ? yesterdayStart : todayStart,
        label: "transaction backfill",
        maxPages: MAX_CORE_HISTORY_PAGES_PER_TICK,
      });
      return { head, history, repairingYesterday };
    })();

    const burnPath = `/addresses/${LORA_BURN_ADDRESS}/internal-transactions`;
    const burnTask = (async () => {
      const fetchPage = (cursor: Cursor) =>
        this.explorerPage(burnPath, { filter: "to" }, cursor);
      const head = await collectPaginatedHead({
        fetchPage,
        parse: parseExplorerInternalTransaction,
        key: (transaction) =>
          `${transaction.transactionHash}:${transaction.index}`,
        previousKey: headBurnKey,
        resumeCursor: burnHeadCursor,
        pendingNewestKey: burnHeadCandidateKey,
        label: "burn internal transaction",
      });
      const [daily, lifetime] = await Promise.all([
        collectBackfill({
          fetchPage,
          parse: parseExplorerInternalTransaction,
          timestamp: (transaction) => transaction.timestamp,
          initialCursor: nextBurnCursor,
          seedCursor: head.firstPageNext,
          seedOldestTimestamp: head.firstPageOldestTimestamp,
          seedPageLoaded: head.startedAtHead,
          alreadyComplete: burnTodayComplete,
          boundary: todayStart,
          label: "burn daily backfill",
          maxPages: MAX_BURN_DAILY_PAGES_PER_TICK,
        }),
        collectBackfill({
          fetchPage,
          parse: parseExplorerInternalTransaction,
          timestamp: (transaction) => transaction.timestamp,
          initialCursor: nextBurnHistoryCursor,
          seedCursor: head.firstPageNext,
          seedOldestTimestamp: head.firstPageOldestTimestamp,
          seedPageLoaded: head.startedAtHead,
          alreadyComplete: historyComplete,
          boundary: new Date(0),
          label: "burn lifetime backfill",
          maxPages: MAX_BURN_LIFETIME_PAGES_PER_TICK,
        }),
      ]);
      return { head, daily, lifetime };
    })();

    const statsTask = this.explorerObject("/stats");
    const [blockResult, transactionResult, burnResult, statsResult] =
      await Promise.allSettled([
        blockTask,
        transactionTask,
        burnTask,
        statsTask,
      ]);

    if (blockResult.status === "fulfilled") {
      const { head, history } = blockResult.value;
      blocks.push(...head.items, ...history.items);
      blockHeadConnected = head.connected;
      blockHeadCursor = head.resumeCursor;
      blockHeadCandidateKey = head.pendingNewestKey;
      blockTodayComplete = history.complete;
      nextBlockCursor = history.next;
      if (head.connected && head.newestKey) {
        const separator = head.newestKey.indexOf(":");
        const height = Number(head.newestKey.slice(0, separator));
        const hash = normalizeHash(head.newestKey.slice(separator + 1));
        if (separator > 0 && Number.isSafeInteger(height) && hash) {
          checkpointBlock = height;
          checkpointHash = hash;
        }
      }
    }

    if (transactionResult.status === "fulfilled") {
      const { head, history, repairingYesterday } = transactionResult.value;
      transactions.push(...head.items, ...history.items);
      transactionHeadConnected = head.connected;
      transactionHeadCursor = head.resumeCursor;
      transactionHeadCandidateHash = head.pendingNewestKey;
      nextTransactionCursor = history.next;
      if (repairingYesterday) {
        transactionYesterdayComplete = history.complete;
        transactionTodayComplete =
          transactionTodayComplete ||
          history.complete ||
          (head.firstPageOldestTimestamp !== null &&
            Date.parse(head.firstPageOldestTimestamp) < todayStart.getTime()) ||
          history.items.some(
            (transaction) =>
              Date.parse(transaction.timestamp) < todayStart.getTime(),
          );
      } else {
        transactionTodayComplete = history.complete;
      }
      if (head.connected && head.newestKey) {
        headTransactionHash = head.newestKey;
      }
    }

    if (burnResult.status === "fulfilled") {
      const { head, daily, lifetime } = burnResult.value;
      internalTransactions.push(
        ...head.items,
        ...daily.items,
        ...lifetime.items,
      );
      burnHeadConnected = head.connected;
      burnHeadCursor = head.resumeCursor;
      burnHeadCandidateKey = head.pendingNewestKey;
      burnTodayComplete = daily.complete;
      historyComplete = lifetime.complete;
      nextBurnCursor = daily.next;
      nextBurnHistoryCursor = lifetime.next;
      if (head.connected && head.newestKey) headBurnKey = head.newestKey;
    }

    if (statsResult.status === "fulfilled") {
      const totalAddresses = stringValue(statsResult.value.total_addresses);
      if (totalAddresses && /^\d+$/.test(totalAddresses)) {
        currentTotalAddresses = totalAddresses;
        statsHealthy = true;
      }
      const averageBlockTime = Number(statsResult.value.average_block_time);
      if (
        !price.averageBlockTimeMs &&
        Number.isFinite(averageBlockTime) &&
        averageBlockTime > 0
      ) {
        price = {
          ...price,
          averageBlockTimeMs: String(averageBlockTime),
        };
      }
    }

    let swapCheckpointBlock = crossedDate
      ? null
      : context.state.swapCheckpointBlock ?? null;
    let swapTodayComplete = crossedDate
      ? false
      : context.state.swapTodayComplete ?? false;
    if (price.status === "config-error") {
      // Pair-dependent metrics are explicitly disabled; other daily KPIs can
      // still become complete.
      swapTodayComplete = true;
    } else if (pairConfigurationVerified && price.blockNumber !== null) {
      const pairResult = await this.collectPairSwaps({
        checkpoint: swapCheckpointBlock,
        boundary: yesterdayStart,
        latestBlock: price.blockNumber,
      });
      if (pairResult.healthy) {
        swaps = pairResult.items;
        swapCheckpointBlock = pairResult.checkpoint;
        swapTodayComplete = pairResult.complete;
        rpcHealthy = true;
      } else {
        // Keep the previous checkpoint. Price validation already proved that
        // RPC is reachable; Swap readiness is tracked independently.
        swapTodayComplete = false;
      }
    } else {
      swapTodayComplete = false;
    }

    // Pair scanning is bounded and business-critical, so it runs before the
    // generic per-transaction detail queue can consume the remaining budget.
    const retainedStateQueue = boundPendingInternalTransactions(
      crossedDate
        ? []
        : normalizePendingInternalTransactions(
            context.state.pendingInternalTransactions,
          ),
      todayStart,
      now,
      crossedDate ? false : context.state.internalQueueOverflow ?? false,
    );
    const pendingByHash = new Map<string, LoraPendingInternalTransaction>();
    for (const entry of retainedStateQueue.queue) {
      pendingByHash.set(entry.transaction.hash, entry);
    }
    for (const transaction of transactions) {
      if (
        transaction.to === null ||
        transaction.toIsContract === true ||
        transaction.input !== "0x"
      ) {
        const existing = pendingByHash.get(transaction.hash);
        if (
          !existing &&
          context.knownTransactionHashes?.has(transaction.hash.toLowerCase())
        ) {
          continue;
        }
        pendingByHash.set(transaction.hash, {
          transaction,
          nextPageParams: existing?.nextPageParams ?? null,
          queuedAt: existing?.queuedAt ?? transaction.timestamp,
        });
      }
    }
    const boundedDetails = boundPendingInternalTransactions(
      [...pendingByHash.values()],
      todayStart,
      now,
      retainedStateQueue.overflow,
    );
    const detailCapacity = Math.max(
      0,
      Math.floor(this.client.remainingAttemptBudget() / REQUEST_ATTEMPTS),
    );
    const detailResult = await this.collectTransactionInternals(
      boundedDetails.queue,
      detailCapacity,
    );
    internalTransactions.push(...detailResult.items);
    const pendingInternalTransactions = detailResult.pending;
    const internalQueueOverflow = boundedDetails.overflow;
    const internalDetailsComplete =
      pendingInternalTransactions.length === 0 && !internalQueueOverflow;

    const localParts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: LORA_BUSINESS_TIME_ZONE,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(now)
        .map((part) => [part.type, part.value]),
    );
    if (
      currentTotalAddresses !== null &&
      Number(localParts.hour) === 0 &&
      Number(localParts.minute) <= 2
    ) {
      addressBaseline = {
        reportDate,
        totalAddresses: currentTotalAddresses,
        capturedAt: now.toISOString(),
        blockNumber: checkpointBlock,
        estimated: true,
        source: "midnight-window",
      };
    }

    const explorerHealthy =
      blockResult.status === "fulfilled" &&
      transactionResult.status === "fulfilled" &&
      burnResult.status === "fulfilled" &&
      statsHealthy;
    const todayComplete =
      blockHeadConnected &&
      transactionHeadConnected &&
      burnHeadConnected &&
      blockTodayComplete &&
      transactionTodayComplete &&
      burnTodayComplete &&
      internalDetailsComplete &&
      swapTodayComplete;
    return {
      blocks,
      transactions,
      internalTransactions,
      swaps,
      currentTotalAddresses,
      addressBaseline,
      price,
      burnBalanceWei,
      burnBalanceBlockNumber,
      burnBalanceUpdatedAt,
      nextTransactionCursor,
      nextBurnCursor,
      nextBurnHistoryCursor,
      nextBlockCursor,
      checkpointBlock,
      checkpointHash,
      headTransactionHash,
      headBurnKey,
      blockHeadCursor,
      blockHeadCandidateKey,
      transactionHeadCursor,
      transactionHeadCandidateHash,
      burnHeadCursor,
      burnHeadCandidateKey,
      blockHeadConnected,
      transactionHeadConnected,
      burnHeadConnected,
      swapCheckpointBlock,
      pendingInternalTransactions,
      internalQueueOverflow,
      internalDetailsComplete,
      swapTodayComplete,
      transactionTodayComplete,
      transactionYesterdayComplete,
      burnTodayComplete,
      blockTodayComplete,
      todayComplete,
      yesterdayComplete: transactionYesterdayComplete,
      historyComplete,
      rpcHealthy,
      explorerHealthy,
      collectedAt: now.toISOString(),
    };
  }
}
