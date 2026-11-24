#!/usr/bin/env node
/**
 * End-to-end test for the AgentKeeper Studio bundle.
 *
 * Serves bundle/ on localhost and drives every tab and button in Chromium.
 * Base's public RPC endpoints are replaced by an in-test mock chain, so the
 * live vault flow (monitor, request lifecycle, on-chain confirmation) is
 * exercised deterministically; any other outside request fails the run.
 * Runs standalone, on mobile, and against a mock Anna host SDK that mirrors
 * @anna-ai/app-runtime's call shape (chat + storage).
 *
 * Usage: node tests/e2e.cjs [bundleDir] [screenshotDir]
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");

const BUNDLE = path.resolve(process.argv[2] || path.join(__dirname, "..", "bundle"));
const SHOTS = process.argv[3] ? path.resolve(process.argv[3]) : null;
const SDK_PATH = "/static/anna-apps/_sdk/latest/index.js";

// Mirrors @anna-ai/app-runtime: each namespace method passes its args object
// straight through. Enforces the host contract chat.write_message({ text }).
const MOCK_SDK = `
export const AnnaAppRuntime = {
  async connect() {
    await fetch("/__mock/delay"); // lets tests simulate a slow host connect
    const calls = (window.__annaCalls = window.__annaCalls || []);
    const call = async (ns, method, args) => {
      calls.push({ ns, method, args });
      if (ns === "chat" && method === "write_message" && typeof args.text !== "string")
        throw new Error("chat.write_message requires { text }");
      if (ns === "storage" && method === "get") {
        const r = await fetch("/__mock/storage?key=" + encodeURIComponent(args.key));
        return r.json();
      }
      if (ns === "storage" && method === "set") {
        await fetch("/__mock/storage", { method: "PUT", body: JSON.stringify(args) });
        return { ok: true };
      }
      return null;
    };
    const ns = (name) => new Proxy({}, { get: (_, m) => (args) => call(name, m, args || {}) });
    return { chat: ns("chat"), storage: ns("storage"), window: ns("window") };
  },
};`;

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

function startServer(state) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === SDK_PATH) {
      if (state.sdk !== "mock") return res.writeHead(404).end();
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end(MOCK_SDK);
    }
    if (url.pathname === "/__mock/delay") {
      return setTimeout(() => res.writeHead(200).end("{}"), state.delayMs || 0);
    }
    if (url.pathname === "/__mock/storage") {
      if (req.method === "GET") {
        const key = url.searchParams.get("key");
        const exists = Object.prototype.hasOwnProperty.call(state.kv, key);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ value: exists ? state.kv[key] : null, exists }));
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { key, value } = JSON.parse(body);
        state.kv[key] = value;
        res.writeHead(200).end("{}");
      });
      return;
    }
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const file = path.resolve(BUNDLE, rel);
    if (!file.startsWith(BUNDLE) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ---------- Mock Base chain (replaces https://sepolia.base.org and https://mainnet.base.org) ----------
const USDC = { "sepolia.base.org": "0x036cbd53842c5426634e7929541ec2318f3dcf7e", "mainnet.base.org": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" };
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const LATEST = 63_000_000;
const BLOCKS_PER_DAY = 432_000; // 0.2 s blocks
const NOW_SEC = Math.floor(Date.now() / 1000);
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const topic = (addr) => `0x${addr.slice(2).toLowerCase().padStart(64, "0")}`;

function newChain() {
  return { now: {}, then: {}, receipts: {}, calls: [], fail: false };
}

function makeReceipt(host, { from, to, amountMicro, block = LATEST - 10, status = "0x1" }) {
  return {
    status,
    blockNumber: hex(block),
    logs: [{ address: USDC[host], topics: [TRANSFER_TOPIC, topic(from), topic(to)], data: `0x${word(amountMicro)}` }],
  };
}

function rpcAnswer(chains, host, { method, params }) {
  const chain = chains[host];
  chain.calls.push(method);
  const blockOf = (tag) => (tag === "latest" ? LATEST : Number(BigInt(tag)));
  switch (method) {
    case "eth_getBlockByNumber": {
      const n = blockOf(params[0]);
      return { number: hex(n), timestamp: hex(Math.round(NOW_SEC - (LATEST - n) * 0.2)), transactions: [] };
    }
    case "eth_call": {
      const { to, data } = params[0];
      if (to.toLowerCase() !== USDC[host] || !data.startsWith("0x70a08231")) throw new Error("unexpected eth_call");
      const who = `0x${data.slice(-40)}`;
      const old = blockOf(params[1]) <= LATEST - BLOCKS_PER_DAY;
      return `0x${word((old ? chain.then : chain.now)[who] || 0)}`;
    }
    case "eth_getBalance":
      return hex(50_000_000_000_000_000n); // 0.05 ETH
    case "eth_getTransactionReceipt":
      return chain.receipts[params[0].toLowerCase()] || null;
    default:
      throw new Error(`unexpected method ${method}`);
  }
}

async function installNetwork(context, chains, unexpected) {
  await context.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1") return route.continue();
    if (!chains[url.hostname]) {
      unexpected.push(route.request().url());
      return route.abort();
    }
    if (chains[url.hostname].fail) return route.fulfill({ status: 503, body: "unavailable" });
    const req = JSON.parse(route.request().postData() || "{}");
    let body;
    try {
      body = { jsonrpc: "2.0", id: req.id, result: rpcAnswer(chains, url.hostname, req) };
    } catch (e) {
      body = { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: e.message } };
    }
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
  });
}

// ---------- tiny assertion collector ----------
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n      → ${detail}` : ""}`);
}

const text = (page, sel) => page.locator(sel).first().innerText();
const allLines = (page, id) => page.locator(`#${id}`).innerText();
const waitForText = (page, sel, re, timeout = 6000) =>
  page
    .waitForFunction(([s, src]) => { const e = document.querySelector(s); return e && new RegExp(src).test(e.innerText); }, [sel, re.source], { timeout })
    .then(() => true, () => false);

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function noHorizontalScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}

// Dashboard must never claim a settlement the receipt panel has not shown.
async function x402Consistent(page) {
  const metric = await text(page, "#metricX402Value");
  const n = parseInt(metric, 10);
  const consoleText = await allLines(page, "x402Console");
  const settledLines = (consoleText.match(/\[SETTLED\]/g) || []).length;
  return { ok: n === settledLines, detail: `dashboard "${metric}" vs ${settledLines} [SETTLED] receipt lines` };
}

const VAULT = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const SEPOLIA = "sepolia.base.org";

const request = (page, id) => page.locator(`.request-item[data-request-id='${id}']`);
async function newestRequestId(page) {
  return page.locator(".request-item").first().getAttribute("data-request-id");
}
async function submit(page, recipient, amount, memo = "") {
  await page.fill("#reqRecipientInput", recipient);
  await page.fill("#reqAmountInput", amount);
  await page.fill("#reqMemoInput", memo);
  await page.click("#btnSubmitRequest");
  return newestRequestId(page);
}

async function standaloneFlow(browser, base, chains) {
  console.log("\n=== Standalone flow (desktop 1040x780, Anna default window) ===");
  const context = await browser.newContext({ viewport: { width: 1040, height: 780 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  const unexpected = [];
  await installNetwork(context, chains, unexpected);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  let lastClip = "";
  const clipboard = async () => {
    for (let i = 0; i < 50; i++) {
      const t = await page.evaluate(() => navigator.clipboard.readText());
      if (t && t !== lastClip) return (lastClip = t);
      await page.waitForTimeout(100);
    }
    return lastClip;
  };

  await page.goto(base);
  await page.waitForFunction(() => document.getElementById("hostStatusPill").textContent !== "Connecting…");
  await page.waitForFunction(() => !document.getElementById("btnSaveVault").disabled);

  // --- Initial state: live vs simulated is explicit ---
  check("host pill shows Standalone Mode", (await text(page, "#hostStatusPill")) === "Standalone Mode");
  check("version badge is v1.0.2", (await text(page, "#appVersionBadge")) === "v1.0.2");
  check("[Review 3] Agent Vault and Spend Requests tabs are tagged LIVE", (await page.locator(".nav-tab .tag-live").count()) === 2);
  check("[Review 3] BCH, x402 and ERC-4337 tabs are tagged SIMULATED", (await page.locator(".nav-tab .tag-sim").count()) === 3);
  check("[Review 3] every dashboard card says LIVE or SIM", (await page.locator(".metric-card .tag").count()) === 4);
  check("[Review 3] notice says who signs and that no keys are held", /never holds keys or signs/.test(await text(page, "#simNotice")));
  check("vault card starts as Not set up", (await text(page, "#metricVaultValue")) === "Not set up");
  check("Submit and Check are disabled until a vault is saved", (await page.isDisabled("#btnSubmitRequest")) && (await page.isDisabled("#btnCheckVault")));
  check("[Issue 1] dashboard BCH limit is 10.00 BCH", (await text(page, "#metricBchLimit")) === "10.00 BCH");
  check("[Issue 2] dashboard x402 starts at 0 settled", (await text(page, "#metricX402Value")) === "0 settled");
  check("[Issue 1/2] no stray 150.00 BCH or 100% Settled", !/150\.00|100% Settled/.test(await page.content()));
  check("desktop: no horizontal scroll", await noHorizontalScroll(page));

  // --- Vault setup ---
  await page.fill("#vaultAddressInput", "0x123");
  await page.click("#btnSaveVault");
  check("invalid vault address is refused", /Vault address must be/.test(await allLines(page, "vaultConsole")));
  chains[SEPOLIA].then[VAULT] = 100_000_000; // 100 USDC 24h ago
  chains[SEPOLIA].now[VAULT] = 100_000_000; // unchanged
  await page.fill("#vaultAddressInput", VAULT);
  check("[Safety] the whitelist starts empty", (await page.inputValue("#vaultWhitelistInput")) === "");
  await page.click("#btnSaveVault");
  check("[Safety] a vault without whitelisted recipients is refused", /Whitelist needs at least one recipient/.test(await allLines(page, "vaultConsole")));
  await page.fill("#vaultWhitelistInput", "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
  await page.click("#btnSaveVault");
  check("[Safety] whitelisting the USDC contract itself is refused", /Whitelist cannot include the USDC token contract/.test(await allLines(page, "vaultConsole")));
  await page.fill("#vaultWhitelistInput", RECIPIENT);
  await page.click("#btnSaveVault");
  check("vault saves to browser storage", await waitForText(page, "#vaultConsole", /Vault saved to this browser's storage/));
  check("saved badge names the network", (await text(page, "#vaultSetupBadge")) === "SAVED · BASE SEPOLIA");
  check("[Live] saving runs a monitor check", await waitForText(page, "#monUsdc", /100\.00 USDC/));
  check("[Live] monitor reads ETH for gas", (await text(page, "#monEth")) === "0.050000 ETH");
  check("[Live] no alert when the balance is unchanged", (await text(page, "#monitorBadge")) === "NO ALERTS" && (await text(page, "#monUnexplained")) === "None detected");
  check("[Live] dashboard vault card shows the real balance", (await text(page, "#metricVaultValue")) === "100.00 USDC");
  check("Check vault now is enabled again after a check", !(await page.isDisabled("#btnCheckVault")));
  check("[Live] monitor looked up the block 24h back", chains[SEPOLIA].calls.filter((m) => m === "eth_call").length >= 2);
  check("explorer link points at the vault on Sepolia Basescan", (await page.getAttribute("#vaultExplorerLink", "href")) === `https://sepolia.basescan.org/address/${VAULT}`);
  await shot(page, "01-vault");

  // --- Spend requests: auto-approve, pay, confirm on-chain ---
  await page.click(".metric-link[data-tab='tab-requests']");
  check("guard card opens Spend Requests", await page.locator("#tab-requests").isVisible());
  const a = await submit(page, RECIPIENT, "12.50", "Inference API credits");
  check("[Flow] 12.50 USDC to a whitelisted recipient is approved automatically", /APPROVED · SEND IT/.test(await request(page, a).innerText()));
  const data = await request(page, a).locator(".pay-field:has-text('Data') code").innerText();
  check("[Flow] approved request shows the exact USDC transfer calldata", data === `0xa9059cbb${word(RECIPIENT)}${word(12_500_000)}`, data);
  const link = await request(page, a).locator(".pay-field:has-text('EIP-681') code").innerText();
  check("[Flow] approved request shows a wallet link for Base Sepolia", link === `ethereum:0x036CbD53842c5426634e7929541eC2318f3dCF7e@84532/transfer?address=${RECIPIENT}&uint256=12500000`, link);
  check("guard card counts the approved payment", /^12\.50 committed · 0 awaiting approval/.test(await text(page, "#metricGuardSub")));

  await request(page, a).locator("input").fill("0x1234");
  await request(page, a).locator("button:has-text('Confirm on-chain')").click();
  check("[Flow] malformed tx hash is refused", /must be 0x followed by 64 hex/.test(await request(page, a).innerText()));

  const wrongTx = `0x${"aa".repeat(32)}`;
  chains[SEPOLIA].receipts[wrongTx] = makeReceipt(SEPOLIA, { from: VAULT, to: RECIPIENT, amountMicro: 1_000_000 });
  await request(page, a).locator("input").fill(wrongTx);
  await request(page, a).locator("button:has-text('Confirm on-chain')").click();
  check("[Flow] a transaction with the wrong amount is not accepted", await waitForText(page, `.request-item[data-request-id='${a}']`, /Not confirmed: Amount does not match/));
  check("[Flow] after a wrong hash the request is back to awaiting payment", /APPROVED · SEND IT/.test(await request(page, a).innerText()));

  const pendingTx = `0x${"bb".repeat(32)}`;
  await request(page, a).locator("input").fill(pendingTx);
  await request(page, a).locator("button:has-text('Confirm on-chain')").click();
  check("[Flow] an unmined transaction stays 'sent' and can be re-checked", await waitForText(page, `.request-item[data-request-id='${a}']`, /SENT · CONFIRMING[\s\S]*not found yet/));
  chains[SEPOLIA].receipts[pendingTx] = makeReceipt(SEPOLIA, { from: VAULT, to: RECIPIENT, amountMicro: 12_500_000, block: LATEST - 5 });
  await request(page, a).locator("button:has-text('Check again')").click();
  check("[Flow] once mined, the exact transfer is confirmed on-chain", await waitForText(page, `.request-item[data-request-id='${a}']`, /CONFIRMED ON-CHAIN[\s\S]*block 62999995/));
  check("[Flow] confirmed payment links to Basescan", (await request(page, a).locator("a.request-link").getAttribute("href")) === `https://sepolia.basescan.org/tx/${pendingTx}`);

  // --- Human approval path ---
  const b = await submit(page, RECIPIENT, "30", "Batch data purchase");
  check("[Flow] 30 USDC (above the 25 threshold) waits for approval", /AWAITING APPROVAL/.test(await request(page, b).innerText()));
  check("pending count shows on the tab", (await text(page, "#navPendingCount")) === "1");
  await request(page, b).locator("button:has-text('Approve')").click();
  check("[Flow] Approve moves it to approved", await waitForText(page, `.request-item[data-request-id='${b}']`, /APPROVED · SEND IT/));
  const c2 = await submit(page, RECIPIENT, "26");
  await request(page, c2).locator("button:has-text('Deny')").click();
  check("[Flow] Deny rejects it", await waitForText(page, `.request-item[data-request-id='${c2}']`, /DENIED/));

  // --- Guard blocks ---
  const d = await submit(page, "0x9999999999999999999999999999999999999999", "5");
  check("[Guard] non-whitelisted recipient is blocked", /BLOCKED[\s\S]*not on the vault whitelist/.test(await request(page, d).innerText()));
  const e = await submit(page, RECIPIENT, "60");
  check("[Guard] over the per-transaction cap is blocked", /BLOCKED[\s\S]*per-transaction cap/.test(await request(page, e).innerText()));
  const xss = await submit(page, RECIPIENT, "1", `<img src=x onerror="window.__xss=1">`);
  check("[Security] request memo is shown as text, never as HTML", (await request(page, xss).locator("img").count()) === 0 && !(await page.evaluate(() => window.__xss)));
  await page.click(".nav-tab[data-tab='tab-vault']");
  await page.fill("#vaultDailyCapInput", "60");
  await page.click("#btnSaveVault");
  await page.waitForTimeout(200);
  await page.click(".nav-tab[data-tab='tab-requests']");
  const f = await submit(page, RECIPIENT, "20");
  check("[Guard] rolling 24h cap counts approved + confirmed payments", /BLOCKED[\s\S]*43\.50 of 60\.00 USDC already committed, 16\.50 left/.test(await request(page, f).innerText()), await request(page, f).innerText());
  check("dashboard guard card follows the saved cap", (await text(page, "#metricGuardCap")) === "60.00 USDC");
  await shot(page, "02-requests");

  // --- Report to Anna chat (standalone → clipboard) ---
  await page.click("#btnSyncVaultToChat");
  const report = await clipboard();
  check("[Flow] vault report includes policy, live check and requests", /\[AgentKeeper Vault Report\][\s\S]*rolling 24h[\s\S]*Live check \(block 63000000\)[\s\S]*CONFIRMED ON-CHAIN/.test(report), report);

  // --- Live monitor: explained vs unapproved outflow ---
  chains[SEPOLIA].now[VAULT] = 87_500_000; // only the confirmed 12.50 left
  await page.click(".nav-tab[data-tab='tab-vault']");
  await page.click("#btnCheckVault");
  check("[Live] outflow matching confirmed payments raises no alert", await waitForText(page, "#monitorBadge", /NO ALERTS/) && (await text(page, "#monVerifiedOut")) === "12.50 USDC");
  chains[SEPOLIA].now[VAULT] = 57_500_000; // 30 more left without approval
  await page.click("#btnCheckVault");
  check("[Live] unapproved outflow raises an alert", await waitForText(page, "#monitorBadge", /UNAPPROVED OUTFLOW/) && (await text(page, "#monUnexplained")) === "30.00 USDC");
  check("[Live] dashboard vault card shows the alert", /30\.00 USDC unapproved outflow/.test(await text(page, "#metricVaultWhere")));
  await shot(page, "03-alert");
  chains[SEPOLIA].fail = true;
  await page.click("#btnCheckVault");
  check("[Live] an RPC outage is reported, not hidden", await waitForText(page, "#monitorBadge", /RPC ERROR/));
  chains[SEPOLIA].fail = false;

  // --- Persistence ---
  await page.reload();
  await page.waitForFunction(() => !document.getElementById("btnSaveVault").disabled);
  check("[Persist] vault reloads from storage", /Loaded your vault/.test(await allLines(page, "vaultConsole")) && (await page.inputValue("#vaultAddressInput")) === VAULT);
  await page.click(".nav-tab[data-tab='tab-requests']");
  check("[Persist] confirmed payment survives a reload", /CONFIRMED ON-CHAIN/.test(await request(page, a).innerText()));
  check("[Persist] rolling 24h usage survives a reload", /^43\.50 committed/.test(await text(page, "#metricGuardSub")));
  await page.click("#btnClearHistory");
  check("[Flow] Clear finished removes blocked/denied but keeps payments in the 24h window", (await page.locator(".request-item").count()) === 3 && (await request(page, a).count()) === 1);
  await request(page, b).locator("button:has-text('Cancel')").click();
  check("[Flow] an approved payment can be cancelled before sending", await waitForText(page, `.request-item[data-request-id='${b}']`, /CANCELLED/));
  await request(page, xss).locator("button:has-text('Cancel')").click();
  await page.waitForTimeout(200);

  // --- Network switch ---
  await page.click(".nav-tab[data-tab='tab-vault']");
  // On mainnet, 12.50 USDC leaves the vault: the same amount as the payment
  // confirmed on Sepolia, which must not count for this vault.
  chains["mainnet.base.org"].then[VAULT] = 20_000_000;
  chains["mainnet.base.org"].now[VAULT] = 7_500_000;
  await page.selectOption("#vaultNetworkInput", "base");
  await page.click("#btnSaveVault");
  check("[Live] switching to Base mainnet reads mainnet", await waitForText(page, "#monUsdc", /^7\.50 USDC$/) && chains["mainnet.base.org"].calls.length > 0);
  check("[Scoping] a payment confirmed on Sepolia does not hide a mainnet outflow", await waitForText(page, "#monitorBadge", /UNAPPROVED OUTFLOW/) && (await text(page, "#monUnexplained")) === "12.50 USDC" && (await text(page, "#monVerifiedOut")) === "0.00 USDC");
  check("[Scoping] the new vault's 24h cap starts empty", /^0\.00 committed · 0 awaiting approval/.test(await text(page, "#metricGuardSub")));
  await page.click(".nav-tab[data-tab='tab-requests']");
  check("[Scoping] old-vault requests are kept as history, without actions", /not the current vault/.test(await request(page, a).innerText()) && (await request(page, a).locator("button").count()) === 0);
  await page.click(".nav-tab[data-tab='tab-vault']");
  check("explorer link switches to Basescan", (await page.getAttribute("#vaultExplorerLink", "href")) === `https://basescan.org/address/${VAULT}`);

  // --- Simulated tabs ---
  await page.click(".metric-link[data-tab='tab-bch']");
  await page.click("#btnValidateBch");
  const { encodeTokenPrefix } = await import(pathToFileURL(path.join(BUNDLE, "lib", "cashtokens.js")).href);
  const expectedPrefix = encodeTokenPrefix({ category: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", amount: 1000000n, nft: { capability: "none", commitment: "0100f2fe4facfe00" } });
  check("[BCH] real CHIP-2022-02 prefix is shown for the default token", (await text(page, "#bchPrefixOutput")) === expectedPrefix, await text(page, "#bchPrefixOutput"));
  check("BCH 2.5 validates and counts toward the simulated limit", (await text(page, "#bchStatusBadge")) === "COVENANT VERIFIED" && (await text(page, "#metricBchSub")).startsWith("2.50 BCH used"));
  await page.click("#presetBchOverQuota");
  await page.click("#btnValidateBch");
  check("[Issue 1] 25 BCH blocked citing the same 10.00 BCH limit", /daily limit of 10\.00 BCH per agent fleet/.test(await allLines(page, "bchConsole")));
  await page.selectOption("#bchCapabilityInput", "");
  await page.click("#btnValidateBch");
  check("[BCH] a commitment without an NFT is rejected", (await text(page, "#bchStatusBadge")) === "INVALID COMMITMENT");
  await page.click("#presetBchValidFungible");
  await page.click("#btnValidateBch");
  check("[BCH] fungible-only preset encodes an FT-only prefix", /^ef[0-9a-f]{64}10fe40420f00$/.test(await text(page, "#bchPrefixOutput")), await text(page, "#bchPrefixOutput"));

  await page.click(".metric-link[data-tab='tab-x402']");
  check("[Issue 2] x402 receipt badge is IDLE before any claim", (await text(page, "#x402StatusBadge")) === "IDLE");
  await page.click("#btnVerifyX402");
  check("x402 default claim settles", (await text(page, "#metricX402Value")) === "1 settled");
  await page.click("#btnVerifyX402");
  check("x402 replay is blocked", (await text(page, "#x402StatusBadge")) === "REPLAY ATTACK BLOCKED");
  const xc = await x402Consistent(page);
  check("[Issue 2] x402 dashboard and receipt panel agree", xc.ok, xc.detail);
  check("no unbacked 'Signature valid' claim", !/Signature valid/.test(await page.content()));

  await page.click(".nav-tab[data-tab='tab-erc4337']");
  await page.click("#btnSimulateUserOp");
  check("ERC-4337 default simulates OK", (await text(page, "#userOpStatusBadge")) === "SIMULATED SUCCESS");
  await page.fill("#userOpGasInput", "2000000");
  await page.click("#btnSimulateUserOp");
  check("ERC-4337 gas spike rejected", (await text(page, "#userOpStatusBadge")) === "GAS SPIKE DETECTED");

  await page.click("#btnResetSimulation");
  check("Reset clears simulated tabs only", (await text(page, "#metricX402Value")) === "0 settled" && (await text(page, "#metricBchSub")).startsWith("0.00 BCH used"));
  check("Reset leaves the live vault alone", /SAVED · BASE$/.test(await text(page, "#vaultSetupBadge")) && (await page.locator(".request-item").count()) === 3);

  await page.setViewportSize({ width: 780, height: 540 });
  await page.click(".nav-tab[data-tab='tab-requests']");
  check("780x540 (Anna min size): no horizontal scroll", await noHorizontalScroll(page));

  check("no requests left the page except to Base RPC", unexpected.length === 0, unexpected.join(", "));
  check("no JavaScript errors in standalone flow", errors.length === 0, errors.join(" | "));
  await context.close();
}

async function mobileFlow(browser, base, chains) {
  console.log("\n=== Mobile layout (390x844) ===");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const unexpected = [];
  await installNetwork(context, chains, unexpected);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.waitForFunction(() => !document.getElementById("btnSaveVault").disabled);
  await page.fill("#vaultAddressInput", VAULT);
  await page.fill("#vaultWhitelistInput", RECIPIENT);
  await page.click("#btnSaveVault");
  await waitForText(page, "#monitorBadge", /ALERTS|OUTFLOW/);
  await page.click(".nav-tab[data-tab='tab-requests']");
  await submit(page, RECIPIENT, "5");
  for (const tab of ["tab-vault", "tab-requests", "tab-bch", "tab-x402", "tab-erc4337", "tab-telemetry"]) {
    await page.click(`.nav-tab[data-tab='${tab}']`);
    check(`mobile ${tab}: no horizontal scroll`, await noHorizontalScroll(page));
  }
  await page.click(".nav-tab[data-tab='tab-requests']");
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, "04-mobile");
  check("no JavaScript errors on mobile", errors.length === 0, errors.join(" | "));
  await context.close();
}

async function hostFlow(browser, base, state, chains) {
  console.log("\n=== Anna host flow (mock SDK, same call shape as @anna-ai/app-runtime) ===");
  state.sdk = "mock";
  state.kv["agentkeeper:treasury"] = { agent: "fleet-legacy", txCapUsdc: 40, dailyCapUsdc: 120, whitelist: [RECIPIENT] };
  const context = await browser.newContext({ viewport: { width: 1040, height: 780 } });
  const unexpected = [];
  await installNetwork(context, chains, unexpected);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const calls = () => page.evaluate(() => window.__annaCalls || []);

  await page.goto(base);
  await page.waitForFunction(() => document.getElementById("hostStatusPill").textContent === "Connected to Anna OS");
  await page.waitForFunction(() => !document.getElementById("btnSaveVault").disabled);
  check("[Host] v1.0.1 treasury limits are imported", /Imported your v1\.0\.1 treasury limits from Anna storage/.test(await allLines(page, "vaultConsole")));
  check("[Host] imported caps fill the form", (await page.inputValue("#vaultDailyCapInput")) === "120.00" && (await page.inputValue("#vaultAgentInput")) === "fleet-legacy");

  await page.fill("#vaultAddressInput", VAULT);
  await page.click("#btnSaveVault");
  check("[Host] vault saves to Anna storage", await waitForText(page, "#vaultConsole", /Vault saved to Anna storage/));
  const setCall = (await calls()).find((x) => x.ns === "storage" && x.method === "set" && x.args.key === "agentkeeper:vault");
  check("[Host] storage.set({ key, value }) holds the vault document", setCall && setCall.args.value.config.vaultAddress === VAULT && setCall.args.value.config.dailyCapMicro === 120_000_000);

  await page.click(".nav-tab[data-tab='tab-requests']");
  await submit(page, RECIPIENT, "10");
  await page.click("#btnSyncVaultToChat");
  await page.waitForTimeout(300);
  const chatCall = (await calls()).find((x) => x.ns === "chat" && x.method === "write_message");
  check("[Host] report goes to chat.write_message({ text })", chatCall && /\[AgentKeeper Vault Report\]/.test(chatCall.args.text), JSON.stringify(chatCall && chatCall.args).slice(0, 200));

  await page.reload();
  await page.waitForFunction(() => !document.getElementById("btnSaveVault").disabled);
  check("[Host] vault and requests reload from Anna storage", /Loaded your vault from Anna storage/.test(await allLines(page, "vaultConsole")) && (await page.locator(".request-item").count()) === 1);

  // Slow host connect: an edit made before the saved vault loads is kept.
  state.delayMs = 1500;
  await page.reload();
  await page.fill("#vaultTxCapInput", "15");
  await page.waitForFunction(() => /your edits are kept/.test(document.getElementById("vaultConsole").innerText));
  state.delayMs = 0;
  check("[Host] late storage load does not overwrite user edits", (await page.inputValue("#vaultTxCapInput")) === "15");
  check("[Host] no requests left the page except to Base RPC", unexpected.length === 0, unexpected.join(", "));
  check("[Host] no JavaScript errors", errors.length === 0, errors.join(" | "));
  await context.close();
  state.sdk = "none";
}

(async () => {
  // The GitHub Pages copy must never drift from the Anna bundle.
  const docsDir = path.join(__dirname, "..", "docs");
  if (BUNDLE === path.join(__dirname, "..", "bundle") && fs.existsSync(docsDir)) {
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    const files = walk(BUNDLE).map((f) => path.relative(BUNDLE, f));
    const drift = files.filter((f) => !fs.existsSync(path.join(docsDir, f)) || !fs.readFileSync(path.join(BUNDLE, f)).equals(fs.readFileSync(path.join(docsDir, f))));
    check("docs/ is identical to bundle/", drift.length === 0, `differs: ${drift.join(", ")}`);
  }

  const state = { sdk: "none", kv: {} };
  const server = await startServer(state);
  const base = `http://127.0.0.1:${server.address().port}/`;
  console.log(`Serving ${BUNDLE} at ${base}`);
  const browser = await chromium.launch();
  try {
    await standaloneFlow(browser, base, { [SEPOLIA]: newChain(), "mainnet.base.org": newChain() });
    await mobileFlow(browser, base, { [SEPOLIA]: newChain(), "mainnet.base.org": newChain() });
    await hostFlow(browser, base, state, { [SEPOLIA]: newChain(), "mainnet.base.org": newChain() });
  } catch (e) {
    check("test run completed without crashing", false, e.stack || String(e));
  } finally {
    await browser.close();
    server.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
})();
