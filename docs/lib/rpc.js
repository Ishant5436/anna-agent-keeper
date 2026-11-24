/**
 * Live reads from Base over its public JSON-RPC endpoints.
 *
 * Uses only calls the public endpoints serve (eth_getLogs is refused or
 * limited to 200 blocks there, so it is not used): blocks, balances at a
 * given block, and transaction receipts.
 */

import { DAY_MS, NETWORKS, matchTransferInReceipt, assessOutflow } from "./vault.js";

let rpcId = 0;

export async function rpcCall(net, method, params = [], { timeoutMs = 15000 } = {}) {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(net.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      signal: ctrl?.signal,
    });
    if (!res.ok) throw new Error(`${net.shortLabel} RPC returned HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(`${net.shortLabel} RPC: ${body.error.message || "error"}`);
    return body.result;
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error(`${net.shortLabel} RPC timed out`);
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const hex = (n) => `0x${n.toString(16)}`;

async function getBlock(net, tag) {
  const b = await rpcCall(net, "eth_getBlockByNumber", [typeof tag === "number" ? hex(tag) : tag, false]);
  if (!b) throw new Error(`${net.shortLabel} RPC returned no block for ${tag}`);
  return { number: Number(BigInt(b.number)), timestamp: Number(BigInt(b.timestamp)) };
}

async function usdcBalanceMicro(net, address, blockNumber) {
  const data = `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}`; // balanceOf(address)
  const result = await rpcCall(net, "eth_call", [{ to: net.usdc, data }, hex(blockNumber)]);
  return Number(BigInt(result));
}

/** Finds the block closest to targetSec using the chain's own timestamps. */
export async function blockAtTime(net, latest, targetSec) {
  const probeGap = Math.min(10000, latest.number);
  const probe = await getBlock(net, latest.number - probeGap);
  const secPerBlock = Math.max((latest.timestamp - probe.timestamp) / probeGap, 0.01);
  let n = Math.max(0, latest.number - Math.round((latest.timestamp - targetSec) / secPerBlock));
  let b = await getBlock(net, n);
  // One correction step absorbs block-time drift.
  n = Math.max(0, Math.min(latest.number, b.number + Math.round((targetSec - b.timestamp) / secPerBlock)));
  if (n !== b.number) b = await getBlock(net, n);
  return b;
}

/** Reads the vault's balances now and 24h ago, and checks for unapproved outflow. */
export async function monitorVault(cfg, requests) {
  const net = NETWORKS[cfg.network];
  const vaultAddress = cfg.vaultAddress;
  const latest = await getBlock(net, "latest");
  const usdcNow = await usdcBalanceMicro(net, vaultAddress, latest.number);
  const ethWei = BigInt(await rpcCall(net, "eth_getBalance", [vaultAddress, hex(latest.number)]));
  const then = await blockAtTime(net, latest, latest.timestamp - DAY_MS / 1000);
  const usdcThen = await usdcBalanceMicro(net, vaultAddress, then.number);
  const assessment = assessOutflow({ balanceNowMicro: usdcNow, balanceThenMicro: usdcThen, thenBlock: then.number, requests, cfg });
  return { latest, then, usdcNow, usdcThen, ethWei, ...assessment };
}

/** Fetches a receipt and checks it contains the request's approved transfer. */
export async function verifyPayment(request, txHash) {
  const net = NETWORKS[request.network];
  const receipt = await rpcCall(net, "eth_getTransactionReceipt", [txHash]);
  return matchTransferInReceipt(receipt, { usdc: net.usdc, from: request.vault, to: request.recipient, amountMicro: request.amountMicro });
}

export function formatEth(wei) {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, 6);
  return `${whole}.${frac}`;
}
