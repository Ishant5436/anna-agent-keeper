/**
 * AgentKeeper Studio — Cyber-OLED HUD Controller
 * Standalone & Anna AI OS Host-integrated agent spend guard.
 *
 * LIVE: Agent Vault and Spend Requests (see vault-ui.js). Policy and approvals
 * are saved; balances and payments are read from Base; the user signs every
 * payment in their own wallet.
 * SIMULATED: BCH covenant, x402 and ERC-4337 tabs. Their dashboard figures
 * come from POLICY plus `session` (this session's simulated activity), so the
 * dashboard can never disagree with the tabs.
 */

import { encodeTokenPrefix, CONSENSUS_MAX_COMMITMENT_BYTES } from "./lib/cashtokens.js";
import { initVaultUI } from "./vault-ui.js";

const APP_VERSION = "1.0.2";
const DAY_MS = 24 * 60 * 60 * 1000;
const BCH_SATS = 1e8; // BCH tracked in satoshis to avoid float drift
const USDC_MICRO = 1e6; // USDC tracked in micro-units (6 decimals)
const CASHTOKENS_MAX_AMOUNT = 9223372036854775807n; // CHIP-2022-02 fungible max

// Single source of truth for every limit the simulators enforce and the
// dashboard displays.
const POLICY = Object.freeze({
  bch: Object.freeze({ dailyLimitBch: 10.0, scope: "per agent fleet" }),
  x402: Object.freeze({ nonceFloor: 10001 }),
  erc4337: Object.freeze({ maxVerificationGas: 1000000 }),
});

// Session state: only what has been simulated since the page loaded (or since
// "Reset simulation").
function freshSession() {
  return {
    bch: { ledger: [], last: null }, // ledger entries: { at, sats }
    x402: { lastNonce: POLICY.x402.nonceFloor, receipts: [], rejected: 0, last: null },
    userOp: { last: null },
  };
}
let session = freshSession();
let anna = null;
let vaultUI = null;
const TAB_CONSOLES = ["bchConsole", "x402Console", "userOpConsole"];
const initialConsoleHtml = {};

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);
const val = (id) => ($(id) ? $(id).value : "");
const isEvmAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test(s);

// Parses a non-negative whole number. Accepts plain digits of any length, and
// forms a number field allows such as "1e6" when they are exact integers.
function parseWholeNumber(raw) {
  if (/^\d+$/.test(raw)) return BigInt(raw);
  const n = Number(raw);
  return raw !== "" && Number.isSafeInteger(n) && n >= 0 ? BigInt(n) : null;
}

// How to refer to the x402 replay threshold. Before anything is settled it is
// a starting floor, not a "last settled" nonce.
function nonceRef() {
  const x = session.x402;
  return x.receipts.length
    ? `last settled nonce ${x.lastNonce}`
    : `starting nonce floor ${x.lastNonce} (no claims settled yet)`;
}

function fmtNum(n, minDp = 2, maxDp = 8) {
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: minDp, maximumFractionDigits: maxDp });
}
const fmtBch = (n) => `${fmtNum(n, 2, 8)} BCH`;

function usedInWindow(ledger, unitsKey, now = Date.now()) {
  return ledger.filter((e) => now - e.at < DAY_MS).reduce((sum, e) => sum + e[unitsKey], 0);
}
const bchUsedSats = () => usedInWindow(session.bch.ledger, "sats");

function setBadge(id, text, tone) {
  const badge = $(id);
  if (!badge) return;
  badge.textContent = text;
  badge.className = `hud-badge ${tone || ""}`.trim();
}

// Terminal Logger Helper
function logLine(elementId, text, type = "", { keepPlaceholder = false } = {}) {
  const el = $(elementId);
  if (!el) return;
  // The first real entry replaces any "nothing happened yet" placeholder line.
  if (!keepPlaceholder) el.querySelectorAll(".terminal-placeholder").forEach((p) => p.remove());
  const line = document.createElement("div");
  line.className = `terminal-line ${type}`.trim();
  line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;

  // Mirror to central telemetry log
  if (elementId !== "telemetryConsole") {
    const telem = $("telemetryConsole");
    if (telem) {
      telem.appendChild(line.cloneNode(true));
      telem.scrollTop = telem.scrollHeight;
    }
  }
}

