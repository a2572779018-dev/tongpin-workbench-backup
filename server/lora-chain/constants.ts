export const LORA_CHAIN_ID = 6359;
export const LORA_CHAIN_ID_HEX = "0x18d7";
export const LORA_NATIVE_SYMBOL = "LRB";
export const LORA_NATIVE_DECIMALS = 18;
export const LORA_BUSINESS_TIME_ZONE = "Asia/Shanghai";

export const LORA_EXPLORER_ORIGIN = "https://explorer.lorachain.org";
export const LORA_EXPLORER_API = `${LORA_EXPLORER_ORIGIN}/api/v2`;
export const LORA_DEFAULT_RPC_URL = `${LORA_EXPLORER_ORIGIN}/api/eth-rpc`;

export const LORA_BURN_ADDRESS =
  "0x000000000000000000000000000000000000dead";
export const LORA_ROUTER_ADDRESS =
  "0xd75d86a9d71f300ba2e5b99fd87189ba628ff1c8";
export const LORA_WLRB_ADDRESS =
  "0xe901e30661dd4fd238c4bfe44b000058561a7b0e";
export const LORA_USDT_ADDRESS =
  "0xa8a5a9037e5375a5b994fb635f470971ce05068e";
export const LORA_PAIR_ADDRESS =
  "0x55b4ea7bc8d22b156381b01ca9c58dbfb6345454";

export const LORA_SWAP_TOPIC =
  "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
export const LORA_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export const ONE_LRB_WEI = 10n ** 18n;
export const NODE_BURN_WEI = 1_000n * ONE_LRB_WEI;
export const LARGE_TRANSFER_THRESHOLD_WEI = 100n * ONE_LRB_WEI;

export const LORA_COLLECT_INTERVAL_MS = 60_000;
export const LORA_CACHE_STALE_AFTER_MS = 3 * LORA_COLLECT_INTERVAL_MS;

