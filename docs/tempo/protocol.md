# Syndaxia Protocol — Tempo v2 Reference

> Multi-chain immutable escrow — EVM implementation on Tempo blockchain.

**Chain:** Tempo (EVM, chain ID 4217 mainnet / 42431 Moderato testnet)  
**Framework:** Foundry · Solidity 0.8.24  
**License:** BUSL-1.1 — commercial rights: Satflows SAS / governance: Syndaxia Association

For the Solana v1 reference, see [`../protocol.md`](../protocol.md).

---

## 1. Architecture Overview

The Tempo implementation uses the **Factory pattern** (inspired by Morpho): one permanent Factory contract deploys an independent, immutable `SyndaxiaEscrow` per deal. A separate `SyndaxiaGovernance` contract controls protocol parameters with a 7-day timelock.

```
SyndaxiaGovernance  ──setProtocolFee()──▶  SyndaxiaFactory  ──createEscrow()──▶  SyndaxiaEscrow #N
     (timelock)                               (permanent)                          (1 per deal)
```

### Why immutable variables?

Tempo charges **250,000 gas per new storage slot** (vs ~20,000 on Ethereum). All deal parameters are stored as Solidity `immutable` variables — compiled into bytecode, with zero storage cost. Only 2 mutable storage slots exist per escrow (status + timestamps).

---

## 2. Contracts

### SyndaxiaEscrow

Single-use, immutable escrow holding funds for one deal. Created by the Factory; parameters fixed at construction.

**Immutable parameters (zero storage cost):**

| Variable | Type | Description |
|----------|------|-------------|
| `buyer` | `address` | Funds originator; receives refunds |
| `validator` | `address` | Authorized to release, refund, or arbitrate |
| `feeCollector` | `address` | Receives the marketplace fee |
| `token` | `IERC20` | TIP-20 stablecoin used for settlement |
| `amount` | `uint256` | Principal escrowed (excluding fees) |
| `feeBps` | `uint256` | Marketplace fee in basis points |
| `metadataHash` | `bytes32` | SHA-256 linking deal to off-chain documents |
| `releaseDelay` | `uint256` | Minimum wait before release (seconds) |
| `timeout` | `uint256` | Deal expiry window (seconds) |
| `disputeDelay` | `uint256` | Earliest point a dispute can be opened |
| `milestoneCount` | `uint8` | 0 for single-tranche, 1–8 for milestones |
| `_ms0`…`_ms7` | `uint256` | Individual milestone amounts |
| `createdAt` | `uint256` | Block timestamp at construction |

**Mutable state (2 slots):**

| Variable | Description |
|----------|-------------|
| `beneficiary` | Current payee — can be transferred (factoring) |
| `status` | `Open / Released / Refunded / Disputed` |
| `releasedMask` | Bitmask of released milestones |
| `disputeExtensionsRemaining` | Remaining validator extensions |
| `disputedAt` | Timestamp when dispute was opened |
| `disputeResolutionWindow` | Duration of dispute resolution period |

### SyndaxiaFactory

Permanent entry point. Manages protocol fee parameters (mutable, governance-controlled) and deploys escrow instances.

**Key constant:**
```solidity
uint256 public constant MAX_PROTOCOL_FEE_BPS = 20; // 0.20% — hardcoded ceiling
```

**`createEscrow()` flow:**
1. Pull `amount + marketerFee + protocolFee` from buyer via `transferFrom`
2. Deploy new `SyndaxiaEscrow` with all parameters
3. Transfer `protocolFee` → `protocolFeeReceiver`
4. Transfer `marketerFee` → `feeCollector`
5. Transfer `amount` → escrow contract

### SyndaxiaGovernance

Timelocked governance for Factory protocol parameters. Mirrors `syndaxia-treasury` (Solana). Every change follows a propose → wait 7 days → apply (permissionless) pattern.

**Governs:**
- Protocol fee rate (`proposeFeeChange` / `applyFeeChange`)
- Protocol fee receiver (`proposeReceiverChange` / `applyReceiverChange`)
- Admin rotation (`proposeAdminChange` / `applyAdminChange`)

---

## 3. Fee Architecture — Dual Rail

Identical to Solana v1. Fees are calculated in basis points (1 BPS = 0.01%).

