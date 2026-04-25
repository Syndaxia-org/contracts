# Syndaxia Protocol — Smart Contract Reference

> Decentralized escrow with a flexible, capped protocol fee mechanism.

**Program ID (mainnet):** `ACFJxibNyTnVJVNTaYgBSi5YoFK3qy3xPqvmVmKynAC1`  
**Framework:** Anchor 0.32.0  
**Network:** Solana  
**License:** BUSL-1.1 — commercial rights: Satflows SAS / governance: Syndaxia Association

---

## 1. Fee Architecture — Dual Rail

Syndaxia separates fees into two distinct categories.

### A. Protocol Fee — Capped at 20 BPS

| Parameter | Value |
|---|---|
| Hard cap | **20 BPS (0.20%)** — immutably encoded in the Core |
| Launch rate | **5 BPS (0.05%)** |
| Governance | Syndaxia Association via `syndaxia-treasury` (7-day timelock) |
| Recipient | `syndaxia-treasury` PDA |

The cap is enforced on-chain and cannot be overridden by any upgrade or governance action.

### B. Marketeer Fee — Variable

| Parameter | Value |
|---|---|
| Amount | Freely set by the integrator (e.g., Syndaxia Pay / Satflows) via `fee_bps` |
| Hard cap | **1,000 BPS (10%)** |
| Recipient | `fee_collector` address defined at deal creation |

---

## 2. Fee Calculation

Fees are calculated in **basis points (BPS)**:
- 1 BPS = 0.01%
- 10,000 BPS = 100%

```
marketeer_fee = amount × fee_bps          / 10_000
protocol_fee  = amount × protocol_fee_bps / 10_000
```

Both fees are deducted **at deposit time**. On refund, the buyer recovers the principal (`amount`) only — fees already paid to collectors are non-refundable.

---

## 3. Deal Lifecycle

```
[Draft] ──initialize_deal()──► [AwaitingFunds]
[AwaitingFunds] ──deposit()──► [Locked]
[Locked] ──release()──────────► [Released]   funds → seller (or assignee)
[Locked] ──refund()───────────► [Refunded]   funds → buyer
[Locked] ──dispute()──────────► [Disputed]
[Disputed] ──resolve_dispute()─► [Released]  validator splits funds arbitrarily
[Locked] ──expire_deal()──────► [Refunded]   permissionless after timeout
```

At close (release / refund / expiry), the escrow PDA account is **closed** and the rent SOL is returned to the buyer.

---

## 4. Account Structure

### Escrow PDA
```
seeds: ["escrow", deal_pubkey]
```

Holds the buyer's funds in custody until a terminal instruction is executed. No admin account has authority over this PDA — only the program code can transfer out.

### Deal Account
All deal parameters are **immutable at creation**:
- Buyer, seller, validator addresses
- Amount, `fee_bps`, `fee_collector`
- Expiry timestamp
- `metadata_hash` (SHA-256 linking the on-chain deal to off-chain legal documents)

### Protocol Config (read from treasury)
The Core reads the current `protocol_fee_bps` by deserializing the treasury PDA bytes directly (no CPI dependency), eliminating layout mismatch risk on upgrades.

---

## 5. Security Design

| Property | Mechanism |
|---|---|
| Immutable fee cap | 20 BPS ceiling enforced in Core code, not config |
| No admin access to escrow | Only `release()`, `refund()`, `resolve_dispute()`, `expire_deal()` can move funds |
| Marketeer fee locked at creation | `fee_collector` sealed in the Deal account at init |
| Treasury decoupling | Core reads treasury via raw byte deserialization (no CPI) |
| Arithmetic safety | All arithmetic uses checked Rust operations (`checked_mul`, `checked_div`) |

The **No-Admin Policy** — the absence of any privileged account that can freeze escrows or alter release logic — is equally critical for agentic use cases: an AI agent computing its ROI in milliseconds cannot account for arbitrary human intervention in the settlement layer.

---

## 6. Metadata & Proof of Work

The `metadata_hash` field (SHA-256) cryptographically links the on-chain deal to its real-world counterpart:

- **Human commerce:** an invoice, service contract, or delivery confirmation.
- **Agentic commerce:** the hash of a produced output — a dataset, an oracle response, or a computed result. The `release()` instruction is conditioned on the technical validation of this proof, enabling fully automated settlement cycles with no human dispute required.

This makes `metadata_hash` the bridge between off-chain work and on-chain payment, regardless of whether the counterparties are humans or autonomous agents.

---

*Syndaxia Core: the security of a vault, the flexibility of modern software.*
