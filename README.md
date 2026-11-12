# AgentKeeper — Onchain AI Agent Vault & Covenant Guard

Autonomous Onchain AI Agent Treasury, Bitcoin Cash CashTokens (CHIP-2022-02) Covenant Validator, ERC-4337 Account Abstraction Simulator, and x402 Micropayment Stream Guard for the Anna AI Operating System.

## Architectural Overview

AgentKeeper brings institutional-grade covenant security to autonomous AI agent fleets operating across EVM and UTXO networks:
- **Bitcoin Cash CashTokens Guard (CHIP-2022-02):** Decodes CashTokens script prefixes, checks token category hashes, and enforces deterministic daily withdrawal allowances (OP_CHECKDATASIGVERIFY).
- **Autonomous Treasury Management:** Enforces rolling 24-hour spending bounds and strictly whitelisted recipient routing to protect treasury capital against prompt injection or rogue agent behaviors.
- **x402 Micropayment Stream Settlement:** High-throughput streaming settlement engine for automated agent-to-agent inference APIs with cryptographic receipt proofs and replay protection.
- **ERC-4337 Account Abstraction Simulation:** Pre-flight UserOp bundler validation and paymaster gas limit enforcement.
- **Deterministic Safety Standards:** Built in compliance with Gerard J. Holzmann's Power of 10 Safety Invariants.

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