// ---------- Dashboard (always derived from POLICY + session) ----------
function renderBindings() {
  const bindings = {
    bchLimit: fmtNum(POLICY.bch.dailyLimitBch, 2, 8),
    gasBound: POLICY.erc4337.maxVerificationGas.toLocaleString("en-US"),
  };
  document.querySelectorAll("[data-bind]").forEach((el) => {
    const key = el.getAttribute("data-bind");
    if (key in bindings) el.textContent = bindings[key];
  });
  const nonceHint = $("x402NonceRef");
  if (nonceHint) nonceHint.textContent = nonceRef();
}

function renderDashboard() {
  // BCH covenant limit: the exact number the BCH validator enforces.
  const bchUsed = bchUsedSats() / BCH_SATS;
  $("metricBchLimit").textContent = fmtBch(POLICY.bch.dailyLimitBch);
  $("metricBchSub").textContent = `${fmtBch(bchUsed)} used · ${POLICY.bch.scope}`;

  // x402: counts only receipts actually settled in this session.
  const x = session.x402;
  const settledTotal = x.receipts.reduce((s, r) => s + r.micro, 0) / USDC_MICRO;
  $("metricX402Value").textContent = `${x.receipts.length} settled`;
  if (x.receipts.length === 0 && x.rejected === 0) {
    $("metricX402Sub").textContent = "No claims verified yet";
  } else {
    $("metricX402Sub").textContent = `${fmtNum(settledTotal, 2, 6)} USDC · ${x.rejected} rejected`;
  }

  renderBindings();
}

// ---------- Tabs ----------
function activateTab(targetId) {
  document.querySelectorAll(".nav-tab").forEach((t) => {
    t.classList.toggle("active", t.getAttribute("data-tab") === targetId);
  });
  document.querySelectorAll(".tab-pane").forEach((pane) => {
    pane.classList.toggle("active", pane.id === targetId);
  });
}

function initTabs() {
  document.querySelectorAll(".nav-tab, .metric-link").forEach((el) => {
    el.addEventListener("click", () => activateTab(el.getAttribute("data-tab")));
  });
}

// ---------- Presets ----------
function initPresets() {
  $("presetBchValidFungible")?.addEventListener("click", () => {
    $("bchAmountInput").value = "1000000";
    $("bchCapabilityInput").value = "";
    $("bchCommitmentInput").value = "";
    $("bchSpendInput").value = "2.5";
    logLine("bchConsole", "Preset loaded: 1M fungible CashTokens (no NFT), 2.5 BCH withdrawal.", "info");
  });

  $("presetBchNftState")?.addEventListener("click", () => {
    $("bchCapabilityInput").value = "none";
    $("bchCommitmentInput").value = "02beefcafe112233";
    $("bchSpendInput").value = "1.0";
    logLine("bchConsole", "Preset loaded: Immutable NFT state commitment, 1.0 BCH withdrawal.", "info");
  });

  $("presetBchOverQuota")?.addEventListener("click", () => {
    $("bchSpendInput").value = "25.0";
    logLine(
      "bchConsole",
      `Preset loaded: 25.0 BCH withdrawal, above the ${fmtBch(POLICY.bch.dailyLimitBch)} daily limit. Validation should block it.`,
      "warn"
    );
  });

  // x402 presets always pick the next valid nonce so they never collide with
  // a previously settled one by accident.
  $("presetX402Inference")?.addEventListener("click", () => {
    $("x402NotionalInput").value = "0.001";
    $("x402NonceInput").value = String(session.x402.lastNonce + 1);
    logLine("x402Console", "Preset loaded: Single inference query (0.001 USDC), next valid nonce.", "info");
  });

  $("presetX402Batch")?.addEventListener("click", () => {
    $("x402NotionalInput").value = "5.00";
    $("x402NonceInput").value = String(session.x402.lastNonce + 1);
    logLine("x402Console", "Preset loaded: Batch inference settlement (5.00 USDC), next valid nonce.", "info");
  });

  $("presetX402Replay")?.addEventListener("click", () => {
    $("x402NonceInput").value = String(POLICY.x402.nonceFloor);
    logLine("x402Console", `Preset loaded: Replay nonce ${POLICY.x402.nonceFloor}. Verification should reject it.`, "warn");
  });
}

