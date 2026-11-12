# DoraHacks BUIDL Submission: AgentKeeper Vault & Covenant Guard for Anna AI OS

**Hackathon Portal:** [Anna AI App Builder Program on DoraHacks](https://dorahacks.io/hackathon/anna-ai-app-builder-program/detail)  
**Program Pool:** Up to $80,000 USD Monthly Builder Grants (up to $6,000 launch boost per app)  
**Target Category:** Developer Tools / Multi-Chain Treasury & Web3 Security  
**Submission Timeline:** Extended 3 Months (Active through February 2027)  
**Developer:** Ishant Panchal (`Ishant5436` / `ishant.p@somaiya.edu` / Mumbai, India)  
**App Name:** `AgentKeeper - Onchain AI Agent Vault & Covenant Guard`  
**App Slug on Anna OS:** `agent-keeper-vault` (App ID `889`, Category `developer-tools`)  
**Repository:** [https://github.com/Ishant5436/anna-agent-keeper](https://github.com/Ishant5436/anna-agent-keeper)  
**Live Interactive Demo:** [https://ishant5436.github.io/anna-agent-keeper/](https://ishant5436.github.io/anna-agent-keeper/)  
**License:** Permissive open-source MIT License  

---

## 1. Project Overview & Tagline
* **App Slug:** `agent-keeper-vault`
* **Tagline:** `Autonomous AI Agent Multi-Chain Treasury Vault, BCH CashTokens Covenant & x402 Payment Guard`

---

## 2. Problem Statement
Autonomous AI agents operating across decentralized finance and API gateways face catastrophic risk: prompt injection, unconstrained tool invocation, and rogue contract routing can completely drain onchain treasuries in a single block.

Traditional wallets and basic multisigs lack the capability to:
1. Enforce fine-grained deterministic daily spend limits per subagent or autonomous fleet.
2. Validate UTXO covenant scripts (such as Bitcoin Cash CHIP-2022-02 CashTokens) to ensure token commitments and allowances are mathematically enforced onchain.
3. Verify and settle high-frequency x402 HTTP micropayment streams without replay vulnerabilities.
4. Pre-simulate ERC-4337 UserOperations inside the agent runtime before broadcasting gas-intensive transactions.

---

## 3. The Solution: AgentKeeper on Anna AI OS
AgentKeeper provides a Cyber-OLED HUD interface and autonomous guardrail engine embedded directly into Anna AI OS:
1. **BCH CashTokens Covenant Guard (CHIP-2022-02):** Decodes CashTokens script prefixes, checks 32-byte category hashes, and validates NFT state commitments alongside daily withdrawal ceilings.
2. **Autonomous Fleet Treasury:** Role-based access control and rolling 24-hour spending caps with whitelisted recipient enforcement.
3. **x402 Micropayment Stream Settlement:** High-throughput streaming settlement engine for automated agent-to-agent inference APIs with cryptographic receipt proofs and replay protection.
4. **ERC-4337 Account Abstraction Simulation:** Pre-flight UserOp bundler validation and paymaster gas limit enforcement.
5. **Anna Chat Integration:** Dispatches structured security intelligence briefs directly into active Anna chat threads with one click.
6. **Deterministic Safety Invariants:** Engineered under Gerard J. Holzmann's Power of 10 Safety Invariants with bounded loops, zero dynamic allocation on critical paths, and verified return values.

---

## 4. Technical Architecture & Tech Stack
* **Runtime:** Anna AI OS Host API (`chat`, `storage`, `llm`, `window`) + Static SPA Bundle.
* **UI Layer:** Cyber-OLED theme, pure native CSS/JS without CDN bloat for instant zero-latency rendering.
* **Covenant Engine:** Bitcoin Cash CashTokens CHIP-2022-02 prefix parser, SHA-256 state hashing, and deterministic spend quota counters.
* **Multi-Chain Coverage:** Base Mainnet (8453), Circle Arc (5042), Bitcoin Cash (Chipnet/Mainnet), Somnia Shannon (50312), and CreditCoin 3.0.

---

## 5. Verification & Testing Evidence
* **Schema Validation:** `npx -y @anna-ai/cli validate` passes with zero warnings.
* **App Store State:** Staged, snapshot version 1.0.0 cut, and submitted for review on `https://anna.partners` under App ID `889`.
* **Zero Secrets Invariant:** Clean repository with strict key hygiene and no sensitive environment variables.
