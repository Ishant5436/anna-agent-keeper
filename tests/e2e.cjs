#!/usr/bin/env node
/**
 * End-to-end test for the AgentKeeper Studio bundle.
 *
 * Serves bundle/ on localhost, drives every tab and button in Chromium, and
 * checks after each step that the dashboard agrees with what the tabs enforce.
 * Runs twice: standalone (no Anna host) and against a mock Anna host SDK that
 * mirrors @anna-ai/app-runtime's call shape, to cover chat + storage calls.
 *
 * Usage: node tests/e2e.cjs [bundleDir] [screenshotDir]
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
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

// ---------- tiny assertion collector ----------
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n      → ${detail}` : ""}`);
}

const text = (page, sel) => page.locator(sel).first().innerText();
const lastLine = (page, id) => page.locator(`#${id} .terminal-line`).last().innerText();
const allLines = (page, id) => page.locator(`#${id}`).innerText();
// For async handlers (storage, clipboard): wait until a matching log line appears.
const waitForLine = (page, id, re) =>
  page
    .waitForFunction(([i, src]) => new RegExp(src).test(document.getElementById(i).innerText), [id, re.source], { timeout: 5000 })
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

async function standaloneFlow(browser, base) {
  console.log("\n=== Standalone flow (desktop 1040x780, Anna default window) ===");
  const context = await browser.newContext({ viewport: { width: 1040, height: 780 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource.*404/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  // Each brief differs from the previous one, so wait for the clipboard to change.
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

  // --- Initial state ---
  check("host pill shows Standalone Mode", (await text(page, "#hostStatusPill")) === "Standalone Mode");
  check("simulation notice is visible", await page.locator("#simNotice").isVisible());
  check("version badge is v1.0.1", (await text(page, "#appVersionBadge")) === "v1.0.1");
  const bchLimit = await text(page, "#metricBchLimit");
  check("[Issue 1] dashboard BCH limit is 10.00 BCH", bchLimit === "10.00 BCH", bchLimit);
  check(
    "[Issue 1] BCH console policy line states the same 10.00 BCH limit and scope",
    /Daily spending bound: 10\.00 BCH per agent fleet/.test(await allLines(page, "bchConsole"))
  );
  check("[Issue 1] dashboard BCH card names its scope", /per agent fleet/.test(await text(page, "#metricBchSub")));
  check("[Issue 1] no stray 150.00 BCH anywhere", !(await page.content()).includes("150.00"));
  check("[Issue 2] dashboard x402 starts at 0 settled", (await text(page, "#metricX402Value")) === "0 settled");
  check("[Issue 2] dashboard x402 says no claims verified", (await text(page, "#metricX402Sub")) === "No claims verified yet");
  check("[Issue 2] x402 receipt badge is IDLE", (await text(page, "#x402StatusBadge")) === "IDLE");
  check("[Issue 2] no '100% Settled' anywhere", !(await page.content()).includes("100% Settled"));
  check("treasury cap card shows $250.00 USDC", (await text(page, "#metricTreasuryCap")) === "$250.00 USDC");
  check("desktop: no horizontal scroll", await noHorizontalScroll(page));
  await shot(page, "01-initial-bch");

  // --- BCH CashTokens Guard ---
  await page.click("#btnValidateBch");
  check("BCH 2.5 validates", (await text(page, "#bchStatusBadge")) === "COVENANT VERIFIED");
  check("dashboard BCH usage 2.50", (await text(page, "#metricBchSub")).startsWith("2.50 BCH used"));

  await page.click("#presetBchOverQuota");
  await page.click("#btnValidateBch");
  check("BCH 25.0 blocked", (await text(page, "#bchStatusBadge")) === "OVER-QUOTA SPEND BLOCKED");
  const blockLine = (await allLines(page, "bchConsole")).split("\n").filter((l) => l.includes("[BLOCKED]")).pop() || "";
  check(
    "[Issue 1] block message cites the same 10.00 BCH limit as the dashboard",
    blockLine.includes(`daily limit of ${bchLimit}`),
    blockLine
  );
  check("blocked spend does not count as used", (await text(page, "#metricBchSub")).startsWith("2.50 BCH used"));
  await shot(page, "02-bch-blocked");

  await page.fill("#bchSpendInput", "7.5");
  await page.click("#btnValidateBch");
  check("BCH 7.5 more fills allowance to exactly 10.00", (await text(page, "#metricBchSub")).startsWith("10.00 BCH used"));
  await page.fill("#bchSpendInput", "0.1");
  await page.click("#btnValidateBch");
  check("BCH 0.1 blocked once the daily allowance is used up", /remaining daily allowance of 0\.00 BCH/.test(await allLines(page, "bchConsole")));

  await page.fill("#bchCategoryInput", "xyz");
  await page.click("#btnValidateBch");
  check("invalid category rejected", (await text(page, "#bchStatusBadge")) === "INVALID CATEGORY");
  await page.fill("#bchCategoryInput", "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08");

  await page.click("#btnResetSimulation");
  check("reset clears BCH usage", (await text(page, "#metricBchSub")).startsWith("0.00 BCH used"));
  await page.click("#presetBchNftState");
  await page.click("#btnValidateBch");
  check("NFT-state preset validates", (await text(page, "#bchStatusBadge")) === "COVENANT VERIFIED");
  await page.click("#btnSyncBchToChat");
  const bchBrief = await clipboard();
  check("BCH brief reports the real result + simulation mode", /VERIFIED \(1\.00 BCH; 1\.00 BCH of 10\.00 BCH/.test(bchBrief) && /Simulation/.test(bchBrief), bchBrief);

  // --- Dashboard card navigates to the tab that enforces it ---
  await page.click(".metric-link[data-tab='tab-treasury']");
  check("treasury card opens Autonomous Treasury tab", await page.locator("#tab-treasury").isVisible());

  // --- Autonomous Treasury ---
  await page.click("#btnSimulateTreasury");
  check("Test Spend $12.50 approved", (await text(page, "#treasuryStatusBadge")) === "SPEND APPROVED");
  check("treasury 'no spends yet' line removed after a spend", !/No simulated spends yet/.test(await allLines(page, "treasuryConsole")));
  check("dashboard treasury usage $12.50", (await text(page, "#metricTreasurySub")).startsWith("$12.50 used"));
  await page.fill("#treasuryTestAmountInput", "60");
  await page.click("#btnSimulateTreasury");
  check("Test Spend over per-tx cap rejected", /per-transaction cap of \$50\.00/.test(await lastLine(page, "treasuryConsole")));
  await page.fill("#treasuryTestAmountInput", "5");
  await page.fill("#treasuryTestRecipientInput", "0x1111111111111111111111111111111111111111");
  await page.click("#btnSimulateTreasury");
  check("Test Spend to non-whitelisted recipient rejected", /not on the whitelist/.test(await lastLine(page, "treasuryConsole")));
  await page.fill("#treasuryTestRecipientInput", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  await page.fill("#treasuryTxCapInput", "10");
  await page.fill("#treasuryDailyCapInput", "20");
  check("dashboard follows edited 24h cap", (await text(page, "#metricTreasuryCap")) === "$20.00 USDC");
  check("treasury console policy line follows edited caps", /Per-tx cap \$10\.00 · rolling 24h cap \$20\.00/.test(await allLines(page, "treasuryConsole")));
  await page.fill("#treasuryTestAmountInput", "8");
  await page.click("#btnSimulateTreasury");
  check("Test Spend over rolling 24h cap rejected", /would exceed the rolling 24h cap/.test(await lastLine(page, "treasuryConsole")));
  await page.fill("#treasuryDailyCapInput", "12");
  await page.fill("#treasuryTestAmountInput", "1");
  await page.click("#btnSimulateTreasury");
  const overLine = await lastLine(page, "treasuryConsole");
  check("cap lowered below usage: remaining is $0.00, never negative", /\$0\.00 remaining/.test(overLine) && !/\$-/.test(overLine), overLine);
  await page.fill("#treasuryDailyCapInput", "20");
  await page.fill("#treasuryTxCapInput", "30");
  check("tx cap above 24h cap flagged as invalid", (await text(page, "#treasuryStatusBadge")) === "POLICY INVALID");
  check("invalid edit does not change dashboard", (await text(page, "#metricTreasuryCap")) === "$20.00 USDC");
  await page.fill("#treasuryTxCapInput", "10");
  await page.click("#btnSaveTreasury");
  check("Save Treasury Limits stores locally in standalone", await waitForLine(page, "treasuryConsole", /Saved treasury limits to this browser's local storage/));
  await shot(page, "03-treasury");

  // --- Network selector + reload persistence ---
  await page.selectOption("#networkSelect", "arc-mainnet");
  check("network change is logged", /\[NETWORK\] Context set to Circle Arc/.test(await allLines(page, "telemetryConsole")));

  await page.reload();
  await page.waitForFunction(() => /Loaded saved treasury limits/.test(document.getElementById("treasuryConsole").innerText));
  check("saved limits reload into the form", (await page.inputValue("#treasuryDailyCapInput")) === "20");
  check("saved limits reload into the dashboard", (await text(page, "#metricTreasuryCap")) === "$20.00 USDC");
  check("session usage is not carried across reload", (await text(page, "#metricTreasurySub")).startsWith("$0.00 used"));

  // --- x402 Micropayments ---
  await page.click(".metric-link[data-tab='tab-x402']");
  check("x402 card opens x402 tab", await page.locator("#tab-x402").isVisible());
  await page.click("#btnSyncX402ToChat");
  const preBrief = await clipboard();
  check("[Issue 2] brief before verifying says NOT SETTLED", /NOT SETTLED/.test(preBrief) && !/Receipt: SETTLED/.test(preBrief), preBrief);
  let c = await x402Consistent(page);
  check("[Issue 2] dashboard and receipt panel agree before any claim", c.ok, c.detail);

  await page.click("#btnVerifyX402");
  check("Verify & Settle default claim settles", (await text(page, "#x402StatusBadge")) === "CLAIM SETTLED");
  check("dashboard shows 1 settled", (await text(page, "#metricX402Value")) === "1 settled");
  c = await x402Consistent(page);
  check("[Issue 2] dashboard and receipt panel agree after settle", c.ok, c.detail);
  const x402Text = await allLines(page, "x402Console");
  check("[Issue 2] receipt panel no longer says 'No claims have been settled'", !/No claims have been settled/.test(x402Text), x402Text);
  check("no unbacked 'Signature valid' claim", !/Signature valid/.test(await page.content()));
  await shot(page, "04-x402-settled");

  await page.click("#btnVerifyX402");
  check("same nonce again is blocked as replay", (await text(page, "#x402StatusBadge")) === "REPLAY ATTACK BLOCKED");
  check("replay does not add a settlement", (await text(page, "#metricX402Value")) === "1 settled");
  check("replay counted as rejected", /1 rejected/.test(await text(page, "#metricX402Sub")));

  await page.click("#presetX402Batch");
  await page.click("#btnVerifyX402");
  check("Batch Settlement preset settles", (await text(page, "#x402StatusBadge")) === "CLAIM SETTLED");
  check("dashboard totals 2 claims, 5.0025 USDC", (await text(page, "#metricX402Value")) === "2 settled" && /5\.0025 USDC/.test(await text(page, "#metricX402Sub")));

  await page.click("#presetX402Replay");
  await page.click("#btnVerifyX402");
  check("Replay preset is blocked", (await text(page, "#x402StatusBadge")) === "REPLAY ATTACK BLOCKED");
  await page.click("#presetX402Inference");
  await page.click("#btnVerifyX402");
  check("Inference preset settles", (await text(page, "#metricX402Value")) === "3 settled");
  c = await x402Consistent(page);
  check("[Issue 2] dashboard and receipt panel agree after mixed run", c.ok, c.detail);
  await page.click("#btnSyncX402ToChat");
  check("x402 brief reports the real settled receipt", /Receipt: SETTLED \(simulated\) #rec_/.test(await clipboard()));

  // --- ERC-4337 ---
  await page.click(".nav-tab[data-tab='tab-erc4337']");
  await page.click("#btnSimulateUserOp");
  check("UserOp default simulates OK", (await text(page, "#userOpStatusBadge")) === "SIMULATED SUCCESS");
  check("UserOp log reports the actual gas", /Verification gas 150,000 is within the safe bound of 1,000,000/.test(await allLines(page, "userOpConsole")));
  await page.fill("#userOpGasInput", "2000000");
  await page.click("#btnSimulateUserOp");
  check("UserOp gas spike rejected", (await text(page, "#userOpStatusBadge")) === "GAS SPIKE DETECTED");
  await page.fill("#userOpDataInput", "0x12");
  await page.fill("#userOpGasInput", "150000");
  await page.click("#btnSimulateUserOp");
  check("UserOp bad calldata rejected", (await text(page, "#userOpStatusBadge")) === "INVALID CALLDATA");
  await page.click("#btnSyncUserOpToChat");
  check("UserOp brief reports REJECTED, not PASSED", /Status: REJECTED/.test(await clipboard()));

  // --- Telemetry ---
  await page.click(".nav-tab[data-tab='tab-telemetry']");
  check("telemetry mirrors tab activity", /SETTLED/.test(await allLines(page, "telemetryConsole")));
  await page.click("#btnClearTelemetry");
  check("Clear Log resets telemetry", (await allLines(page, "telemetryConsole")).trim() === "[LOG] Telemetry console reset.");

  // --- Reset simulation ---
  await page.click("#btnResetSimulation");
  check(
    "Reset simulation zeroes dashboard",
    (await text(page, "#metricX402Value")) === "0 settled" && (await text(page, "#metricBchSub")).startsWith("0.00 BCH used")
  );
  check("Reset restores IDLE x402 badge", (await text(page, "#x402StatusBadge")) === "IDLE");
  check("Reset keeps saved treasury cap", (await text(page, "#metricTreasuryCap")) === "$20.00 USDC");
  c = await x402Consistent(page);
  check("[Issue 2] after reset, receipt panel shows no old receipts", c.ok && (await text(page, "#metricX402Value")) === "0 settled", c.detail);
  check("after reset, receipt panel placeholder is back", /No claims have been settled/.test(await allLines(page, "x402Console")));
  check("after reset, treasury console shows no old spends", !/\[APPROVED\]/.test(await allLines(page, "treasuryConsole")));

  // --- Anna minimum window size ---
  await page.setViewportSize({ width: 780, height: 540 });
  await page.click(".nav-tab[data-tab='tab-bch']");
  check("780x540 (Anna min size): no horizontal scroll", await noHorizontalScroll(page));
  await shot(page, "05-min-size");

  check("no JavaScript errors in standalone flow", errors.length === 0, errors.join(" | "));
  await context.close();
}

async function mobileFlow(browser, base) {
  console.log("\n=== Mobile layout (390x844) ===");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.waitForFunction(() => document.getElementById("hostStatusPill").textContent !== "Connecting…");
  for (const tab of ["tab-bch", "tab-treasury", "tab-x402", "tab-erc4337", "tab-telemetry"]) {
    await page.click(`.nav-tab[data-tab='${tab}']`);
    check(`mobile ${tab}: no horizontal scroll`, await noHorizontalScroll(page));
  }
  await page.click(".nav-tab[data-tab='tab-bch']");
  await page.click("#presetBchOverQuota");
  await page.click("#btnValidateBch");
  check("mobile: over-quota block works", (await text(page, "#bchStatusBadge")) === "OVER-QUOTA SPEND BLOCKED");
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, "06-mobile");
  check("no JavaScript errors on mobile", errors.length === 0, errors.join(" | "));
  await context.close();
}

async function hostFlow(browser, base, state) {
  console.log("\n=== Anna host flow (mock SDK, same call shape as @anna-ai/app-runtime) ===");
  state.sdk = "mock";
  const context = await browser.newContext({ viewport: { width: 1040, height: 780 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const calls = () => page.evaluate(() => window.__annaCalls || []);

  await page.goto(base);
  await page.waitForFunction(() => document.getElementById("hostStatusPill").textContent === "Connected to Anna OS");
  check("host pill shows Connected to Anna OS", true);
  const titleCall = (await calls()).find((x) => x.ns === "window" && x.method === "set_title");
  check("window.set_title({ title }) called", titleCall && titleCall.args.title === "AgentKeeper Studio");

  await page.click("#btnValidateBch");
  await page.click("#btnSyncBchToChat");
  await waitForLine(page, "bchConsole", /Sent structured brief to Anna Chat/);
  const chatCall = (await calls()).find((x) => x.ns === "chat" && x.method === "write_message");
  check(
    "Send to Anna Chat uses chat.write_message({ text })",
    chatCall && typeof chatCall.args.text === "string" && /VERIFIED/.test(chatCall.args.text),
    JSON.stringify(chatCall && chatCall.args)
  );
  check("chat dispatch logged as sent", /Sent structured brief to Anna Chat/.test(await allLines(page, "bchConsole")));

  await page.click(".nav-tab[data-tab='tab-treasury']");
  await page.fill("#treasuryDailyCapInput", "300");
  await page.click("#btnSaveTreasury");
  const setCall = (await calls()).find((x) => x.ns === "storage" && x.method === "set");
  check("storage.set({ key, value }) called", setCall && setCall.args.key === "agentkeeper:treasury" && setCall.args.value.dailyCapUsdc === 300);
  check("save logged as Anna storage", await waitForLine(page, "treasuryConsole", /Saved treasury limits to Anna persistent storage/));

  await page.reload();
  await page.waitForFunction(() => /Loaded saved treasury limits from Anna/.test(document.getElementById("treasuryConsole").innerText));
  check("limits reload from Anna storage", (await text(page, "#metricTreasuryCap")) === "$300.00 USDC");

  // Slow host connect: an edit made before saved limits load must not be overwritten.
  state.delayMs = 1500;
  await page.reload();
  await page.click(".nav-tab[data-tab='tab-treasury']");
  await page.fill("#treasuryDailyCapInput", "400");
  await page.waitForFunction(() => /not applied, because the form was already edited/.test(document.getElementById("treasuryConsole").innerText));
  state.delayMs = 0;
  check("late storage load does not overwrite user edits", (await page.inputValue("#treasuryDailyCapInput")) === "400" && (await text(page, "#metricTreasuryCap")) === "$400.00 USDC");
  check("no JavaScript errors in host flow", errors.length === 0, errors.join(" | "));
  await context.close();
  state.sdk = "none";
}

(async () => {
  const state = { sdk: "none", kv: {} };
  const server = await startServer(state);
  const base = `http://127.0.0.1:${server.address().port}/`;
  console.log(`Serving ${BUNDLE} at ${base}`);
  const browser = await chromium.launch();
  try {
    await standaloneFlow(browser, base);
    await mobileFlow(browser, base);
    await hostFlow(browser, base, state);
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
