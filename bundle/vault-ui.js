/**
 * Agent Vault + Spend Requests (LIVE).
 *
 * Flow: save a vault policy → submit a spend request → the guard approves it,
 * holds it for your approval, or blocks it → you send the approved USDC
 * transfer from your own wallet → paste the tx hash → AgentKeeper confirms the
 * exact transfer from its on-chain receipt. The monitor compares the vault's
 * real balance over 24h with the payments you approved.
 */

import {
  NETWORKS, STATUS, DAY_MS, isAddress, isTxHash, shortAddress, parseUsdc, formatUsdc,
  validateConfig, evaluateRequest, decidePendingApproval, committedMicro, paymentFor,
  newRequestId, normalizeVaultDoc,
} from "./lib/vault.js";
import { monitorVault, verifyPayment, formatEth } from "./lib/rpc.js";

const STORAGE_KEY = "agentkeeper:vault";
const LEGACY_STORAGE_KEY = "agentkeeper:treasury"; // v1.0.1 treasury policy

const $ = (id) => document.getElementById(id);
const val = (id) => ($(id) ? $(id).value.trim() : "");

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

const STATUS_LABEL = {
  [STATUS.PENDING]: ["AWAITING APPROVAL", "amber"],
  [STATUS.APPROVED]: ["APPROVED · SEND IT", "green"],
  [STATUS.SENT]: ["SENT · CONFIRMING", "amber"],
  [STATUS.VERIFIED]: ["CONFIRMED ON-CHAIN", "green"],
  [STATUS.BLOCKED]: ["BLOCKED", "red"],
  [STATUS.DENIED]: ["DENIED", "red"],
  [STATUS.CANCELLED]: ["CANCELLED", "muted"],
};

