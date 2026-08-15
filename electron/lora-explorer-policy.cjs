const LORA_EXPLORER_ORIGIN = "https://explorer.lorachain.org";
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

function buildLoraExplorerUrl(target) {
  if (!target || typeof target !== "object") return null;
  const value = typeof target.value === "string" ? target.value.trim() : "";
  if (target.kind === "address" && ADDRESS_PATTERN.test(value)) {
    return `${LORA_EXPLORER_ORIGIN}/address/${value}`;
  }
  if (target.kind === "tx" && TRANSACTION_HASH_PATTERN.test(value)) {
    return `${LORA_EXPLORER_ORIGIN}/tx/${value}`;
  }
  return null;
}

function validateLoraExplorerUrl(value) {
  if (typeof value !== "string") return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "explorer.lorachain.org" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  const addressMatch = url.pathname.match(/^\/address\/(0x[0-9a-fA-F]{40})$/);
  if (addressMatch) return buildLoraExplorerUrl({ kind: "address", value: addressMatch[1] });
  const transactionMatch = url.pathname.match(/^\/tx\/(0x[0-9a-fA-F]{64})$/);
  if (transactionMatch) return buildLoraExplorerUrl({ kind: "tx", value: transactionMatch[1] });
  return null;
}

module.exports = {
  ADDRESS_PATTERN,
  LORA_EXPLORER_ORIGIN,
  TRANSACTION_HASH_PATTERN,
  buildLoraExplorerUrl,
  validateLoraExplorerUrl,
};

