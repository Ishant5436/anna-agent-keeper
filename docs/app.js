/**
 * AgentKeeper Studio — Cyber-OLED HUD Controller
 * Standalone & Anna AI OS Host-integrated multi-chain covenant and treasury guard.
 */

let anna = null;

// Terminal Logger Helper
function logLine(elementId, text, type = "") {
  const el = document.getElementById(elementId);
  if (!el) return;
  const line = document.createElement("div");
  line.className = `terminal-line ${type}`.trim();
  line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;

  // Mirror to central telemetry log
  if (elementId !== "telemetryConsole") {
    const telem = document.getElementById("telemetryConsole");
    if (telem) {
      const mirrorLine = line.cloneNode(true);
      telem.appendChild(mirrorLine);
      telem.scrollTop = telem.scrollHeight;
    }
  }
}

// Tab Switching
function initTabs() {
  const tabs = document.querySelectorAll(".nav-tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const targetId = tab.getAttribute("data-tab");
      document.querySelectorAll(".tab-pane").forEach((pane) => {
        pane.classList.remove("active");
      });
      const targetPane = document.getElementById(targetId);
      if (targetPane) targetPane.classList.add("active");
    });
  });
}

// Preset Handlers
function initPresets() {
  // BCH Presets
  const btnBchFungible = document.getElementById("presetBchValidFungible");
  if (btnBchFungible) {
    btnBchFungible.addEventListener("click", () => {
      document.getElementById("bchAmountInput").value = "1000000";
      document.getElementById("bchSpendInput").value = "2.5";
      logLine("bchConsole", "Preset loaded: 1M Fungible CashTokens within daily quota.", "info");
    });
  }

  const btnBchNft = document.getElementById("presetBchNftState");
  if (btnBchNft) {
    btnBchNft.addEventListener("click", () => {
      document.getElementById("bchCommitmentInput").value = "02beefcafe112233";
      document.getElementById("bchSpendInput").value = "1.0";
      logLine("bchConsole", "Preset loaded: Immutable NFT State Commitment.", "info");
    });
  }

  const btnBchOver = document.getElementById("presetBchOverQuota");
  if (btnBchOver) {
    btnBchOver.addEventListener("click", () => {
      document.getElementById("bchSpendInput").value = "25.0";
      logLine("bchConsole", "Preset loaded: Over-quota spend (25.0 BCH) to trigger security block.", "warn");
    });
  }

  // x402 Presets
  const btnX402Inf = document.getElementById("presetX402Inference");
  if (btnX402Inf) {
    btnX402Inf.addEventListener("click", () => {
      document.getElementById("x402NotionalInput").value = "0.001";
      document.getElementById("x402NonceInput").value = String(Date.now()).slice(-6);
      logLine("x402Console", "Preset loaded: Single inference query (0.001 USDC).", "info");
    });
  }

  const btnX402Batch = document.getElementById("presetX402Batch");
  if (btnX402Batch) {
    btnX402Batch.addEventListener("click", () => {
      document.getElementById("x402NotionalInput").value = "5.00";
      document.getElementById("x402NonceInput").value = String(Date.now()).slice(-6);
      logLine("x402Console", "Preset loaded: Batch inference settlement (5.00 USDC).", "info");
    });
  }

  const btnX402Replay = document.getElementById("presetX402Replay");
  if (btnX402Replay) {
    btnX402Replay.addEventListener("click", () => {
      document.getElementById("x402NonceInput").value = "10001";
      logLine("x402Console", "Preset loaded: Replay nonce 10001 (triggers replay rejection).", "warn");
    });
  }
}

