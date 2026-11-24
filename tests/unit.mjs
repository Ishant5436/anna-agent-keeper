// Unit tests for the pure logic in bundle/lib. Run: node tests/unit.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeTokenPrefix, compactSize } from "../bundle/lib/cashtokens.js";
import {
  STATUS, DAY_MS, NETWORKS, TRANSFER_TOPIC,
  parseUsdc, formatUsdc, defaultConfig, validateConfig, evaluateRequest, decidePendingApproval,
  committedMicro, paymentFor, matchTransferInReceipt, assessOutflow, normalizeVaultDoc, belongsTo,
} from "../bundle/lib/vault.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL  ${name}\n      → ${e.message}`);
  }
}

// ---------- CashTokens (CHIP-2022-02) ----------
const vectorsPath = (f) => fileURLToPath(new URL(`./vectors/${f}`, import.meta.url));
const valid = JSON.parse(readFileSync(vectorsPath("token-prefix-valid.json"), "utf8"));

test(`CashTokens: all ${valid.length} official valid vectors encode exactly`, () => {
  for (const v of valid) {
    const { category, amount, nft } = v.data;
    const got = encodeTokenPrefix({ category, amount: BigInt(amount), nft: nft ? { capability: nft.capability, commitment: nft.commitment } : null });
    assert.equal(got, v.prefix, `vector ${JSON.stringify(v.data).slice(0, 120)}`);
  }
});
test("CashTokens: CompactSize boundaries", () => {
  assert.deepEqual(compactSize(252), [0xfc]);
  assert.deepEqual(compactSize(253), [0xfd, 0xfd, 0x00]);
  assert.deepEqual(compactSize(65536), [0xfe, 0x00, 0x00, 0x01, 0x00]);
});
test("CashTokens: rejects a prefix with no tokens", () => {
  assert.throws(() => encodeTokenPrefix({ category: "bb".repeat(32), amount: 0n }), /must carry/);
});
test("CashTokens: rejects bad category and out-of-range amount", () => {
  assert.throws(() => encodeTokenPrefix({ category: "xyz", amount: 1n }), /Category/);
  assert.throws(() => encodeTokenPrefix({ category: "bb".repeat(32), amount: 9223372036854775808n }), /Fungible amount/);
});

// ---------- USDC amounts ----------
test("parseUsdc: exact micro-units, rejects >6 decimals and junk", () => {
  assert.equal(parseUsdc("12.5"), 12_500_000);
  assert.equal(parseUsdc("0.000001"), 1);
  assert.equal(parseUsdc("1.0000001"), null);
  assert.equal(parseUsdc("-1"), null);
  assert.equal(parseUsdc("abc"), null);
  assert.equal(formatUsdc(12_500_000), "12.50");
});

// ---------- Policy ----------
const VAULT = "0x1111111111111111111111111111111111111111";
const OK_TO = "0x2222222222222222222222222222222222222222";
const cfg = { ...defaultConfig(), vaultAddress: VAULT, whitelist: [OK_TO] };
const NOW = 1_800_000_000_000;
// Requests carry the vault and network they were made for.
const mine = (r) => ({ network: cfg.network, vault: VAULT, recipient: OK_TO, ...r });

