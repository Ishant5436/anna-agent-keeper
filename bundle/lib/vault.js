/**
 * Agent Vault: spend policy, approval workflow and on-chain checks.
 *
 * Pure functions only (no DOM, no network), so they can be unit-tested.
 * AgentKeeper never holds keys: it decides which payments are allowed,
 * produces the exact USDC transfer for the user to send from their own
 * wallet, then confirms that transfer from its on-chain receipt.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
export const USDC_DECIMALS = 6;
const MICRO = 10 ** USDC_DECIMALS;
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TRANSFER_SELECTOR = "a9059cbb"; // transfer(address,uint256)

// Contract addresses verified on-chain (symbol "USDC", 6 decimals).
export const NETWORKS = Object.freeze({
  "base-sepolia": Object.freeze({
    key: "base-sepolia",
    label: "Base Sepolia (testnet)",
    shortLabel: "Base Sepolia",
    chainId: 84532,
    rpc: "https://sepolia.base.org",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    explorer: "https://sepolia.basescan.org",
  }),
  base: Object.freeze({
    key: "base",
    label: "Base Mainnet",
    shortLabel: "Base",
    chainId: 8453,
    rpc: "https://mainnet.base.org",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    explorer: "https://basescan.org",
  }),
});

// Request lifecycle.
export const STATUS = Object.freeze({
  PENDING: "pending", // within caps, above the approval threshold: waits for a human
  APPROVED: "approved", // allowed; waiting for the user to send it
  SENT: "sent", // user reported a tx hash; not yet confirmed on-chain
  VERIFIED: "verified", // receipt confirms the exact transfer from the vault
  BLOCKED: "blocked", // rejected by the policy
  DENIED: "denied", // rejected by a human
  CANCELLED: "cancelled", // approved but withdrawn before sending
});
// Statuses that use up the rolling 24h allowance.
const COMMITTED = new Set([STATUS.PENDING, STATUS.APPROVED, STATUS.SENT, STATUS.VERIFIED]);

export const isAddress = (s) => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
export const isTxHash = (s) => typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s);
const sameAddress = (a, b) => isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();
export const shortAddress = (a) => (isAddress(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a || ""));

/** Parses a USDC amount string ("12.5") into integer micro-units, or returns null. */
export function parseUsdc(input) {
  const s = String(input ?? "").trim();
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) return null;
  const micro = Number(m[1]) * MICRO + Number((m[2] || "").padEnd(6, "0"));
  return Number.isSafeInteger(micro) ? micro : null;
}

