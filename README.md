# Syndaxia Protocol — Contracts

Syndaxia is a **multi-chain, non-custodial escrow protocol** for P2P and B2B commerce. Funds are held in autonomous, immutable contracts — no admin, no upgrades, no custody.

The protocol runs on two independent chains:

| Chain | Version | Status | Framework |
|-------|---------|--------|-----------|
| **Solana** | v1 | Production (mainnet) | Anchor / Rust |
| **Tempo** | v2 | Testnet (Moderato) | Foundry / Solidity |

Both chains share the same core protocol semantics (deal lifecycle, fees, milestones, disputes) with adaptations specific to each execution model.

---

## Repository Structure

```
contracts/
├── solana/                        ← v1 — Solana Anchor programs
│   └── programs/
│       ├── syndaxia-core/         ← Escrow lifecycle (create, release, dispute…)
│       └── syndaxia-treasury/     ← Protocol fee governance (7-day timelock)
│
├── tempo/                         ← v2 — Tempo EVM contracts (Foundry)
│   └── src/
│       ├── SyndaxiaEscrow.sol     ← Immutable escrow instance (1 per deal)
│       ├── SyndaxiaFactory.sol    ← Deploys escrows, collects protocol fee
│       ├── SyndaxiaGovernance.sol ← Protocol fee governance (7-day timelock)
│       └── interfaces/
│           └── ITIP20.sol         ← TIP-20 + transferWithMemo interface
│
└── docs/
    ├── protocol.md                ← Solana protocol reference
    ├── architecture.md            ← Solana architecture guide
    ├── tempo/
    │   ├── protocol.md            ← Tempo protocol reference
    │   └── architecture.md        ← Tempo architecture guide
    ├── whitepaper.md
    └── SECURITY_AUDIT.md
```

---

## Solana v1

### Overview

Two Anchor programs cooperate at runtime:

- **`syndaxia-core`** — manages the full escrow lifecycle: deal creation, release, refund, milestones, dispute resolution, and expiry. The protocol fee cap (20 BPS) is hardcoded in this program.
- **`syndaxia-treasury`** — governs the active protocol fee rate and its receiver, with a mandatory 7-day timelock on every change.

### Deployed Programs