export function initVaultUI({ logLine, setBadge, dispatchToChat, getAnna }) {
  let doc = normalizeVaultDoc(null);
  let loaded = false;
  let formTouched = false;
  let lastCheck = null; // latest monitor result for the saved vault
  let checking = false;

  const net = () => NETWORKS[doc.config.network];
  const configured = () => validateConfig(doc.config).length === 0;
  const explorerAddress = (a) => `${net().explorer}/address/${a}`;
  const explorerTx = (h) => `${net().explorer}/tx/${h}`;

  // ---------- Persistence ----------
  async function readStored(key) {
    const anna = getAnna();
    if (anna && anna.storage) {
      try {
        const res = await anna.storage.get({ key });
        const v = res && typeof res === "object" && "value" in res ? res.value : res;
        if (v) return { value: v, source: "Anna storage" };
      } catch (e) {
        /* fall back to this browser */
      }
    }
    try {
      const s = localStorage.getItem(key);
      if (s) return { value: JSON.parse(s), source: "this browser's storage" };
    } catch (e) {
      /* storage unavailable */
    }
    return null;
  }

  async function persist() {
    const anna = getAnna();
    if (anna && anna.storage) {
      try {
        await anna.storage.set({ key: STORAGE_KEY, value: doc });
        return "Anna storage";
      } catch (e) {
        logLine("vaultConsole", `Anna storage unavailable (${e && e.message ? e.message : e}); saving in this browser instead.`, "warn");
      }
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
      return "this browser's storage";
    } catch (e) {
      logLine("vaultConsole", "Could not save: storage is not available here. Changes last until you close the app.", "fail");
      return null;
    }
  }

  // ---------- Vault form ----------
  function writeForm(c) {
    $("vaultNetworkInput").value = c.network;
    $("vaultAddressInput").value = c.vaultAddress;
    $("vaultAgentInput").value = c.agent;
    $("vaultTxCapInput").value = formatUsdc(c.txCapMicro).replace(/,/g, "");
    $("vaultDailyCapInput").value = formatUsdc(c.dailyCapMicro).replace(/,/g, "");
    $("vaultThresholdInput").value = formatUsdc(c.approvalThresholdMicro).replace(/,/g, "");
    $("vaultWhitelistInput").value = c.whitelist.join(", ");
  }

  function readForm() {
    const parseErrors = [];
    const amount = (id, label) => {
      const m = parseUsdc(val(id));
      if (m === null) parseErrors.push(`${label} must be a USDC amount with up to 6 decimals.`);
      return m ?? 0;
    };
    const config = {
      network: val("vaultNetworkInput"),
      vaultAddress: val("vaultAddressInput"),
      agent: val("vaultAgentInput"),
      txCapMicro: amount("vaultTxCapInput", "Per-transaction cap"),
      dailyCapMicro: amount("vaultDailyCapInput", "Rolling 24h cap"),
      approvalThresholdMicro: amount("vaultThresholdInput", "Approval threshold"),
      whitelist: val("vaultWhitelistInput").split(/[\s,]+/).filter(Boolean),
    };
    return { config, errors: [...parseErrors, ...validateConfig(config)] };
  }

  async function saveVault() {
    const { config, errors } = readForm();
    if (errors.length) {
      setBadge("vaultSetupBadge", "CHECK SETTINGS", "amber");
      errors.forEach((e) => logLine("vaultConsole", `[SETUP] ${e}`, "fail"));
      return;
    }
    const moved = config.network !== doc.config.network || config.vaultAddress.toLowerCase() !== doc.config.vaultAddress.toLowerCase();
    if (moved && doc.requests.some((r) => r.status === STATUS.APPROVED || r.status === STATUS.SENT)) {
      logLine("vaultConsole", "[SETUP] Finish or cancel approved payments before changing the vault address or network.", "fail");
      return;
    }
    doc.config = config;
    if (moved) lastCheck = null;
    const where = await persist();
    if (where) logLine("vaultConsole", `[SETUP] Vault saved to ${where}: ${shortAddress(config.vaultAddress)} on ${net().label}.`, "pass");
    render();
    if (moved) checkVault();
  }

  // ---------- Live monitor ----------
  async function checkVault() {
    if (!configured() || checking) return;
    checking = true;
    setBadge("monitorBadge", "CHECKING…", "muted");
    $("btnCheckVault").disabled = true;
    const c = doc.config;
    try {
      const r = await monitorVault(net(), c.vaultAddress, doc.requests);
      if (c !== doc.config) return; // vault changed mid-check
      lastCheck = { ...r, at: Date.now() };
      logLine(
        "vaultConsole",
        `[LIVE] Block ${r.latest.number}: ${formatUsdc(r.usdcNow)} USDC, ${formatEth(r.ethWei)} ETH. 24h net out ${formatUsdc(Math.max(0, r.netOutMicro))} USDC, approved & confirmed ${formatUsdc(r.verifiedOutMicro)} USDC.`,
        r.alert ? "fail" : "pass"
      );
      if (r.alert) logLine("vaultConsole", `[ALERT] ${formatUsdc(r.unexplainedMicro)} USDC left the vault in the last 24h without a confirmed approval.`, "fail");
    } catch (e) {
      lastCheck = { error: e.message, at: Date.now() };
      logLine("vaultConsole", `[LIVE] Could not read ${net().label}: ${e.message}`, "fail");
    } finally {
      checking = false;
      render();
    }
  }

  // ---------- Requests ----------
  async function submitRequest() {
    if (!configured()) {
      logLine("requestConsole", "Set up and save the vault first (Agent Vault tab).", "fail");
      return;
    }
    const recipient = val("reqRecipientInput");
    const amountMicro = parseUsdc(val("reqAmountInput"));
    const memo = val("reqMemoInput").slice(0, 120);
    if (amountMicro === null) {
      logLine("requestConsole", "Amount must be a USDC amount with up to 6 decimals.", "fail");
      setBadge("requestBadge", "INVALID AMOUNT", "red");
      return;
    }
    const now = Date.now();
    const { decision, reason } = evaluateRequest(doc.config, doc.requests, { recipient, amountMicro }, now);
    const req = {
      id: newRequestId(now),
      createdAt: now,
      agent: doc.config.agent,
      recipient,
      amountMicro,
      memo,
      status: decision,
      reason,
      decidedAt: decision === STATUS.PENDING ? null : now,
    };
    doc.requests.unshift(req);
    await persist();
    const [label, tone] = STATUS_LABEL[decision];
    setBadge("requestBadge", label, tone);
    logLine(
      "requestConsole",
      `[GUARD] ${formatUsdc(amountMicro)} USDC → ${shortAddress(recipient) || "?"}: ${decision.toUpperCase()}. ${reason}`,
      decision === STATUS.BLOCKED ? "fail" : decision === STATUS.PENDING ? "warn" : "pass"
    );
    render();
  }

  function findRequest(id) {
    return doc.requests.find((r) => r.id === id);
  }

  async function approve(id) {
    const r = findRequest(id);
    if (!r || r.status !== STATUS.PENDING) return;
    const res = decidePendingApproval(doc.config, doc.requests, r, Date.now());
    r.status = res.decision;
    r.reason = res.reason;
    r.decidedAt = Date.now();
    await persist();
    logLine("requestConsole", `[APPROVAL] ${formatUsdc(r.amountMicro)} USDC → ${shortAddress(r.recipient)}: ${r.status.toUpperCase()}. ${r.reason}`, r.status === STATUS.BLOCKED ? "fail" : "pass");
    render();
  }

  async function setStatus(id, status, reason) {
    const r = findRequest(id);
    if (!r) return;
    r.status = status;
    r.reason = reason;
    r.decidedAt = Date.now();
    await persist();
    logLine("requestConsole", `[APPROVAL] ${formatUsdc(r.amountMicro)} USDC → ${shortAddress(r.recipient)}: ${status.toUpperCase()}.`, "warn");
    render();
  }

  async function confirmPayment(id, txHash) {
    const r = findRequest(id);
    if (!r) return;
    if (r.status === STATUS.APPROVED) {
      if (!isTxHash(txHash)) {
        r.verifyNote = "Transaction hash must be 0x followed by 64 hex characters.";
        render();
        return;
      }
      const reused = doc.requests.find((o) => o.id !== id && o.txHash && o.txHash.toLowerCase() === txHash.toLowerCase());
      if (reused) {
        r.verifyNote = "That transaction is already linked to another request.";
        render();
        return;
      }
      r.status = STATUS.SENT;
      r.txHash = txHash;
      r.sentAt = Date.now();
      await persist();
    }
    if (r.status !== STATUS.SENT) return;
    r.verifyNote = "Checking on-chain…";
    render();
    try {
      const res = await verifyPayment(net(), r.txHash, { from: doc.config.vaultAddress, to: r.recipient, amountMicro: r.amountMicro });
      if (res.ok) {
        r.status = STATUS.VERIFIED;
        r.blockNumber = res.blockNumber;
        r.verifiedAt = Date.now();
        r.verifyNote = res.reason;
        logLine("requestConsole", `[ON-CHAIN] ${formatUsdc(r.amountMicro)} USDC → ${shortAddress(r.recipient)} confirmed in block ${res.blockNumber}.`, "pass");
      } else if (res.pending) {
        r.verifyNote = res.reason;
        logLine("requestConsole", `[ON-CHAIN] ${shortAddress(r.txHash)}: ${res.reason}`, "warn");
      } else {
        // Wrong or failed transaction: back to approved so the right hash can be entered.
        r.status = STATUS.APPROVED;
        r.verifyNote = `Not confirmed: ${res.reason}`;
        delete r.txHash;
        logLine("requestConsole", `[ON-CHAIN] Not confirmed: ${res.reason}`, "fail");
      }
    } catch (e) {
      r.verifyNote = `Could not reach ${net().label}: ${e.message}`;
      logLine("requestConsole", `[ON-CHAIN] ${r.verifyNote}`, "fail");
    }
    await persist();
    render();
  }

  async function clearFinished() {
    const now = Date.now();
    const keep = (r) =>
      ![STATUS.BLOCKED, STATUS.DENIED, STATUS.CANCELLED].includes(r.status) &&
      !(r.status === STATUS.VERIFIED && now - r.decidedAt >= DAY_MS);
    const before = doc.requests.length;
    doc.requests = doc.requests.filter(keep);
    await persist();
    logLine("requestConsole", `[HISTORY] Cleared ${before - doc.requests.length} finished request(s). Payments still inside the 24h window are kept.`, "info");
    render();
  }

  async function sendReport() {
    const c = doc.config;
    const now = Date.now();
    const pending = doc.requests.filter((r) => r.status === STATUS.PENDING).length;
    const lines = [
      "[AgentKeeper Vault Report]",
      configured() ? `- Vault: ${c.vaultAddress} on ${net().label}` : "- Vault: not set up yet",
      `- Policy: ${formatUsdc(c.txCapMicro)} USDC per tx, ${formatUsdc(c.dailyCapMicro)} USDC rolling 24h, approval needed above ${formatUsdc(c.approvalThresholdMicro)} USDC, ${c.whitelist.length} whitelisted recipient(s)`,
      `- Last 24h: ${formatUsdc(committedMicro(doc.requests, now))} USDC committed, ${pending} awaiting approval`,
    ];
    if (lastCheck && !lastCheck.error)
      lines.push(
        `- Live check (block ${lastCheck.latest.number}): ${formatUsdc(lastCheck.usdcNow)} USDC; ${lastCheck.alert ? `ALERT: ${formatUsdc(lastCheck.unexplainedMicro)} USDC left without a confirmed approval` : "no unapproved outflow detected"}`
      );
    else lines.push("- Live check: not run yet");
    // Open items first, then payments confirmed in the 24h window.
    const open = doc.requests.filter((r) => [STATUS.PENDING, STATUS.APPROVED, STATUS.SENT].includes(r.status));
    const confirmed = doc.requests.filter((r) => r.status === STATUS.VERIFIED && now - r.decidedAt < DAY_MS);
    const refused = doc.requests.filter((r) => [STATUS.BLOCKED, STATUS.DENIED].includes(r.status)).length;
    for (const r of [...open, ...confirmed].slice(0, 10))
      lines.push(`- ${formatUsdc(r.amountMicro)} USDC → ${r.recipient}: ${STATUS_LABEL[r.status][0]}${r.txHash ? ` (tx ${r.txHash})` : ""}${r.memo ? ` [${r.memo}]` : ""}`);
    if (refused) lines.push(`- ${refused} request(s) blocked or denied`);
    lines.push("- Mode: live guard. Payments are signed by the user's own wallet; AgentKeeper holds no keys.");
    await dispatchToChat(lines.join("\n"), "requestConsole");
  }

  // ---------- Rendering ----------
  function copyButton(text, label = "Copy") {
    const b = el("button", { class: "btn-secondary btn-compact", type: "button", text: label });
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
        b.textContent = "Copied";
      } catch (e) {
        b.textContent = "Copy failed";
      }
      setTimeout(() => (b.textContent = label), 1500);
    });
    return b;
  }

  function field(label, value, copy = true) {
    return el("div", { class: "pay-field" },
      el("span", { class: "pay-label", text: label }),
      el("code", { class: "code-box", text: value }),
      copy ? copyButton(value) : null);
  }

  function renderRequest(r) {
    const [label, tone] = STATUS_LABEL[r.status] || [r.status, "muted"];
    const item = el("div", { class: `request-item status-${r.status}`, "data-request-id": r.id });
    item.append(
      el("div", { class: "request-head" },
        el("span", { class: "request-amount", text: `${formatUsdc(r.amountMicro)} USDC` }),
        el("span", { class: "request-to", text: `→ ${shortAddress(r.recipient) || r.recipient}` }),
        el("span", { class: `hud-badge ${tone}`, text: label })),
      el("div", { class: "request-meta", text: `${new Date(r.createdAt).toLocaleString()} · ${r.agent}${r.memo ? ` · ${r.memo}` : ""}` }),
      el("div", { class: "request-reason", text: r.reason })
    );
    const actions = el("div", { class: "btn-row request-actions" });

    if (r.status === STATUS.PENDING) {
      actions.append(
        el("button", { class: "btn-primary btn-compact", type: "button", text: "Approve", onclick: () => approve(r.id) }),
        el("button", { class: "btn-secondary btn-compact", type: "button", text: "Deny", onclick: () => setStatus(r.id, STATUS.DENIED, "Denied by you.") })
      );
    }
    if (r.status === STATUS.APPROVED) {
      const p = paymentFor(doc.config, r);
      item.append(
        el("div", { class: "pay-box" },
          el("p", { class: "form-hint", text: `Send this from your vault wallet (${shortAddress(p.from)}) on ${p.network}. It is a USDC transfer: value 0, sent to the USDC contract with this data.` }),
          field("Wallet link (EIP-681)", p.eip681),
          field("To (USDC contract)", p.to),
          field("Data", p.data),
          field("Chain ID", String(p.chainId), false))
      );
      const input = el("input", { class: "form-input", placeholder: "Paste the transaction hash (0x…)", autocomplete: "off", spellcheck: "false", "aria-label": "Transaction hash" });
      actions.append(
        input,
        el("button", { class: "btn-primary btn-compact", type: "button", text: "Confirm on-chain", onclick: () => confirmPayment(r.id, input.value.trim()) }),
        el("button", { class: "btn-secondary btn-compact", type: "button", text: "Cancel", onclick: () => setStatus(r.id, STATUS.CANCELLED, "Cancelled before sending.") })
      );
    }
    if (r.status === STATUS.SENT) {
      actions.append(el("button", { class: "btn-primary btn-compact", type: "button", text: "Check again", onclick: () => confirmPayment(r.id) }));
    }
    if (r.txHash) {
      const link = el("a", { class: "request-link", href: explorerTx(r.txHash), target: "_blank", rel: "noopener noreferrer", text: `tx ${shortAddress(r.txHash)}` });
      item.append(el("div", { class: "request-meta" }, link, r.blockNumber ? ` · block ${r.blockNumber}` : ""));
    }
    if (r.verifyNote) item.append(el("div", { class: `request-note ${r.status === STATUS.VERIFIED ? "ok" : ""}`, text: r.verifyNote }));
    if (actions.childNodes.length) item.append(actions);
    return item;
  }

  function render() {
    const c = doc.config;
    const ready = loaded;
    const isSetUp = configured();
    for (const id of ["btnSaveVault"]) $(id).disabled = !ready;
    $("btnCheckVault").disabled = !ready || !isSetUp || checking;
    $("btnSubmitRequest").disabled = !ready || !isSetUp;
    setBadge("vaultSetupBadge", isSetUp ? `SAVED · ${net().shortLabel.toUpperCase()}` : "NOT SET UP", isSetUp ? "green" : "muted");

    const link = $("vaultExplorerLink");
    link.hidden = !isSetUp;
    if (isSetUp) link.href = explorerAddress(c.vaultAddress);

    // Monitor panel
    const ok = lastCheck && !lastCheck.error;
    $("monUsdc").textContent = ok ? `${formatUsdc(lastCheck.usdcNow)} USDC` : "—";
    $("monEth").textContent = ok ? `${formatEth(lastCheck.ethWei)} ETH` : "—";
    $("monNetOut").textContent = ok ? `${formatUsdc(Math.max(0, lastCheck.netOutMicro))} USDC` : "—";
    $("monVerifiedOut").textContent = ok ? `${formatUsdc(lastCheck.verifiedOutMicro)} USDC` : "—";
    $("monUnexplained").textContent = ok ? (lastCheck.alert ? `${formatUsdc(lastCheck.unexplainedMicro)} USDC` : "None detected") : "—";
    $("monUnexplained").className = `stat-value ${ok ? (lastCheck.alert ? "bad" : "good") : ""}`.trim();
    if (!checking) {
      if (!isSetUp) setBadge("monitorBadge", "IDLE", "muted");
      else if (!lastCheck) setBadge("monitorBadge", "NOT CHECKED", "muted");
      else if (lastCheck.error) setBadge("monitorBadge", "RPC ERROR", "red");
      else setBadge("monitorBadge", lastCheck.alert ? "UNAPPROVED OUTFLOW" : "NO ALERTS", lastCheck.alert ? "red" : "green");
    }

    // Requests
    const list = $("requestList");
    list.replaceChildren(...(doc.requests.length ? doc.requests.map(renderRequest) : [el("p", { class: "empty-note", text: "No requests yet." })]));

    // Dashboard cards
    const now = Date.now();
    const pending = doc.requests.filter((r) => r.status === STATUS.PENDING).length;
    $("metricGuardCap").textContent = `${formatUsdc(c.dailyCapMicro)} USDC`;
    $("metricGuardSub").textContent = `${formatUsdc(committedMicro(doc.requests, now))} committed · ${pending} awaiting approval`;
    const navCount = $("navPendingCount");
    navCount.hidden = pending === 0;
    navCount.textContent = String(pending);

    const where = $("metricVaultWhere");
    where.className = "metric-where";
    if (!isSetUp) {
      $("metricVaultValue").textContent = "Not set up";
      $("metricVaultSub").textContent = "Add a vault address to start";
      where.textContent = "Monitored in Agent Vault ›";
    } else if (!ok) {
      $("metricVaultValue").textContent = shortAddress(c.vaultAddress);
      $("metricVaultSub").textContent = `${net().shortLabel} · ${lastCheck?.error ? "last check failed" : "not checked yet"}`;
      where.textContent = "Monitored in Agent Vault ›";
    } else {
      $("metricVaultValue").textContent = `${formatUsdc(lastCheck.usdcNow)} USDC`;
      $("metricVaultSub").textContent = `${shortAddress(c.vaultAddress)} · ${net().shortLabel}`;
      if (lastCheck.alert) {
        where.textContent = `${formatUsdc(lastCheck.unexplainedMicro)} USDC unapproved outflow ›`;
        where.className = "metric-where bad";
      } else {
        where.textContent = `Checked ${new Date(lastCheck.at).toLocaleTimeString()} · no alerts ›`;
      }
    }
  }

  // ---------- Wiring ----------
  ["vaultNetworkInput", "vaultAddressInput", "vaultAgentInput", "vaultTxCapInput", "vaultDailyCapInput", "vaultThresholdInput", "vaultWhitelistInput"].forEach((id) =>
    $(id).addEventListener("input", () => (formTouched = true))
  );
  $("vaultNetworkInput").addEventListener("change", () => (formTouched = true));
  $("btnSaveVault").addEventListener("click", saveVault);
  $("btnCheckVault").addEventListener("click", checkVault);
  $("btnSubmitRequest").addEventListener("click", submitRequest);
  $("btnClearHistory").addEventListener("click", clearFinished);
  $("btnSyncVaultToChat").addEventListener("click", sendReport);
  writeForm(doc.config);
  render();

  return {
    /** Loads the saved vault (call after the Anna host connects, or fails to). */
    async load() {
      let stored = await readStored(STORAGE_KEY);
      let legacy = false;
      if (!stored) {
        stored = await readStored(LEGACY_STORAGE_KEY);
        legacy = Boolean(stored);
      }
      doc = normalizeVaultDoc(stored ? stored.value : null);
      loaded = true;
      if (stored) {
        logLine(
          "vaultConsole",
          legacy ? `[SETUP] Imported your v1.0.1 treasury limits from ${stored.source}. Add a vault address and save.` : `[SETUP] Loaded your vault from ${stored.source}.`,
          "info",
          { keepPlaceholder: !configured() }
        );
      }
      if (formTouched) logLine("vaultConsole", "[SETUP] You edited the form before your saved vault loaded; your edits are kept until you save.", "info", { keepPlaceholder: true });
      else writeForm(doc.config);
      render();
      if (configured()) checkVault();
    },
  };
}