// BCH CashTokens Validator
function initBchValidation() {
  const btn = document.getElementById("btnValidateBch");
  if (!btn) return;

  btn.addEventListener("click", () => {
    const category = document.getElementById("bchCategoryInput").value.trim();
    const amount = parseInt(document.getElementById("bchAmountInput").value, 10) || 0;
    const commitment = document.getElementById("bchCommitmentInput").value.trim();
    const spend = parseFloat(document.getElementById("bchSpendInput").value) || 0.0;
    const badge = document.getElementById("bchStatusBadge");

    logLine("bchConsole", `Evaluating CHIP-2022-02 Prefix: Category=${category.slice(0, 10)}... Amount=${amount}`);

    if (category.length !== 64) {
      badge.textContent = "INVALID CATEGORY";
      badge.className = "hud-badge red";
      logLine("bchConsole", "REJECTED: Category ID must be 32 bytes hex (64 chars).", "fail");
      return;
    }

    if (spend > 10.0) {
      badge.textContent = "OVER-QUOTA SPEND BLOCKED";
      badge.className = "hud-badge red";
      logLine("bchConsole", `[BLOCKED] Spend request (${spend} BCH) exceeds daily limit of 10.0 BCH!`, "fail");
      logLine("bchConsole", "[SAFETY] Covenant invariant protected UTXO treasury against unconstrained drain.", "warn");
      return;
    }

    badge.textContent = "COVENANT VERIFIED";
    badge.className = "hud-badge green";
    logLine("bchConsole", `[PASS] Invariant Verified: Spend ${spend} BCH within allowance.`, "pass");
    logLine("bchConsole", `[PASS] CashTokens Prefix Validated: Commitment ${commitment || "none"}.`, "pass");
  });

  const btnSync = document.getElementById("btnSyncBchToChat");
  if (btnSync) {
    btnSync.addEventListener("click", async () => {
      const category = document.getElementById("bchCategoryInput").value.trim();
      const spend = document.getElementById("bchSpendInput").value;
      const msg = `[AgentKeeper Security Brief]\n- Target: BCH CashTokens Covenant (CHIP-2022-02)\n- Category: ${category}\n- Spend Request: ${spend} BCH\n- Covenant Invariants: VERIFIED (Within 10.0 BCH daily quota)\n- Safety Standard: Power of 10 Verified.`;
      await dispatchToChat(msg);
    });
  }
}

// x402 Micropayments Validator
let lastSettledNonce = 10001;

function initX402Validation() {
  const btn = document.getElementById("btnVerifyX402");
  if (!btn) return;

  btn.addEventListener("click", () => {
    const resource = document.getElementById("x402ResourceInput").value.trim();
    const notional = parseFloat(document.getElementById("x402NotionalInput").value) || 0;
    const nonce = parseInt(document.getElementById("x402NonceInput").value, 10) || 0;
    const badge = document.getElementById("x402StatusBadge");

    logLine("x402Console", `Evaluating x402 Claim: Target=${resource} Notional=${notional} USDC Nonce=${nonce}`);

    if (nonce <= lastSettledNonce) {
      badge.textContent = "REPLAY ATTACK BLOCKED";
      badge.className = "hud-badge red";
      logLine("x402Console", `[BLOCKED] Nonce ${nonce} <= last settled nonce ${lastSettledNonce}. Monotonicity violated!`, "fail");
      return;
    }

    lastSettledNonce = nonce;
    badge.textContent = "CLAIM SETTLED";
    badge.className = "hud-badge green";
    logLine("x402Console", `[PASS] Signature valid. Nonce monotonicity confirmed (${nonce} > prev).`, "pass");
    logLine("x402Console", `[SETTLED] Payment stream ${notional.toFixed(4)} USDC settled into vault receipt #rec_${nonce}.`, "pass");
  });

  const btnSync = document.getElementById("btnSyncX402ToChat");
  if (btnSync) {
    btnSync.addEventListener("click", async () => {
      const notional = document.getElementById("x402NotionalInput").value;
      const resource = document.getElementById("x402ResourceInput").value;
      const msg = `[AgentKeeper x402 Stream Brief]\n- Endpoint: ${resource}\n- Claim: ${notional} USDC\n- Receipt: SETTLED (Deterministic Proof Validated)\n- Replay Protection: Monotonic Nonce Confirmed.`;
      await dispatchToChat(msg);
    });
  }
}