// ---------- BCH CashTokens Validator ----------
function initBchValidation() {
  $("btnValidateBch")?.addEventListener("click", () => {
    const category = val("bchCategoryInput").trim();
    const amountRaw = val("bchAmountInput").trim();
    const commitment = val("bchCommitmentInput").trim();
    const spend = parseFloat(val("bchSpendInput"));
    const limitSats = Math.round(POLICY.bch.dailyLimitBch * BCH_SATS);
    const reject = (badgeText, reason) => {
      session.bch.last = { status: "REJECTED", reason, category, spend };
      setBadge("bchStatusBadge", badgeText, "red");
      logLine("bchConsole", `REJECTED: ${reason}`, "fail");
      renderDashboard();
    };

    logLine("bchConsole", `Evaluating CHIP-2022-02 prefix: Category=${category.slice(0, 10)}… Amount=${amountRaw || "?"}`);

    if (!/^[0-9a-fA-F]{64}$/.test(category)) {
      return reject("INVALID CATEGORY", "Category ID must be 32 bytes of hex (64 hex characters).");
    }
    const tokenAmount = parseWholeNumber(amountRaw);
    if (tokenAmount === null || tokenAmount > CASHTOKENS_MAX_AMOUNT) {
      return reject("INVALID AMOUNT", "Token amount must be a whole number from 0 to 9223372036854775807.");
    }
    if (commitment && !/^([0-9a-fA-F]{2})+$/.test(commitment)) {
      return reject("INVALID COMMITMENT", "NFT commitment must be hex bytes (even number of hex characters).");
    }
    const capability = val("bchCapabilityInput");
    if (commitment && !capability) {
      return reject("INVALID COMMITMENT", "A commitment needs an NFT: choose an NFT type, or clear the commitment.");
    }
    let prefix;
    try {
      prefix = encodeTokenPrefix({ category, amount: tokenAmount, nft: capability ? { capability, commitment } : null });
    } catch (e) {
      $("bchPrefixOutput").textContent = "—";
      return reject("INVALID TOKEN", e.message);
    }
    $("bchPrefixOutput").textContent = prefix;
    logLine("bchConsole", `[PASS] Token prefix encoded (CHIP-2022-02, real encoding): ${prefix}`, "pass");
    if (commitment.length / 2 > CONSENSUS_MAX_COMMITMENT_BYTES) {
      logLine("bchConsole", `[WARN] Commitment is ${commitment.length / 2} bytes, over the ${CONSENSUS_MAX_COMMITMENT_BYTES}-byte consensus limit in CHIP-2022-02.`, "warn");
    }
    if (!(spend > 0) || !Number.isFinite(spend)) {
      return reject("INVALID SPEND", "Withdrawal amount must be greater than 0 BCH.");
    }

    const spendSats = Math.round(spend * BCH_SATS);
    if (spendSats < 1) {
      return reject("INVALID SPEND", "Withdrawal amount must be at least 0.00000001 BCH (1 satoshi).");
    }
    const usedSats = bchUsedSats();
    const remainingSats = Math.max(0, limitSats - usedSats);

    if (spendSats > remainingSats) {
      const reason =
        spendSats > limitSats
          ? `Spend request ${fmtBch(spend)} exceeds the daily limit of ${fmtBch(POLICY.bch.dailyLimitBch)} ${POLICY.bch.scope}.`
          : `Spend request ${fmtBch(spend)} exceeds the remaining daily allowance of ${fmtBch(remainingSats / BCH_SATS)} (${fmtBch(usedSats / BCH_SATS)} of ${fmtBch(POLICY.bch.dailyLimitBch)} already used).`;
      session.bch.last = { status: "BLOCKED", reason, category, spend };
      setBadge("bchStatusBadge", "OVER-QUOTA SPEND BLOCKED", "red");
      logLine("bchConsole", `[BLOCKED] ${reason}`, "fail");
      logLine("bchConsole", "[SAFETY] Covenant invariant protected the UTXO treasury from an unconstrained drain.", "warn");
      renderDashboard();
      return;
    }

    session.bch.ledger.push({ at: Date.now(), sats: spendSats });
    const nowUsed = bchUsedSats() / BCH_SATS;
    session.bch.last = { status: "VERIFIED", category, spend, usedAfter: nowUsed };
    setBadge("bchStatusBadge", "COVENANT VERIFIED", "green");
    logLine(
      "bchConsole",
      `[PASS] Spend ${fmtBch(spend)} is within the allowance. Daily usage is now ${fmtBch(nowUsed)} of ${fmtBch(POLICY.bch.dailyLimitBch)} (simulated).`,
      "pass"
    );
    renderDashboard();
  });

  $("btnSyncBchToChat")?.addEventListener("click", async () => {
    const last = session.bch.last;
    let result;
    if (!last) result = "NOT RUN. Validate the request in AgentKeeper first.";
    else if (last.status === "VERIFIED")
      result = `VERIFIED (${fmtBch(last.spend)}; ${fmtBch(last.usedAfter)} of ${fmtBch(POLICY.bch.dailyLimitBch)} daily limit used, ${POLICY.bch.scope})`;
    else result = `${last.status}: ${last.reason}`;
    const msg = [
      "[AgentKeeper Security Brief]",
      "- Target: BCH CashTokens Covenant (CHIP-2022-02)",
      `- Category: ${last ? last.category : val("bchCategoryInput").trim()}`,
      `- Spend Request: ${last ? fmtBch(last.spend || 0) : `${val("bchSpendInput")} BCH`}`,
      `- Covenant Check: ${result}`,
      "- Mode: Simulation (nothing broadcast on-chain).",
    ].join("\n");
    await dispatchToChat(msg, "bchConsole");
  });
}

