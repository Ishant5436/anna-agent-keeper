# AgentKeeper — Onchain AI Agent Vault & Covenant Guard

A non-custodial spend guard for AI agents that pay in USDC on Base, built as an Anna AI OS app. You set the rules and approve what needs approving. You send each payment from your own wallet, and AgentKeeper confirms it on-chain and watches the vault for anything you did not approve.

**Version:** 1.0.2 · **App slug:** `agent-keeper-vault` · **Live demo:** https://ishant5436.github.io/anna-agent-keeper/

## What is live and what is simulated

| Feature | Status | What actually happens |
|---|---|---|
| **Agent Vault**: policy and setup | **Live** | Vault address, network, caps, approval threshold and whitelist are saved in Anna storage (or the browser outside Anna). |
| **Spend Requests**: guard decisions | **Live** | Each request is approved, held for your approval, or blocked against the saved policy and a rolling 24-hour total that survives reloads. |
| **Paying an approved request** | **Live, in your wallet** | The app shows the exact USDC transfer (wallet link, contract, calldata). You sign and send it yourself. AgentKeeper holds no keys. |
| **On-chain confirmation** | **Live** | Reads the transaction receipt from Base and confirms the exact amount, sender (your vault) and recipient. |
| **Live monitor** | **Live** | Reads the vault's USDC and ETH balances now and 24 hours ago from Base, and alerts you to outflows beyond your confirmed payments. |
| **Vault report to Anna chat** | **Live** | Posts the policy, last check and open requests to your Anna chat. |
| **BCH CashTokens Guard** | **Simulated** covenant | The 10 BCH per-fleet daily limit is simulated per session. The **token prefix is real CHIP-2022-02 encoding**, checked against the spec's official test vectors. Nothing is broadcast on BCH. |
| **x402 Micropayments** | **Simulated** | Claim settlement with nonce replay protection. Signatures are not checked; no payment moves. |
| **ERC-4337** | **Simulated** | Local UserOperation pre-flight checks. Nothing is sent to a bundler. |

Every tab and dashboard card in the app carries a **LIVE** or **SIMULATED** tag.

### Limits

- AgentKeeper cannot stop a wallet from signing a transaction. The protection comes from your approvals and the outflow monitor, which detects what you did not approve.
- The monitor compares net balances, so incoming funds can hide outgoing ones. A clean result is a lower bound.
- Live features use Base's public RPC endpoints, which are rate-limited.

## The core flow

1. **Set up the vault** (Agent Vault tab). Choose Base Sepolia (testnet) or Base Mainnet. Enter the vault address your agent spends from, a per-transaction cap, a rolling 24-hour cap, an approval threshold, and the recipient whitelist. Then click **Save vault**.
2. **Check the vault.** The live monitor reads the real USDC and ETH balances and the 24-hour net change.
3. **Submit a spend request** (Spend Requests tab). The guard decides:
   - **Approved automatically:** within all caps, and at or below the approval threshold.
   - **Awaiting approval:** within all caps, but above the threshold. You click **Approve** or **Deny**.
   - **Blocked:** the recipient is not whitelisted, or the payment would exceed the per-transaction or rolling 24-hour cap.
4. **Pay** from your own wallet, using the transfer details shown on the approved request.
5. **Confirm on-chain.** Paste the transaction hash. AgentKeeper checks the receipt and marks the request **Confirmed on-chain**. A wrong amount, sender or recipient, or a failed transaction, is refused. An unmined transaction can be re-checked.
6. **Watch for outflows.** **Check vault now** flags any USDC that left the vault in the last 24 hours without a confirmed approval.

To try it with no real funds, use Base Sepolia and testnet USDC from a faucet.

## Which limit applies where

