#!/usr/bin/env node
/**
 * Live end-to-end check against the real Base Sepolia testnet.
 *
 * Finds a real, recent USDC transfer on Base Sepolia, then drives the app UI:
 * saves that transfer's sender as the vault, submits a matching spend request,
 * approves it, pastes the real transaction hash, and expects the app to
 * confirm the transfer from its on-chain receipt. Also runs the live monitor.
 *
 * Needs network access to https://sepolia.base.org and `curl` on PATH (RPC
 * calls are forwarded through curl so proxies and CA settings are honoured).
 *
 * Usage: node tests/live.cjs [screenshotDir]
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const BUNDLE = path.join(__dirname, "..", "bundle");
const SHOTS = process.argv[2] ? path.resolve(process.argv[2]) : null;
const RPC = "https://sepolia.base.org";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

function rpcRaw(body) {
  return execFileSync("curl", ["-sS", "-m", "40", "-X", "POST", "-H", "content-type: application/json", "--data-binary", "@-", RPC], { input: body }).toString();
}
function rpc(method, params) {
  const out = JSON.parse(rpcRaw(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })));
  if (out.error) throw new Error(`${method}: ${out.error.message}`);
  return out.result;
}

function findRecentTransfer() {
  const latest = Number(BigInt(rpc("eth_blockNumber", [])));
  for (let end = latest; end > latest - 2000; end -= 200) {
    const logs = rpc("eth_getLogs", [{ address: USDC, fromBlock: `0x${(end - 199).toString(16)}`, toBlock: `0x${end.toString(16)}`, topics: [TRANSFER_TOPIC] }]);
    for (const l of logs.reverse()) {
      const from = `0x${l.topics[1].slice(26)}`;
      const to = `0x${l.topics[2].slice(26)}`;
      const amount = BigInt(l.data);
      const usdcAddr = USDC.toLowerCase();
      if (amount > 0n && amount <= 10n ** 15n && BigInt(from) && BigInt(to) && from !== to && from !== usdcAddr && to !== usdcAddr)
        return { tx: l.transactionHash, from, to, amountMicro: Number(amount), block: Number(BigInt(l.blockNumber)) };
    }
  }
  throw new Error("No recent USDC transfer found on Base Sepolia.");
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n      → ${detail}` : ""}`);
}

(async () => {
  const sample = findRecentTransfer();
  const usdc = (m) => (m / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, ".00");
  console.log(`Using real transfer ${sample.tx}\n  ${usdc(sample.amountMicro)} USDC ${sample.from} → ${sample.to} (block ${sample.block})`);

  const server = http.createServer((req, res) => {
    const rel = req.url === "/" ? "index.html" : req.url.split("?")[0].slice(1);
    const file = path.resolve(BUNDLE, rel);
    if (!file.startsWith(BUNDLE) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  let rpcCalls = 0;
  await context.route(/^https?:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1") return route.continue();
    if (url.origin !== RPC) return route.abort();
    rpcCalls++;
    const body = rpcRaw(route.request().postData() || "");
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body });
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const wait = (sel, re, timeout = 60000) =>
    page.waitForFunction(([s, src]) => { const e = document.querySelector(s); return e && new RegExp(src).test(e.innerText); }, [sel, re.source], { timeout }).then(() => true, () => false);

  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => !document.getElementById("btnSaveVault").disabled);
    const cap = Math.max(50, Math.ceil(sample.amountMicro / 1e6) * 2);
    await page.selectOption("#vaultNetworkInput", "base-sepolia");
    await page.fill("#vaultAddressInput", sample.from);
    await page.fill("#vaultTxCapInput", String(cap));
    await page.fill("#vaultDailyCapInput", String(cap * 2));
    await page.fill("#vaultThresholdInput", "0");
    await page.fill("#vaultWhitelistInput", sample.to);
    await page.click("#btnSaveVault");
    check("vault saved", await wait("#vaultSetupBadge", /SAVED · BASE SEPOLIA/));
    check("live monitor read real balances from Base Sepolia", await wait("#monitorBadge", /NO ALERTS|UNAPPROVED OUTFLOW/), await page.locator("#vaultConsole").innerText());
    console.log(`  monitor: USDC ${await page.innerText("#monUsdc")}, ETH ${await page.innerText("#monEth")}, 24h net out ${await page.innerText("#monNetOut")}`);
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, "live-vault.png") }); }

    await page.click(".nav-tab[data-tab='tab-requests']");
    await page.fill("#reqRecipientInput", sample.to);
    await page.fill("#reqAmountInput", usdc(sample.amountMicro));
    await page.fill("#reqMemoInput", "Live check against Base Sepolia");
    await page.click("#btnSubmitRequest");
    const item = page.locator(".request-item").first();
    check("request held for approval (threshold 0)", /AWAITING APPROVAL/.test(await item.innerText()));
    await item.locator("button:has-text('Approve')").click();
    check("approved", await wait(".request-item", /APPROVED · SEND IT/));
    await item.locator("input").fill(sample.tx);
    await item.locator("button:has-text('Confirm on-chain')").click();
    check("real transfer confirmed on-chain from its receipt", await wait(".request-item", /CONFIRMED ON-CHAIN/), await item.innerText());
    check("confirmation names the real block", new RegExp(`block ${sample.block}`).test(await item.innerText()), await item.innerText());
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "live-requests.png") });

    // The same transaction cannot pass for a different amount.
    await page.fill("#reqAmountInput", usdc(sample.amountMicro + 1));
    await page.click("#btnSubmitRequest");
    const second = page.locator(".request-item").first();
    await second.locator("button:has-text('Approve')").click();
    await wait(".request-item", /APPROVED · SEND IT/);
    await second.locator("input").fill(sample.tx);
    await second.locator("button:has-text('Confirm on-chain')").click();
    check("reusing the tx for another request is refused", await wait(".request-item", /already linked to another request/));
  } catch (e) {
    check("live run completed", false, e.stack || String(e));
  } finally {
    check(`no JavaScript errors (${rpcCalls} real RPC calls)`, errors.length === 0, errors.join(" | "));
    await browser.close();
    server.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} live checks passed.`);
  process.exit(failed.length ? 1 : 0);
})();
