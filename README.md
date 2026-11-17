# AgentKeeper — Onchain AI Agent Vault & Covenant Guard

An Anna AI OS app for testing the spending rules you would put around an autonomous AI agent's treasury: a Bitcoin Cash CashTokens covenant limit, EVM treasury caps, x402 micropayment replay protection, and ERC-4337 gas bounds.

**Version:** 1.0.1 · **App slug:** `agent-keeper-vault` · **Live demo:** https://ishant5436.github.io/anna-agent-keeper/

## It is a simulator

AgentKeeper Studio runs every check locally in the app. Nothing is signed or broadcast on-chain, no funds move, and there is no RPC connection.

The dashboard is computed live from the same rules the tabs enforce. It counts only what you simulated in the current session, and **Reset simulation** clears it. It never shows historical or on-chain data.

## What each tab does

| Tab | What it checks |
|---|---|
| **BCH CashTokens Guard** | Validates a CashTokens (CHIP-2022-02) withdrawal request: category ID format, token amount range, NFT commitment format, and the covenant's daily BCH limit. |
| **Autonomous Treasury** | Holds an agent's EVM spend policy. **Test Spend** dry-runs a USDC spend against the per-transaction cap, the rolling 24h cap and the recipient whitelist. |
| **x402 Micropayments** | Verifies an HTTP 402 payment claim. A claim settles only if its nonce is higher than the last one, so a replayed nonce is rejected. Signatures are not checked. |
| **ERC-4337 Simulation** | Pre-flight checks on a UserOperation: sender address, calldata format, and a verification gas bound. Nothing is sent to a bundler. |
| **Telemetry & Chat Sync** | One audit log of every check, approval and rejection in the session. |

## Which limit applies where

| Dashboard card | Limit | Scope | Enforced in |
|---|---|---|---|
| **BCH Covenant Daily Limit** | 10.00 BCH, rolling 24h | Per agent fleet. Each verified BCH withdrawal uses part of it. | BCH CashTokens Guard |
| **Treasury 24h Spend Cap** | $250.00 USDC rolling 24h, plus $50.00 per transaction. Both are editable. | Per agent, EVM treasury spends only. Separate from the BCH limit. | Autonomous Treasury (**Test Spend**) |
| **x402 Settlements** | No amount cap. Each claim needs a nonce above the last settled one (the starting floor is 10001). | Counts claims settled and rejected in this session. Starts at **0 settled**. | x402 Micropayments (**Verify & Settle**) |
| ERC-4337 (no card) | 1,000,000 verification gas | Per UserOperation | ERC-4337 Simulation |

Amounts smaller than one unit are rejected: 1 satoshi (0.00000001 BCH) and 0.000001 USDC.

## Anna integration

- **Send to Anna Chat** posts a brief of the last real result (verified, blocked, rejected, or not run) to the active chat. Outside Anna it copies the brief to the clipboard.
- **Save Treasury Limits** stores the treasury policy in Anna storage and loads it on the next start. Outside Anna it uses the browser's local storage.
- Opened outside Anna (for example the live demo), the app shows **Standalone Mode** and everything else works the same.

## Repository layout

| Path | Purpose |
|---|---|
| `bundle/` | The app that Anna loads: `index.html`, `app.js`, `style.css`. |
| `docs/` | An identical copy of `bundle/`, served by GitHub Pages as the live demo. |
| `manifest.json`, `app.json` | Anna app manifest and store listing. |
| `assets/` | Logo, cover and store screenshots. |
| `tests/e2e.cjs` | End-to-end browser test. |

All limits live in one `POLICY` object at the top of `bundle/app.js`. Change a limit there and the dashboard, hints and messages follow.

After editing `bundle/`, copy it to `docs/` (the test fails if they differ):

```bash
cp bundle/* docs/
```

## Run locally

```bash
python3 -m http.server 8080 --directory bundle
```

Then open http://localhost:8080. The app must be served over HTTP; opening `index.html` as a file will not load the script.

## Testing

`tests/e2e.cjs` clicks every button on every tab in Chromium (96 checks). After each step it checks that the dashboard matches what the tab enforces. It also covers mobile and Anna's minimum window size, and runs once more against a mock Anna host to verify the chat and storage calls.

```bash
npm install
```

```bash
npx playwright install chromium
```

```bash
npm test
```

## Validate and publish

Run these from the repository root:

```bash
npx -y @anna-ai/cli validate
```

```bash
npx -y @anna-ai/cli apps publish
```

## Rules the simulator enforces

1. Every spend check has a fixed ceiling, and a blocked or rejected request never counts as used.
2. An x402 claim settles only with a nonce above the last settled one.
3. Every input is validated before a result is shown, and a result is reported only for a check that actually ran.

## Changelog

### 1.0.1

- The dashboard now shows the limits the tabs enforce (BCH 10.00 per agent fleet, treasury $250.00 per 24h), each labelled with its scope. It previously showed an unrelated "150.00 BCH".
- x402 settlements are counted from this session and start at 0. The dashboard previously showed "100% Settled".
- Added the simulation notice and **Reset simulation**.
- **Test Spend** now works, and saved treasury limits load on start.
- Chat briefs report the real last result, and the chat call uses the field the Anna host expects.
- Amounts below the smallest unit are rejected.
- Fixed mobile and small-window layouts.
- Added the end-to-end test.