test("config: defaults need a vault and a whitelist; then valid; bad settings are reported", () => {
  assert.ok(validateConfig({ ...defaultConfig(), vaultAddress: VAULT }).some((e) => /Whitelist needs/.test(e)));
  assert.deepEqual(validateConfig(cfg), []);
  assert.match(validateConfig({ ...cfg, vaultAddress: "" })[0], /Vault address/);
  assert.ok(validateConfig({ ...cfg, txCapMicro: cfg.dailyCapMicro + 1 }).some((e) => /larger than the rolling/.test(e)));
  assert.ok(validateConfig({ ...cfg, approvalThresholdMicro: cfg.txCapMicro + 1 }).some((e) => /threshold/.test(e)));
});
test("guard: small whitelisted payment is approved automatically", () => {
  assert.equal(evaluateRequest(cfg, [], { recipient: OK_TO, amountMicro: 10e6 }, NOW).decision, STATUS.APPROVED);
});
test("guard: above approval threshold waits for a human", () => {
  assert.equal(evaluateRequest(cfg, [], { recipient: OK_TO, amountMicro: 30e6 }, NOW).decision, STATUS.PENDING);
});
test("guard: never pays the USDC contract or the vault itself, even if whitelisted", () => {
  const usdcAddr = NETWORKS[cfg.network].usdc;
  assert.match(validateConfig({ ...cfg, whitelist: [usdcAddr] })[0], /USDC token contract/);
  assert.match(validateConfig({ ...cfg, whitelist: [VAULT] })[0], /vault itself/);
  const loose = { ...cfg, whitelist: [usdcAddr.toLowerCase()] }; // e.g. a stale saved config
  assert.match(evaluateRequest(loose, [], { recipient: usdcAddr, amountMicro: 1e6 }, NOW).reason, /USDC token contract/);
});
test("guard: blocks non-whitelisted recipient, over-cap amount, and an unset vault", () => {
  assert.match(evaluateRequest(cfg, [], { recipient: "0x3333333333333333333333333333333333333333", amountMicro: 1e6 }, NOW).reason, /whitelist/);
  assert.match(evaluateRequest(cfg, [], { recipient: OK_TO, amountMicro: 51e6 }, NOW).reason, /per-transaction cap/);
  assert.match(evaluateRequest(defaultConfig(), [], { recipient: OK_TO, amountMicro: 1e6 }, NOW).reason, /not set up/);
});
test("guard: rolling 24h cap counts pending + approved + sent + verified, not blocked/denied/old", () => {
  const reqs = [
    mine({ id: "a", status: STATUS.VERIFIED, amountMicro: 50e6, createdAt: NOW - 1000, decidedAt: NOW - 1000 }),
    mine({ id: "b", status: STATUS.PENDING, amountMicro: 40e6, createdAt: NOW - 1000 }),
    mine({ id: "c", status: STATUS.APPROVED, amountMicro: 50e6, createdAt: NOW - 1000, decidedAt: NOW - 1000 }),
    mine({ id: "d", status: STATUS.SENT, amountMicro: 50e6, createdAt: NOW - 1000, decidedAt: NOW - 1000 }),
    mine({ id: "e", status: STATUS.BLOCKED, amountMicro: 50e6, createdAt: NOW, decidedAt: NOW }),
    mine({ id: "f", status: STATUS.DENIED, amountMicro: 50e6, createdAt: NOW, decidedAt: NOW }),
    mine({ id: "g", status: STATUS.VERIFIED, amountMicro: 50e6, createdAt: NOW - DAY_MS - 1, decidedAt: NOW - DAY_MS - 1 }),
    mine({ id: "h", status: STATUS.VERIFIED, amountMicro: 50e6, createdAt: NOW, decidedAt: NOW, network: "base" }), // other network
    mine({ id: "i", status: STATUS.APPROVED, amountMicro: 50e6, createdAt: NOW, decidedAt: NOW, vault: OK_TO }), // other vault
  ];
  assert.equal(committedMicro(reqs, cfg, NOW), 190e6);
  const tight = { ...cfg, dailyCapMicro: 230e6 };
  const r = evaluateRequest(tight, reqs, { recipient: OK_TO, amountMicro: 50e6 }, NOW);
  assert.equal(r.decision, STATUS.BLOCKED);
  assert.match(r.reason, /190\.00 of 230\.00 USDC already committed, 40\.00 left/);
  assert.equal(evaluateRequest(cfg, reqs, { recipient: OK_TO, amountMicro: 20e6 }, NOW).decision, STATUS.APPROVED);
});
test("guard: approving a pending request re-checks the cap without double-counting itself", () => {
  const pending = mine({ id: "p", status: STATUS.PENDING, amountMicro: 40e6, createdAt: NOW });
  const others = [mine({ id: "v", status: STATUS.VERIFIED, amountMicro: 200e6, createdAt: NOW, decidedAt: NOW })];
  assert.equal(decidePendingApproval(cfg, [...others, pending], pending, NOW).decision, STATUS.APPROVED);
  const tighter = { ...cfg, dailyCapMicro: 220e6 };
  assert.equal(decidePendingApproval(tighter, [...others, pending], pending, NOW).decision, STATUS.BLOCKED);
});