/** Formats micro-units as a USDC string with 2 to 6 decimals. */
export function formatUsdc(micro) {
  const n = Number(micro) / MICRO;
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

export function defaultConfig() {
  return {
    network: "base-sepolia",
    vaultAddress: "",
    agent: "quant-executor-fleet-v6",
    txCapMicro: 50 * MICRO,
    dailyCapMicro: 250 * MICRO,
    approvalThresholdMicro: 25 * MICRO,
    whitelist: [
      "0x4200000000000000000000000000000000000006",
      "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    ],
  };
}

/** Returns a list of problems with a vault config (empty when valid). */
export function validateConfig(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== "object") return ["Vault settings are missing."];
  if (!NETWORKS[cfg.network]) errors.push("Choose a network.");
  if (!isAddress(cfg.vaultAddress)) errors.push("Vault address must be a 0x-prefixed 20-byte address.");
  if (!cfg.agent || !String(cfg.agent).trim()) errors.push("Agent ID is required.");
  const ints = ["txCapMicro", "dailyCapMicro", "approvalThresholdMicro"];
  if (ints.some((k) => !Number.isSafeInteger(cfg[k]))) errors.push("Caps must be valid USDC amounts.");
  else {
    if (cfg.txCapMicro <= 0) errors.push("Per-transaction cap must be greater than 0.");
    if (cfg.dailyCapMicro <= 0) errors.push("Rolling 24h cap must be greater than 0.");
    if (cfg.txCapMicro > cfg.dailyCapMicro) errors.push("Per-transaction cap cannot be larger than the rolling 24h cap.");
    if (cfg.approvalThresholdMicro < 0) errors.push("Approval threshold cannot be negative.");
    if (cfg.approvalThresholdMicro > cfg.txCapMicro)
      errors.push("Approval threshold cannot be larger than the per-transaction cap.");
  }
  if (!Array.isArray(cfg.whitelist) || cfg.whitelist.length === 0) errors.push("Whitelist needs at least one address.");
  else {
    const bad = cfg.whitelist.find((a) => !isAddress(a));
    if (bad) errors.push(`Whitelist entry is not a valid address: ${bad}`);
  }
  return errors;
}

/** USDC committed in the rolling 24h window: pending + approved + sent + verified. */
export function committedMicro(requests, now, excludeId = null) {
  return requests
    .filter((r) => r.id !== excludeId && COMMITTED.has(r.status))
    .filter((r) => r.status === STATUS.PENDING || now - (r.decidedAt ?? r.createdAt) < DAY_MS)
    .reduce((sum, r) => sum + r.amountMicro, 0);
}

/**
 * Runs the guard on a new spend request.
 * @returns {{decision: "approved"|"pending"|"blocked", reason: string}}
 */
export function evaluateRequest(cfg, requests, { recipient, amountMicro }, now, excludeId = null) {
  const configErrors = validateConfig(cfg);
  if (configErrors.length) return { decision: STATUS.BLOCKED, reason: `Vault is not set up: ${configErrors[0]}` };
  if (!isAddress(recipient)) return { decision: STATUS.BLOCKED, reason: "Recipient is not a valid address." };
  if (!cfg.whitelist.some((a) => sameAddress(a, recipient)))
    return { decision: STATUS.BLOCKED, reason: "Recipient is not on the vault whitelist." };
  if (!Number.isSafeInteger(amountMicro) || amountMicro < 1)
    return { decision: STATUS.BLOCKED, reason: "Amount must be at least 0.000001 USDC." };
  if (amountMicro > cfg.txCapMicro)
    return {
      decision: STATUS.BLOCKED,
      reason: `${formatUsdc(amountMicro)} USDC is over the per-transaction cap of ${formatUsdc(cfg.txCapMicro)} USDC.`,
    };
  const used = committedMicro(requests, now, excludeId);
  if (used + amountMicro > cfg.dailyCapMicro) {
    const left = Math.max(0, cfg.dailyCapMicro - used);
    return {
      decision: STATUS.BLOCKED,
      reason: `${formatUsdc(amountMicro)} USDC would exceed the rolling 24h cap: ${formatUsdc(used)} of ${formatUsdc(cfg.dailyCapMicro)} USDC already committed, ${formatUsdc(left)} left.`,
    };
  }
  if (amountMicro > cfg.approvalThresholdMicro)
    return {
      decision: STATUS.PENDING,
      reason: `Within all caps, but above your ${formatUsdc(cfg.approvalThresholdMicro)} USDC approval threshold: needs your approval.`,
    };
  return { decision: STATUS.APPROVED, reason: "Within all caps and under the approval threshold: approved automatically." };
}

/** Re-checks a pending request when a human approves it (caps may have changed). */
export function decidePendingApproval(cfg, requests, request, now) {
  const result = evaluateRequest(cfg, requests, request, now, request.id);
  if (result.decision === STATUS.BLOCKED) return result;
  return { decision: STATUS.APPROVED, reason: "Approved by you." };
}

const pad32 = (hexNoPrefix) => hexNoPrefix.toLowerCase().padStart(64, "0");

/** The exact USDC transfer the user sends from their own wallet. */
export function paymentFor(cfg, request) {
  const net = NETWORKS[cfg.network];
  const amount = BigInt(request.amountMicro);
  const data = `0x${TRANSFER_SELECTOR}${pad32(request.recipient.slice(2))}${pad32(amount.toString(16))}`;
  return {
    network: net.label,
    chainId: net.chainId,
    from: cfg.vaultAddress,
    to: net.usdc, // the USDC contract
    value: "0",
    data,
    eip681: `ethereum:${net.usdc}@${net.chainId}/transfer?address=${request.recipient}&uint256=${amount.toString()}`,
  };
}

const topicAddress = (topic) => (typeof topic === "string" && topic.length === 66 ? `0x${topic.slice(26)}` : "");

/**
 * Confirms that a transaction receipt contains the approved USDC transfer.
 * @returns {{ok: boolean, pending?: boolean, reason: string, blockNumber?: number}}
 */
export function matchTransferInReceipt(receipt, { usdc, from, to, amountMicro }) {
  if (!receipt) return { ok: false, pending: true, reason: "Transaction not found yet. It may still be pending; check again shortly." };
  if (receipt.status !== "0x1") return { ok: false, reason: "The transaction failed on-chain (reverted)." };
  const transfers = (receipt.logs || []).filter(
    (l) => sameAddress(l.address, usdc) && Array.isArray(l.topics) && l.topics[0]?.toLowerCase() === TRANSFER_TOPIC
  );
  const fromVault = transfers.filter((l) => sameAddress(topicAddress(l.topics[1]), from));
  if (fromVault.length === 0) return { ok: false, reason: "This transaction does not transfer USDC from your vault." };
  const toRecipient = fromVault.filter((l) => sameAddress(topicAddress(l.topics[2]), to));
  if (toRecipient.length === 0) return { ok: false, reason: "This transaction sends USDC from your vault to a different recipient." };
  const exact = toRecipient.find((l) => BigInt(l.data) === BigInt(amountMicro));
  if (!exact) {
    const sent = toRecipient.map((l) => formatUsdc(Number(BigInt(l.data)))).join(", ");
    return { ok: false, reason: `Amount does not match: sent ${sent} USDC, approved ${formatUsdc(amountMicro)} USDC.` };
  }
  return { ok: true, reason: "Confirmed on-chain: exact amount, from your vault, to the approved recipient.", blockNumber: Number(BigInt(receipt.blockNumber)) };
}

/**
 * Compares the vault's 24h net USDC change with the payments you approved and
 * that were confirmed on-chain in the same window. Incoming funds can hide
 * outgoing ones, so a clean result is a lower bound, not proof.
 */
export function assessOutflow({ balanceNowMicro, balanceThenMicro, thenBlock, requests }) {
  const netOutMicro = balanceThenMicro - balanceNowMicro; // > 0 means the vault lost USDC
  const verifiedOutMicro = requests
    .filter((r) => r.status === STATUS.VERIFIED && Number.isFinite(r.blockNumber) && r.blockNumber > thenBlock)
    .reduce((s, r) => s + r.amountMicro, 0);
  const unexplainedMicro = Math.max(0, netOutMicro - verifiedOutMicro);
  return { netOutMicro, verifiedOutMicro, unexplainedMicro, alert: unexplainedMicro > 0 };
}

export function newRequestId(now = Date.now()) {
  let rand = Math.random().toString(36).slice(2, 8);
  if (globalThis.crypto?.getRandomValues) {
    const b = new Uint8Array(4);
    globalThis.crypto.getRandomValues(b);
    rand = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }
  return `req_${now.toString(36)}_${rand}`;
}

/** Loads a stored vault document, accepting v1.0.1's treasury policy too. */
export function normalizeVaultDoc(raw) {
  const doc = { version: 2, config: defaultConfig(), requests: [] };
  if (!raw || typeof raw !== "object") return doc;
  if (raw.version === 2 && raw.config) {
    doc.config = { ...doc.config, ...raw.config };
    doc.requests = Array.isArray(raw.requests) ? raw.requests.filter((r) => r && typeof r.id === "string") : [];
    return doc;
  }
  // v1.0.1 shape: { agent, txCapUsdc, dailyCapUsdc, whitelist }
  const legacy = raw;
  const toMicro = (v) => parseUsdc(String(v));
  if (typeof legacy.agent === "string" && legacy.agent) doc.config.agent = legacy.agent;
  const tx = toMicro(legacy.txCapUsdc);
  const daily = toMicro(legacy.dailyCapUsdc ?? legacy.dailyCap);
  if (tx) doc.config.txCapMicro = tx;
  if (daily) doc.config.dailyCapMicro = daily;
  doc.config.approvalThresholdMicro = Math.min(doc.config.approvalThresholdMicro, doc.config.txCapMicro);
  if (Array.isArray(legacy.whitelist) && legacy.whitelist.every(isAddress) && legacy.whitelist.length)
    doc.config.whitelist = legacy.whitelist;
  return doc;
}