### Marketplace Fee (`feeBps`)
- Set by each marketplace at deal creation
- Hard cap: **1,000 BPS (10%)**
- Recipient: `feeCollector` address (fixed at deal creation)
- Non-refundable at escrow close

### Protocol Fee (`protocolFeeBps`)
- Governed by `SyndaxiaGovernance` with 7-day timelock
- Hard cap: **20 BPS (0.20%)** — hardcoded in `SyndaxiaFactory.MAX_PROTOCOL_FEE_BPS`
- Launch rate: **10 BPS (0.10%)**
- Recipient: `protocolFeeReceiver` (changeable via governance)

```
totalRequired = amount + (amount × feeBps / 10_000) + (amount × protocolFeeBps / 10_000)
```

---

## 4. Deal Lifecycle

```
Buyer approves Factory for totalRequired
         │
         ▼
Factory.createEscrow() ──► SyndaxiaEscrow deployed (status: Open)
                                    │
         ┌──────────────────────────┼──────────────────────────────────┐
         │                          │                                  │
   release()               dispute() (buyer/seller)             expire()
   releaseMilestone()              │                           (permissionless)
   (buyer or validator)            │                                  │
         │                  resolveDispute()                          │
         │                  (validator only)                          │
         ▼                         │                                  ▼
    [Released]               [Released]                          [Refunded]
         │                    [Refunded]
    seller paid              split paid
```

**Terminal states:** `Released`, `Refunded` — no further transitions possible.

### Single-tranche deal

One `release()` call moves all escrowed funds to `beneficiary`.

### Milestone deal (up to 8)

Each `releaseMilestone(index)` releases one tranche. `releasedMask` tracks completed milestones. The full escrow closes when all milestones are released.

### Expiry logic

- **Open state:** expires at `createdAt + releaseDelay + timeout` → buyer refunded
- **Disputed state:** expires at `disputedAt + disputeResolutionWindow` → buyer refunded (validator SLA missed)

---

## 5. Tempo-Specific Design

### TIP-20 and `transferWithMemo`

All token transfers use the `_transferOut` internal helper, which attempts `transferWithMemo` first (Tempo TIP-20 native) with the escrow address as memo, falling back to standard `transfer()`:

```solidity
bytes32 memo = bytes32(uint256(uint160(address(this))));
try ITIP20(address(token)).transferWithMemo(to, value, memo) returns (bool ok) { ... }
catch { token.transfer(to, value); }
```

The memo enables automatic deal reconciliation on the backend without scanning all token transfers.

### No native value

`msg.value` is always 0 on Tempo. The constructor rejects native value explicitly. Escrow balance is always read via `token.balanceOf(address(this))`.

### Gas optimization

| Pattern | Tempo impact |
|---------|-------------|
| `immutable` variables | Stored in bytecode — free (no 250k gas slot cost) |
| `uint40` for timestamps | Packed with address into single storage slot |
| `uint8` for masks/counts | Packed into slot 0 alongside status |
| 2 mutable slots total | ~500,000 gas saved vs naïve layout |

---

## 6. MPP Integration (Machine Payments Protocol)

Syndaxia Escrow is **complementary** to Tempo's MPP, not in competition:

| Use case | Mechanism |
|----------|-----------|
| Small, frequent API payments | MPP direct (charge or session intent) |
| Large deals with delivery guarantees | SyndaxiaEscrow via Factory |
| AI agent paying for a service | MPP |
| AI agent commissioning a deliverable | SyndaxiaEscrow |

The `transferWithMemo` on escrow payouts uses the same TIP-20 transfer format as MPP — enabling unified payment rails and reconciliation.

A Syndaxia HTTP API (MPP-gated) exposes quoting and status endpoints:
- `POST /quote` — fee calculation, param validation, calldata generation
- `GET /escrow/{address}` — escrow state, milestone status, expiry

---

## 7. Security Properties

| Property | Mechanism |
|----------|-----------|
| Immutable fee cap | `MAX_PROTOCOL_FEE_BPS = 20` in Factory bytecode |
| No admin access to escrow | No privileged function can move funds |
| Governance timelock | 7-day delay on all protocol parameter changes |
| No-admin policy | Enables trustless AI agent commerce |
| No native value | Constructor rejects `msg.value > 0` |
| Reconciliation | `transferWithMemo` with escrow address as memo |

---

*Syndaxia Protocol v2 — Tempo · © 2026 Syndaxia Association & Satflows SAS*