| Dashboard card | Limit | Scope | Enforced in |
|---|---|---|---|
| **Agent Vault** (live) | None. Shows the real USDC balance and outflow alerts. | The saved vault address | Agent Vault |
| **Spend Guard 24h Cap** (live) | 250 USDC rolling 24h, 50 USDC per transaction, approval above 25 USDC (defaults, editable) | Per vault. Counts pending, approved and confirmed payments. | Spend Requests |
| **BCH Covenant Daily Limit** (simulated) | 10.00 BCH rolling 24h | Per agent fleet, this session | BCH CashTokens |
| **x402 Settlements** (simulated) | No amount cap; nonce must exceed the last settled one | This session | x402 |
| ERC-4337 (no card, simulated) | 1,000,000 verification gas | Per UserOperation | ERC-4337 |

## Networks

| Network | Chain ID | USDC contract | RPC |
|---|---|---|---|
| Base Sepolia (testnet, default) | 84532 | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `https://sepolia.base.org` |
| Base Mainnet | 8453 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `https://mainnet.base.org` |

Both contract addresses were checked on-chain (symbol `USDC`, 6 decimals). Both RPC origins are declared in `manifest.json`.

## Repository layout

| Path | Purpose |
|---|---|
| `bundle/` | The app that Anna loads. `vault-ui.js` is the live vault UI; `app.js` holds the simulated tabs and wiring. |
| `bundle/lib/vault.js` | Pure vault logic: policy, rolling ledger, transfer encoding, receipt matching, outflow check. |
| `bundle/lib/rpc.js` | Live reads from Base: blocks, balances at a block, receipts. |
| `bundle/lib/cashtokens.js` | CHIP-2022-02 token-prefix encoding. |
| `docs/` | Identical copy of `bundle/`, served by GitHub Pages as the live demo. |
| `manifest.json`, `app.json` | Anna app manifest and store listing. |
| `tests/` | Unit, end-to-end and live tests, plus the official CashTokens test vectors. |

After editing `bundle/`, copy it to `docs/` (the end-to-end test fails if they differ):

```bash
rm -rf docs && cp -r bundle docs
```

## Run locally

```bash
python3 -m http.server 8080 --directory bundle
```

Then open http://localhost:8080. The app must be served over HTTP; opening `index.html` as a file will not load the scripts.

## Testing

```bash
npm install
```

```bash
npx playwright install chromium
```

```bash
npm test
```

- `tests/unit.mjs` covers the vault policy and rolling cap, transfer encoding, receipt matching and the outflow check. It also checks the CashTokens encoder against all 62 official CHIP-2022-02 vectors.
- `tests/e2e.cjs` drives every tab and button in Chromium against a mock Base chain. It covers the full request lifecycle (including wrong, failed and unmined transactions), outflow alerts, persistence, mobile layout, Anna's minimum window size, the Anna host chat and storage calls, and migration of v1.0.1 settings.
- `tests/live.cjs` runs the core flow against the **real Base Sepolia testnet**. It finds a recent real USDC transfer, saves its sender as the vault, submits and approves a matching request, and confirms the real transaction on-chain through the app's UI. It needs network access:

```bash
node tests/live.cjs
```

## Validate and publish

Run these from the repository root:

```bash
npx -y @anna-ai/cli validate
```

```bash
npx -y @anna-ai/cli apps publish
```

## Changelog

### 1.0.2

- **Live core flow:** vault policy saved in Anna storage, spend requests with automatic approval, human approval or blocking, an exact USDC transfer for the user's own wallet, on-chain confirmation from the receipt, and a 24-hour outflow monitor.
- Every tab and card is tagged LIVE or SIMULATED.
- The BCH tab now shows a real CHIP-2022-02 token prefix, checked against the spec's official test vectors.
- The Autonomous Treasury tab became Agent Vault and Spend Requests. v1.0.1 treasury limits are imported automatically.
- Removed the header network selector; the vault's network setting replaces it.
- Anna's agent is no longer told it can operate the app.
- Added unit tests and a live test against Base Sepolia.

### 1.0.1

- The dashboard now shows the limits the tabs enforce, each labelled with its scope. It previously showed an unrelated "150.00 BCH".
- x402 settlements are counted from this session and start at 0. The dashboard previously showed "100% Settled".
- Added the simulation notice, **Reset simulation** and the end-to-end test. Fixed **Test Spend**, chat briefs, sub-unit amounts and mobile layouts.