// ---------- x402 Micropayments ----------
function initX402Validation() {
  $("btnVerifyX402")?.addEventListener("click", () => {
    const resource = val("x402ResourceInput").trim();
    const notional = parseFloat(val("x402NotionalInput"));
    const nonceRaw = val("x402NonceInput").trim();
    const nonce = /^\d+$/.test(nonceRaw) ? parseInt(nonceRaw, 10) : NaN;
    const x = session.x402;
    const reject = (badgeText, reason) => {
      x.rejected += 1;
      x.last = { status: "REJECTED", reason, resource, notional, nonce };
      setBadge("x402StatusBadge", badgeText, "red");
      logLine("x402Console", `[BLOCKED] ${reason}`, "fail");
      logLine("x402Console", "No receipt issued. Nothing was settled.", "warn");
      renderDashboard();
    };

    logLine("x402Console", `Evaluating x402 claim: Target=${resource} Notional=${isNaN(notional) ? "?" : notional} USDC Nonce=${nonceRaw || "?"}`);

    if (!/^https?:\/\/\S+$/i.test(resource)) return reject("INVALID RESOURCE", "API resource must be an http(s) URL.");
    if (!(notional > 0) || !Number.isFinite(notional)) return reject("INVALID AMOUNT", "Claim notional must be greater than 0 USDC.");
    if (Math.round(notional * USDC_MICRO) < 1) return reject("INVALID AMOUNT", "Claim notional must be at least 0.000001 USDC.");
    if (!Number.isSafeInteger(nonce)) return reject("INVALID NONCE", "Nonce must be a whole number.");
    if (nonce <= x.lastNonce)
      return reject("REPLAY ATTACK BLOCKED", `Nonce ${nonce} ≤ ${nonceRef()}. Monotonicity violated.`);

    const micro = Math.round(notional * USDC_MICRO);
    const receipt = { id: `rec_${nonce}`, nonce, micro, resource, at: Date.now() };
    x.lastNonce = nonce;
    x.receipts.push(receipt);
    x.last = { status: "SETTLED", receipt, resource, notional, nonce };
    setBadge("x402StatusBadge", "CLAIM SETTLED", "green");
    logLine("x402Console", `[PASS] Nonce monotonicity confirmed (${nonce} > previous). Signature check not simulated.`, "pass");
    logLine(
      "x402Console",
      `[SETTLED] ${fmtNum(notional, 2, 6)} USDC recorded as simulated receipt #${receipt.id}. No on-chain transfer.`,
      "pass"
    );
    renderDashboard();
  });

  $("btnSyncX402ToChat")?.addEventListener("click", async () => {
    const last = session.x402.last;
    let lines;
    if (!last) {
      lines = [
        `- Endpoint: ${val("x402ResourceInput").trim()}`,
        "- Receipt: NOT SETTLED. No claim has been verified in this session.",
      ];
    } else if (last.status === "SETTLED") {
      lines = [
        `- Endpoint: ${last.resource}`,
        `- Claim: ${fmtNum(last.notional, 2, 6)} USDC`,
        `- Receipt: SETTLED (simulated) #${last.receipt.id}`,
        `- Replay Protection: Monotonic nonce ${last.nonce} confirmed.`,
      ];
    } else {
      lines = [
        `- Endpoint: ${last.resource}`,
        `- Claim: ${isNaN(last.notional) ? "?" : `${last.notional} USDC`}`,
        `- Receipt: NOT SETTLED. Rejected: ${last.reason}`,
      ];
    }
    const settledCount = session.x402.receipts.length;
    const msg = [
      "[AgentKeeper x402 Stream Brief]",
      ...lines,
      `- Session: ${settledCount} settled, ${session.x402.rejected} rejected.`,
      "- Mode: Simulation (nothing broadcast on-chain).",
    ].join("\n");
    await dispatchToChat(msg, "x402Console");
  });
}