// ---------- Payment + verification ----------
test("payment: ERC-20 transfer calldata and EIP-681 link are exact", () => {
  const p = paymentFor({ network: "base", vault: VAULT, recipient: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", amountMicro: 100_000_000 });
  assert.equal(p.from, VAULT);
  // Same calldata as a hand-checked transfer(0x8335…2913, 100 USDC).
  assert.equal(p.data, "0xa9059cbb000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda029130000000000000000000000000000000000000000000000000000000005f5e100");
  assert.equal(p.to, NETWORKS.base.usdc);
  assert.equal(p.chainId, 8453);
  assert.equal(p.eip681, `ethereum:${NETWORKS.base.usdc}@8453/transfer?address=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913&uint256=100000000`);
});

const topic = (addr) => `0x${addr.slice(2).toLowerCase().padStart(64, "0")}`;
const usdc = NETWORKS["base-sepolia"].usdc;
const receipt = (over = {}) => ({
  status: "0x1",
  blockNumber: "0x10",
  logs: [{ address: usdc, topics: [TRANSFER_TOPIC, topic(VAULT), topic(OK_TO)], data: "0x" + (12_500_000).toString(16).padStart(64, "0") }],
  ...over,
});
const expected = { usdc, from: VAULT, to: OK_TO, amountMicro: 12_500_000 };

test("verify: exact transfer from the vault is confirmed", () => {
  const r = matchTransferInReceipt(receipt(), expected);
  assert.equal(r.ok, true);
  assert.equal(r.blockNumber, 16);
});
test("verify: missing, reverted, wrong sender/recipient/amount/token are all refused", () => {
  assert.equal(matchTransferInReceipt(null, expected).pending, true);
  assert.match(matchTransferInReceipt(receipt({ status: "0x0" }), expected).reason, /failed/);
  assert.match(matchTransferInReceipt(receipt(), { ...expected, from: OK_TO }).reason, /from your vault/);
  assert.match(matchTransferInReceipt(receipt(), { ...expected, to: VAULT }).reason, /different recipient/);
  assert.match(matchTransferInReceipt(receipt(), { ...expected, amountMicro: 1 }).reason, /Amount does not match/);
  const otherToken = receipt({ logs: [{ ...receipt().logs[0], address: NETWORKS.base.usdc }] });
  assert.match(matchTransferInReceipt(otherToken, expected).reason, /from your vault/);
});

// ---------- Monitoring ----------
test("monitor: flags outflow beyond verified payments in the window", () => {
  const reqs = [
    mine({ id: "v1", status: STATUS.VERIFIED, amountMicro: 10e6, blockNumber: 150 }),
    mine({ id: "v0", status: STATUS.VERIFIED, amountMicro: 99e6, blockNumber: 50 }), // before the window
    mine({ id: "vx", status: STATUS.VERIFIED, amountMicro: 30e6, blockNumber: 999, network: "base" }), // other chain
  ];
  const a = assessOutflow({ balanceNowMicro: 70e6, balanceThenMicro: 100e6, thenBlock: 100, requests: reqs, cfg });
  assert.equal(a.netOutMicro, 30e6);
  assert.equal(a.verifiedOutMicro, 10e6);
  assert.equal(a.unexplainedMicro, 20e6);
  assert.equal(a.alert, true);
  const clean = assessOutflow({ balanceNowMicro: 90e6, balanceThenMicro: 100e6, thenBlock: 100, requests: reqs, cfg });
  assert.equal(clean.alert, false);
});

test("vault scoping: requests belong to one network and vault address", () => {
  assert.equal(belongsTo(mine({}), cfg), true);
  assert.equal(belongsTo(mine({ vault: VAULT.toUpperCase().replace("0X", "0x") }), cfg), true);
  assert.equal(belongsTo(mine({ network: "base" }), cfg), false);
  assert.equal(belongsTo(mine({ vault: OK_TO }), cfg), false);
});

// ---------- Storage ----------
test("storage: v1.0.1 treasury policy migrates into the vault config", () => {
  const doc = normalizeVaultDoc({ agent: "fleet-x", txCapUsdc: 10, dailyCapUsdc: 20, whitelist: [OK_TO] });
  assert.equal(doc.config.agent, "fleet-x");
  assert.equal(doc.config.txCapMicro, 10e6);
  assert.equal(doc.config.dailyCapMicro, 20e6);
  assert.equal(doc.config.approvalThresholdMicro, 10e6);
  assert.deepEqual(doc.requests, []);
});

console.log(`\n${passed}/${passed + failures.length} unit tests passed.`);
process.exit(failures.length ? 1 : 0);
