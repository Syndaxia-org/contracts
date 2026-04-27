# Syndaxia Protocol — Technical Architecture

This document defines the repository structure, modular design principles, and security standards for Syndaxia, inspired directly by the **Morpho Blue** philosophy.

---

## 1. Repository Structure

```
contracts/
├── solana/
│   ├── Anchor.toml
│   ├── Cargo.toml                  # workspace root
│   ├── programs/
│   │   ├── syndaxia-core/          # The immutable "engine"
│   │   │   └── src/
│   │   │       ├── lib.rs          # Entry point — instruction routing
│   │   │       ├── state/          # Account definitions (Deal, Config)
│   │   │       ├── instructions/   # One file per business domain
│   │   │       │   ├── admin.rs    # Protocol initialization & config
│   │   │       │   ├── market.rs   # Market & validator creation
│   │   │       │   └── deal.rs     # Deal lifecycle: create, release, dispute
│   │   │       ├── libraries/      # Safe math utilities
│   │   │       └── errors.rs       # Centralized error codes
│   │   └── syndaxia-treasury/      # Fee governance (rate + recipient, 7-day timelock)
│   │       └── src/
│   │           ├── lib.rs          # Entry point — governance instructions
│   │           ├── state.rs        # TreasuryConfig account definition
│   │           └── errors.rs       # Error codes
│   └── tests/                      # Integration tests (Anchor/Mocha)
└── tempo/                          # Solidity placeholders (EVM future)
    ├── src/
    │   ├── SyndaxiaEscrow.sol
    │   └── SyndaxiaFactory.sol
    └── foundry.toml
```

---

## 2. Core Design Principles

### A. The Core as a Primitive

Like Morpho Blue, `syndaxia-core` is an **opinionless primitive**.

- It knows nothing about "t-shirts" or "invoices".
- It only understands addresses (Pubkeys), amounts (u64), and signature conditions.
- **Goal:** Remain simple enough to become fully immutable — no upgrade authority required.

### B. Instruction Isolation

Each instruction (e.g., `create_deal`) lives in its own file under `instructions/`.

- Enables faster, more focused audits.
- Avoids business logic entanglement in `lib.rs`.
- Each instruction validates its own account constraints via Anchor macros.

### C. Permissionless Markets

Anyone can create a Syndaxia market by specifying:
1. A **validator** address (the account authorized to resolve disputes).
2. A **fee rate** in BPS.

*Example: A market for local artisans with 2% fees and a local expert as validator.*

This permissionless design extends naturally to **agentic marketplaces** — platforms where AI agents transact autonomously. Any agent runtime can deploy its own market, set its own validator logic (including automated arbitration agents), and define fee rules, without requiring permission from a central authority.

---

## 3. Security Standards

### A. The "Rule of Three" — Account Validation

Every sensitive instruction must verify three things:

1. **Ownership:** Does the account belong to the Syndaxia program?
2. **Signer:** Has the appropriate authority (buyer/seller) signed the transaction?
3. **Relation:** Is the `deal` account correctly linked to the `market` passed as argument?

### B. Arithmetic Safety

All arithmetic uses Rust's checked operations to prevent overflows:

```rust
let total_amount = amount
    .checked_add(fee)
    .ok_or(SyndaxiaError::MathOverflow)?;
```

### C. Treasury Decoupling

`syndaxia-core` reads protocol fee configuration from `syndaxia-treasury` via **raw byte deserialization** (not CPI). This means:
- A treasury program upgrade cannot break the Core's layout assumptions.
- The Core can remain immutable even as governance parameters evolve.

---

## 4. Deal State Machine

The protocol guarantees no financial deadlock is possible:

```
AWAITING_FUNDS ──deposit()──────────► LOCKED
LOCKED         ──release()───────────► RELEASED   (funds → seller)
LOCKED         ──refund()────────────► REFUNDED   (funds → buyer)
LOCKED         ──dispute()───────────► DISPUTED
DISPUTED       ──resolve_dispute()───► RELEASED   (validator splits)
LOCKED         ──expire_deal()───────► REFUNDED   (permissionless, after timeout)
```

All state transitions are terminal — a closed deal account cannot be reopened.

---

## 5. Governance Workflow

The Syndaxia Association uses `admin.rs` to:

- Set the `fee_collector` (the Satflows SAS treasury account).
- Adjust the protocol fee rate (0–20 BPS), subject to a **7-day timelock** enforced by `syndaxia-treasury`.

> **Invariant:** Governance can never access capital locked in deal escrow accounts.

---

## 6. Contribution Guidelines

- **License:** Business Source License 1.1 — all source files must include the SPDX header.
- **Tests:** Minimum 90% coverage on financial flows before any mainnet deployment.
- **Security:** Report vulnerabilities at [security@syndaxia.org](mailto:security@syndaxia.org) — see [syndaxia.org/security](https://syndaxia.org/security).

---

*This document is the source of truth for Syndaxia protocol development.*