// ---------- ERC-4337 Simulation ----------
function initErc4337() {
  $("btnSimulateUserOp")?.addEventListener("click", () => {
    const sender = val("userOpSenderInput").trim();
    const data = val("userOpDataInput").trim();
    const gasRaw = val("userOpGasInput").trim();
    const gas = /^\d+$/.test(gasRaw) ? parseInt(gasRaw, 10) : NaN;
    const bound = POLICY.erc4337.maxVerificationGas;
    const reject = (badgeText, reason) => {
      session.userOp.last = { status: "REJECTED", reason, sender, gas };
      setBadge("userOpStatusBadge", badgeText, "red");
      logLine("userOpConsole", `REJECTED: ${reason}`, "fail");
    };

    logLine("userOpConsole", `Simulating UserOp: Sender=${sender.slice(0, 10)}… Gas=${gasRaw || "?"}`);

    if (!isEvmAddress(sender)) return reject("INVALID SENDER", "Sender must be a 20-byte hex address (0x + 40 hex chars).");
    if (!/^0x[0-9a-fA-F]{8,}$/.test(data) || data.length % 2 !== 0)
      return reject("INVALID CALLDATA", "Calldata must be 0x-prefixed hex bytes with at least a 4-byte function selector.");
    if (!(gas > 0)) return reject("INVALID GAS", "Verification gas limit must be a whole number greater than 0.");
    if (gas > bound)
      return reject("GAS SPIKE DETECTED", `Verification gas ${gas.toLocaleString("en-US")} exceeds the safe bound of ${bound.toLocaleString("en-US")}.`);

    session.userOp.last = { status: "PASSED", sender, gas, selector: data.slice(0, 10) };
    setBadge("userOpStatusBadge", "SIMULATED SUCCESS", "green");
    logLine(
      "userOpConsole",
      `[PASS] Verification gas ${gas.toLocaleString("en-US")} is within the safe bound of ${bound.toLocaleString("en-US")}.`,
      "pass"
    );
    logLine("userOpConsole", `[PASS] EntryPoint v0.7 pre-flight checks passed for selector ${data.slice(0, 10)} (simulated; not sent to a bundler).`, "pass");
  });

  $("btnSyncUserOpToChat")?.addEventListener("click", async () => {
    const last = session.userOp.last;
    let status;
    if (!last) status = "NOT RUN. Simulate the UserOp in AgentKeeper first.";
    else if (last.status === "PASSED") status = "SIMULATION_PASSED (0 reverts in local pre-flight checks)";
    else status = `REJECTED: ${last.reason}`;
    const msg = [
      "[AgentKeeper ERC-4337 Brief]",
      `- Smart Account: ${last ? last.sender : val("userOpSenderInput").trim()}`,
      `- Gas Limit: ${last && !isNaN(last.gas) ? last.gas : val("userOpGasInput")} (bound ${POLICY.erc4337.maxVerificationGas.toLocaleString("en-US")})`,
      `- Status: ${status}`,
      "- Mode: Simulation (not sent to a bundler).",
    ].join("\n");
    await dispatchToChat(msg, "userOpConsole");
  });
}