| Program | Program ID (mainnet) | Verification |
|---------|---------------------|--------------|
| `syndaxia-core` | `ACFJxibNyTnVJVNTaYgBSi5YoFK3qy3xPqvmVmKynAC1` | [![Verified](https://verify.osec.io/badge/ACFJxibNyTnVJVNTaYgBSi5YoFK3qy3xPqvmVmKynAC1)](https://verify.osec.io/status/ACFJxibNyTnVJVNTaYgBSi5YoFK3qy3xPqvmVmKynAC1) |
| `syndaxia-treasury` | `DvoZj1cKMi8DEvTxBgNEnj9Fhxx9PRAsVTEWEZ2e6YHx` | [![Verified](https://verify.osec.io/badge/DvoZj1cKMi8DEvTxBgNEnj9Fhxx9PRAsVTEWEZ2e6YHx)](https://verify.osec.io/status/DvoZj1cKMi8DEvTxBgNEnj9Fhxx9PRAsVTEWEZ2e6YHx) |

Both programs are **verified on-chain** via [OtterSec](https://osec.io) — source at commit [`ef22d9d`](https://github.com/Syndaxia-org/contracts/tree/ef22d9d8d5e431ea1225405393f52dd3c60f18f3) matches the deployed bytecode exactly.

**Framework:** Anchor 0.32.0 · **Network:** Solana mainnet

### Build & Test (Solana)

Requirements: Anchor ≥ 0.32.0, Rust ≥ 1.70, Node.js ≥ 18

```bash
cd solana
anchor build   # compile both programs
anchor test    # integration tests against local validator
```

---

## Tempo v2

### Overview

The Tempo chain is an EVM-compatible payments-first blockchain with native fee sponsorship, TIP-20 stablecoins, and the Machine Payments Protocol (MPP) for AI agent commerce. See [`docs/tempo/protocol.md`](./docs/tempo/protocol.md) for the full protocol reference.

Three contracts form the Tempo protocol:

- **`SyndaxiaEscrow`** — immutable, single-use escrow. One instance per deal, deployed by the Factory. All parameters are fixed at construction as `immutable` variables (zero storage cost on Tempo).
- **`SyndaxiaFactory`** — the permanent entry point. Buyers call `createEscrow()`, which atomically pulls funds, deploys a fresh `SyndaxiaEscrow`, and distributes fees.
- **`SyndaxiaGovernance`** — timelocked governance for protocol fee rate and receiver, mirroring `syndaxia-treasury`. Every change requires a 7-day on-chain delay.

### Key Differences from Solana v1

| Feature | Solana v1 | Tempo v2 |
|---------|-----------|----------|
| Execution model | sBPF / Anchor (Rust) | EVM / Solidity |
| Deal creation | 2-step: `initialize_deal` + `deposit` | Atomic: `createEscrow` (Factory) |
| Governance | Separate `syndaxia-treasury` program | `SyndaxiaGovernance.sol` |
| Fee governance timelock | 7 days | 7 days (identical) |
| Payment token | SPL tokens | TIP-20 (IERC20-compatible) |
| Beneficiary transfer | `transfer_beneficiary` | `transferBeneficiary` |
| Native value | SOL (rent) | None — BALANCE always 0 on Tempo |
| Storage model | Anchor PDAs (account rent) | `immutable` vars (bytecode, free) |
| Payment memo | N/A | `transferWithMemo(to, amount, dealId)` |
| MPP integration | N/A | Native (Machine Payments Protocol) |

### Deployed Contracts (Moderato Testnet — chain ID 42431)

| Contract | Address | Verification |
|----------|---------|--------------|
| `SyndaxiaFactory` | `0x1A33A7eDC2Ae59a92E0D955dD8100751Be99D36D` | [contracts.tempo.xyz](https://contracts.tempo.xyz) — exact_match |
| `SyndaxiaGovernance` | TBD (pending deployment) | — |

Mainnet deployment is planned following audit and testnet validation.

### Build & Test (Tempo)

Requirements: [Foundry nightly](https://github.com/foundry-rs/foundry) (`foundryup --nightly`), Solidity 0.8.24

```bash
cd tempo
forge build         # compile all contracts
forge test -vvv     # run test suite
```

Deployment to Moderato testnet:

```bash
export PRIVATE_KEY=0x...
export GOVERNANCE=0x...
export PROTOCOL_FEE_RECEIVER=0x...
export PROTOCOL_FEE_BPS=10

forge script script/Deploy.s.sol --rpc-url moderato --broadcast
```

---

## Protocol Invariants (both chains)

| Invariant | Description |
|-----------|-------------|
| **Fee cap** | Protocol fee hardcoded ≤ 20 BPS on both chains — not overridable by governance |
| **No admin access to escrow** | Only deal parties can move funds; no privileged account can freeze or drain |
| **Immutable parameters** | All deal parameters set at creation cannot be changed |
| **Timelocked governance** | Any protocol parameter change requires a 7-day on-chain delay |
| **No-admin policy** | Critical for AI agent commerce: no human can arbitrarily intervene in settlement |

---

## Governance & Licensing

Syndaxia is governed by the **Syndaxia Association** (French non-profit) with commercial rights held by **Satflows SAS**.

- **License:** BUSL-1.1 — Change Date 2029-01-01, Change License Apache 2.0
- **Governance token:** $SDX — voting rights and fee reduction
- **Security contact:** security@syndaxia.org

## Security

See [`SECURITY.md`](./SECURITY.md) and [`docs/SECURITY_AUDIT.md`](./docs/SECURITY_AUDIT.md).

## Additional Resources

- [Tempo Protocol Reference](./docs/tempo/protocol.md)
- [Solana Protocol Reference](./docs/protocol.md)
- [Architecture Guide](./docs/architecture.md)
- [Whitepaper](./docs/whitepaper.md)
- [Syndaxia Association](https://syndaxia.org)
