# AgentKeeper — Onchain AI Agent Vault & Covenant Guard

Autonomous Onchain AI Agent Treasury, Bitcoin Cash CashTokens (CHIP-2022-02) Covenant Validator, ERC-4337 Account Abstraction Simulator, and x402 Micropayment Stream Guard for the Anna AI Operating System.

## Architectural Overview

AgentKeeper brings institutional-grade covenant security to autonomous AI agent fleets operating across EVM and UTXO networks:
- **Bitcoin Cash CashTokens Guard (CHIP-2022-02):** Decodes CashTokens script prefixes, checks token category hashes, and enforces deterministic daily withdrawal allowances (OP_CHECKDATASIGVERIFY).
- **Autonomous Treasury Management:** Enforces rolling 24-hour spending bounds and strictly whitelisted recipient routing to protect treasury capital against prompt injection or rogue agent behaviors.
- **x402 Micropayment Stream Settlement:** Simulates settlement of HTTP 402 payment claims for agent-to-agent inference APIs, with per-claim receipts and nonce-based replay protection.
- **ERC-4337 Account Abstraction Simulation:** Pre-flight UserOp bundler validation and paymaster gas limit enforcement.
- **Deterministic Safety Standards:** Built in compliance with Gerard J. Holzmann's Power of 10 Safety Invariants.

## Simulation Scope

AgentKeeper Studio is a **simulator**. Every check runs locally in the app: nothing is signed or broadcast on-chain, and no funds move. The dashboard is computed live from the same rules the tabs enforce. It counts only what you simulated in the current session (use **Reset simulation** to start over). It never shows historical or on-chain data.

### Which limit applies where

| Dashboard card | Limit | Scope | Enforced in |
|---|---|---|---|
| **BCH Covenant Daily Limit** | 10.00 BCH, rolling 24h | Per agent fleet. Each verified BCH withdrawal uses part of it. | BCH CashTokens Guard tab |
| **Treasury 24h Spend Cap** | $250.00 USDC, rolling 24h, plus $50.00 per transaction (editable) | Per agent, EVM treasury spends only. Separate from the BCH limit. | Autonomous Treasury tab (**Test Spend**) |
| **x402 Settlements** | No cap. Each claim needs a nonce greater than the last settled nonce. | Counts claims settled and rejected in this session. Starts at **0 settled**. | x402 Micropayments tab (**Verify & Settle**) |
| ERC-4337 (no card) | 1,000,000 verification gas | Per UserOperation | ERC-4337 Simulation tab |

## Testing

`tests/e2e.cjs` drives every tab and button in Chromium. It checks that the dashboard always matches what the tabs enforce, checks mobile and minimum window sizes, and runs once more against a mock Anna host to verify the `chat.write_message({ text })` and `storage.get/set` calls.

```bash
npm install
npx playwright install chromium
npm test
```

## Deployment & Verification

```bash
# Validate Anna App Manifest
npx -y @anna-ai/cli validate

# Publish to Anna App Store
npx -y @anna-ai/cli apps publish
```

## Security Invariants

1. All spend operations are bounded by hard ceilings.
2. Monotonic nonce verification prevents replay attacks on x402 micropayment streams.
3. CashTokens state commitments are cryptographically verified before signing.