// ---------- Dispatch to Anna Chat, or copy to clipboard ----------
async function dispatchToChat(message, consoleId) {
  if (anna && anna.chat) {
    try {
      // Host contract: chat.write_message({ text }).
      await anna.chat.write_message({ text: message });
      logLine(consoleId, "Sent structured brief to Anna Chat.", "pass");
      return;
    } catch (e) {
      logLine(consoleId, `Anna Chat unavailable (${e && e.message ? e.message : e}); trying clipboard.`, "warn");
    }
  }

  try {
    await navigator.clipboard.writeText(message);
    logLine(consoleId, "Standalone mode: brief copied to clipboard.", "info");
  } catch (e) {
    logLine(consoleId, "Could not reach Anna Chat or the clipboard. Brief text follows:", "warn");
    message.split("\n").forEach((l) => logLine(consoleId, l));
  }
}

// ---------- Reset ----------
function resetSimulation() {
  session = freshSession();
  TAB_CONSOLES.forEach((id) => {
    if ($(id) && id in initialConsoleHtml) $(id).innerHTML = initialConsoleHtml[id];
  });
  setBadge("bchStatusBadge", "READY", "muted");
  setBadge("x402StatusBadge", "IDLE", "muted");
  setBadge("userOpStatusBadge", "READY", "muted");
  $("x402NonceInput").value = String(POLICY.x402.nonceFloor + 1);
  $("bchPrefixOutput").textContent = "Validate to encode.";
  renderDashboard();
  logLine("telemetryConsole", "[RESET] Simulated tabs reset (BCH covenant, x402, ERC-4337). Agent Vault and Spend Requests are unchanged.", "info");
}

// ---------- Boot ----------
async function boot() {
  const versionBadge = $("appVersionBadge");
  if (versionBadge) versionBadge.textContent = `v${APP_VERSION}`;

  TAB_CONSOLES.forEach((id) => {
    if ($(id)) initialConsoleHtml[id] = $(id).innerHTML;
  });
  initTabs();
  initPresets();
  initBchValidation();
  initX402Validation();
  initErc4337();
  vaultUI = initVaultUI({ logLine, setBadge, dispatchToChat, getAnna: () => anna });
  renderDashboard();

  $("btnResetSimulation")?.addEventListener("click", resetSimulation);
  $("btnClearTelemetry")?.addEventListener("click", () => {
    const con = $("telemetryConsole");
    if (con) con.innerHTML = '<div class="terminal-line info">[LOG] Telemetry console reset.</div>';
  });

  logLine("telemetryConsole", `AgentKeeper Studio v${APP_VERSION} ready.`, "info");

  // Attempt Anna App Runtime connect
  const hostPill = $("hostStatusPill");
  try {
    const { AnnaAppRuntime } = await import("/static/anna-apps/_sdk/latest/index.js");
    anna = await AnnaAppRuntime.connect();
    if (hostPill) {
      hostPill.textContent = "Connected to Anna OS";
      hostPill.className = "hud-badge green";
    }
    try {
      await anna.window.set_title({ title: "AgentKeeper Studio" });
    } catch (e) {
      /* title is cosmetic */
    }
    logLine("telemetryConsole", "Connected to Anna Host Runtime.", "pass");
  } catch (err) {
    anna = null;
    if (hostPill) {
      hostPill.textContent = "Standalone Mode";
      hostPill.className = "hud-badge";
    }
    logLine("telemetryConsole", "Running in Standalone Preview mode (no Anna host detected).", "info");
  }

  await vaultUI.load();
}

boot();
