const INTEGER_PATTERN = /^\d+$/;

export function parseUnsignedInteger(value: string): bigint {
  if (!INTEGER_PATTERN.test(value)) {
    throw new Error("invalid unsigned integer");
  }
  return BigInt(value);
}

export function formatUnits(
  value: bigint | string,
  decimals = 18,
  maximumFractionDigits = 6,
): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error("invalid decimals");
  }
  if (
    !Number.isInteger(maximumFractionDigits) ||
    maximumFractionDigits < 0 ||
    maximumFractionDigits > decimals
  ) {
    throw new Error("invalid fraction digits");
  }
  const integer = typeof value === "bigint" ? value : parseUnsignedInteger(value);
  const negative = integer < 0n;
  const absolute = negative ? -integer : integer;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  if (maximumFractionDigits === 0) {
    return `${negative ? "-" : ""}${whole.toString()}`;
  }
  const remainder = absolute % scale;
  const padded = remainder.toString().padStart(decimals, "0");
  const fraction = padded.slice(0, maximumFractionDigits).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${
    fraction ? `.${fraction}` : ""
  }`;
}

export function divideToDecimal(
  numerator: bigint,
  denominator: bigint,
  fractionDigits = 8,
): string | null {
  if (denominator === 0n) return null;
  if (!Number.isInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > 30) {
    throw new Error("invalid fraction digits");
  }
  const negative = (numerator < 0n) !== (denominator < 0n);
  const left = numerator < 0n ? -numerator : numerator;
  const right = denominator < 0n ? -denominator : denominator;
  const scale = 10n ** BigInt(fractionDigits);
  const scaled = (left * scale) / right;
  const text = formatUnits(scaled, fractionDigits, fractionDigits);
  return negative && text !== "0" ? `-${text}` : text;
}

export function ratioPercent(
  numerator: bigint,
  denominator: bigint,
  fractionDigits = 2,
): string | null {
  return divideToDecimal(numerator * 100n, denominator, fractionDigits);
}

export function sumUnsigned(values: Iterable<string>): bigint {
  let total = 0n;
  for (const value of values) total += parseUnsignedInteger(value);
  return total;
}

export function maxUnsigned(values: Iterable<string>): bigint {
  let maximum = 0n;
  for (const value of values) {
    const parsed = parseUnsignedInteger(value);
    if (parsed > maximum) maximum = parsed;
  }
  return maximum;
}

export function normalizeAddress(value: string | null | undefined): string | null {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  return value.toLowerCase();
}

export function normalizeHash(value: string | null | undefined): string | null {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) return null;
  return value.toLowerCase();
}