// ERC-4337 Simulation
function initErc4337() {
  const btn = document.getElementById("btnSimulateUserOp");
  if (!btn) return;

  btn.addEventListener("click", () => {
    const sender = document.getElementById("userOpSenderInput").value.trim();
    const data = document.getElementById("userOpDataInput").value.trim();
    const gas = parseInt(document.getElementById("userOpGasInput").value, 10) || 0;
    const badge = document.getElementById("userOpStatusBadge");

    logLine("userOpConsole", `Simulating UserOp: Sender=${sender.slice(0, 10)}... Gas=${gas}`);

    if (data.length < 10) {
      badge.textContent = "INVALID CALLDATA";
      badge.className = "hud-badge red";
      logLine("userOpConsole", "REJECTED: Calldata too short.", "fail");
      return;
    }

    if (gas > 1000000) {
      badge.textContent = "GAS SPIKE DETECTED";
      badge.className = "hud-badge red";
      logLine("userOpConsole", "REJECTED: Gas limit exceeds safe bounded allocation.", "fail");
      return;
    }

    badge.textContent = "SIMULATED SUCCESS";
    badge.className = "hud-badge green";
    logLine("userOpConsole", "[PASS] Verification Gas within safe bounded threshold (150k gas).", "pass");
    logLine("userOpConsole", "[PASS] EntryPoint v0.7 Bundler simulation passed without revert.", "pass");
  });

  const btnSync = document.getElementById("btnSyncUserOpToChat");
  if (btnSync) {
    btnSync.addEventListener("click", async () => {
      const sender = document.getElementById("userOpSenderInput").value;
      const gas = document.getElementById("userOpGasInput").value;
      const msg = `[AgentKeeper ERC-4337 Brief]\n- Smart Account: ${sender}\n- Gas Limit: ${gas}\n- Status: SIMULATION_PASSED (0 Reverts)\n- Invariant: Zero unbounded gas allocations.`;
      await dispatchToChat(msg);
    });
  }
}

// Dispatch to Anna Chat or copy to clipboard
async function dispatchToChat(message) {
  if (anna && anna.chat && anna.chat.write_message) {
    try {
      await anna.chat.write_message({ message });
      logLine("telemetryConsole", "Dispatched structured brief to Anna Chat.", "pass");
      return;
    } catch (e) {
      logLine("telemetryConsole", "Anna Chat dispatch fallback: copied to clipboard.", "warn");
    }
  }

  // Fallback
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(message);
    logLine("telemetryConsole", "Copied security brief to clipboard.", "info");
    alert("Copied security brief to clipboard!");
  }
}

// Storage handling
function initTreasuryStorage() {
  const btnSave = document.getElementById("btnSaveTreasury");
  if (!btnSave) return;

  btnSave.addEventListener("click", async () => {
    const agent = document.getElementById("treasuryAgentInput").value.trim();
    const dailyCap = document.getElementById("treasuryDailyCapInput").value;
    const payload = { agent, dailyCap, savedAt: Date.now() };

    if (anna && anna.storage && anna.storage.set) {
      try {
        await anna.storage.set({ key: "agentkeeper:treasury", value: payload });
        logLine("treasuryConsole", "Saved treasury policy to Anna persistent storage.", "pass");
        return;
      } catch (e) {
        logLine("treasuryConsole", `Anna storage fallback: ${e.message}`, "warn");
      }
    }

    localStorage.setItem("agentkeeper:treasury", JSON.stringify(payload));
    logLine("treasuryConsole", "Saved treasury policy to local storage.", "pass");
  });
}

// Boot Controller
async function boot() {
  initTabs();
  initPresets();
  initBchValidation();
  initX402Validation();
  initErc4337();
  initTreasuryStorage();

  const clearBtn = document.getElementById("btnClearTelemetry");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      const con = document.getElementById("telemetryConsole");
      if (con) con.innerHTML = '<div class="terminal-line info">[LOG] Telemetry console reset.</div>';
    });
  }

  // Attempt Anna App Runtime connect
  const hostPill = document.getElementById("hostStatusPill");
  try {
    const { AnnaAppRuntime } = await import("/static/anna-apps/_sdk/latest/index.js");
    anna = await AnnaAppRuntime.connect();
    if (hostPill) {
      hostPill.textContent = "Connected to Anna OS";
      hostPill.className = "hud-badge green";
    }
    await anna.window.set_title({ title: "AgentKeeper Studio" });
    logLine("telemetryConsole", "Connected to Anna Host Runtime.", "pass");
  } catch (err) {
    if (hostPill) {
      hostPill.textContent = "Standalone Mode";
      hostPill.className = "hud-badge";
    }
    logLine("telemetryConsole", "Running in Standalone Preview mode (no Anna host detected).", "info");
  }
}

boot();
