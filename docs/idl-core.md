# IDL Reference — `syndaxia_core`

**Program ID (mainnet):** `ACFJxibNyTnVJVNTaYgBSi5YoFK3qy3xPqvmVmKynAC1`  
**Version:** 0.1.0  
**Framework:** Anchor 0.32.0  
**Release:** [v0.1.0](https://github.com/Syndaxia-org/contracts/releases/tag/v0.1.0)  
**Verified:** [![OtterSec](https://verify.osec.io/badge/ACFJxibNyTnVJVNTaYgBSi5YoFK3qy3xPqvmVmKynAC1)](https://verify.osec.io/status/ACFJxibNyTnVJVNTaYgBSi5YoFK3qy3xPqvmVmKynAC1)  
**Canonical IDL:** [`syndaxia_core-v0.1.0.idl.json`](https://github.com/Syndaxia-org/contracts/releases/download/v0.1.0/syndaxia_core-v0.1.0.idl.json)

---

## Overview

`syndaxia-core` is the escrow lifecycle program. It handles deal creation, SPL token
locking, milestone management, dispute resolution, and expiration recovery. Each deal
is autonomous and immutable — all parameters are set at creation time.

---

## Instructions

### `create_deal`

Create a deal and lock the buyer's funds in escrow. All parameters become immutable.

**Authorized signers:** `buyer` (signer), `deal` (keypair, signer)

| Argument | Type | Description |
|---|---|---|
| `amount` | `u64` | Amount to escrow (in token base units) |
| `fee_bps` | `u64` | Marketplace fee in basis points (max 1 000 = 10%) |
| `release_delay` | `i64` | Seconds after creation before release is allowed (0–365 days) |
| `timeout` | `i64` | Seconds after release_delay window before the deal becomes expirable (min 1 hour, max 365 days) |
| `dispute_delay` | `i64` | Seconds after creation before a dispute can be opened (0 = instant) |
| `dispute_resolution_window` | `i64` | Seconds the validator has to resolve a dispute (1 day–365 days) |
| `metadata_hash` | `[u8; 32]` | Off-chain metadata hash (e.g. IPFS CID of invoice or contract) |
| `milestone_amounts` | `Vec<u64>` | Per-milestone amounts; empty for a simple deal (sum must equal `amount`) |

**Accounts:**

| Account | Writable | Signer | Description |
|---|---|---|---|
| `deal` | ✓ | ✓ | New deal keypair |
| `buyer` | ✓ | ✓ | Buyer wallet |
| `seller` | | | Seller wallet |
| `validator` | | | Arbitrator wallet |
| `buyer_token_account` | ✓ | | Buyer's SPL token account (source of funds) |
| `fee_collector` | | | Owner of the marketplace fee token account |
| `fee_collector_token_account` | ✓ | | Receives marketplace fee |
| `treasury_config` | | | PDA of syndaxia-treasury (`["treasury-config"]`) |
| `treasury_token_account` | ✓ | | Receives protocol fee |
| `escrow_token_account` | ✓ | | PDA `["escrow", deal]` — holds escrowed funds |
| `mint` | | | SPL token mint |
| `token_program` | | | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| `system_program` | | | `11111111111111111111111111111111` |

---

### `release`

Release all escrowed funds to the beneficiary (simple deal only — no milestones).

**Authorized:** `buyer` OR `validator`  
**Valid states:** `Open` (after `release_delay`), `Disputed` (validator only, delay ignored)

**Accounts:**

| Account | Writable | Description |
|---|---|---|
| `deal` | ✓ | Deal account |
| `authority` | signer | Buyer or validator |
| `beneficiary_token_account` | ✓ | Receives escrowed funds |
| `buyer_token_account` | ✓ | Receives rent recovery |
| `escrow_token_account` (PDA) | ✓ | Source of funds, closed after transfer |
| `rent_receiver` | ✓ | Must be deal's buyer |
| `token_program` | | |

---

### `release_milestone`

Release a single milestone from a milestone deal.

**Authorized:** `buyer` OR `validator`  
**Valid states:** `Open` (after `release_delay`), `Disputed` (validator only)

| Argument | Type | Description |
|---|---|---|
| `milestone_index` | `u8` | Zero-based index of the milestone to release (must not already be released) |

Accounts same as `release`. When the last milestone is released, the deal status
transitions to `Released` and the escrow account is closed.

---

### `refund`

Refund escrowed funds to the buyer.

**Authorized:** `beneficiary` (seller) OR `validator`  
**Valid states:** `Open`, `Disputed`

Accounts same as `release`. Escrow is closed and rent is recovered to buyer.

---

### `dispute`

Open a dispute to block automatic release.

**Authorized:** `buyer` OR `beneficiary` (seller)  
**Valid states:** `Open` only  
**Condition:** `dispute_delay` must have elapsed since deal creation

| Account | Description |
|---|---|
| `deal` (writable) | Deal account |
| `authority` (signer) | Buyer or beneficiary |

Sets `disputed_at` and starts the `dispute_resolution_window` countdown.

---

### `resolve_dispute`

Resolve a dispute by splitting escrowed funds between buyer and seller.

**Authorized:** `validator` only  
**Valid states:** `Disputed`  
**Condition:** `buyer_share + seller_share` must equal the escrowed amount

| Argument | Type | Description |
|---|---|---|
| `buyer_share` | `u64` | Amount returned to buyer |
| `seller_share` | `u64` | Amount sent to beneficiary |

---

### `extend_dispute`

Extend the dispute resolution window. Limited to `MAX_DISPUTE_EXTENSIONS` extensions.

**Authorized:** `validator` only  
**Valid states:** `Disputed`

| Account | Description |
|---|---|
| `deal` (writable) | Deal account |
| `authority` (signer) | Validator |

Emits `DisputeExtended` with the new deadline and remaining extensions count.

---

### `expire_deal`

Permissionless expiration — refunds the buyer when the deal has timed out.

**Authorized:** anyone (permissionless)  
**Condition:** `now >= created_at + release_delay + timeout`  
**Valid states:** `Open`, `Disputed`

For disputed deals the timeout is `disputed_at + dispute_resolution_window`.

---

### `transfer_beneficiary`

Transfer the beneficiary (payee) of a deal to a new address. Enables factoring and vault hooks.

**Authorized:** current `beneficiary` only  
**Valid states:** `Open`, `Disputed`  
**Constraint:** `new_beneficiary != buyer` and `new_beneficiary != validator`

| Argument | Type | Description |
|---|---|---|
| `new_beneficiary` | `pubkey` | New payee address |

| Account | Description |
|---|---|
| `deal` (writable) | Deal account |
| `beneficiary` (signer) | Current beneficiary |

---

## Account: `Deal`

**Discriminator:** `[125, 223, 160, 234, 71, 162, 182, 219]`  
**Type:** Keypair-based (not a PDA)

| Field | Type | Mutable | Description |
|---|---|---|---|
| `seller` | `pubkey` | No | Payee (defaults to `beneficiary`) |
| `buyer` | `pubkey` | No | Payer — signs deal creation |
| `validator` | `pubkey` | No | Arbitrator for disputes |
| `fee_collector` | `pubkey` | No | Owner of marketplace fee token account |
| `beneficiary` | `pubkey` | Yes* | Current release destination; defaults to `seller` |
| `amount` | `u64` | No | Total escrowed amount |
| `fee_bps` | `u64` | No | Marketplace fee in BPS |
| `metadata_hash` | `[u8; 32]` | No | Off-chain metadata hash |
| `created_at` | `i64` | No | Unix timestamp of creation |
| `release_delay` | `i64` | No | Seconds before release is allowed |
| `timeout` | `i64` | No | Seconds after release window before expiry |
| `dispute_delay` | `i64` | No | Seconds before a dispute can be opened |
| `dispute_resolution_window` | `i64` | No | Seconds validator has to resolve |
| `disputed_at` | `i64` | No | Timestamp when dispute opened (0 if never) |
| `dispute_extensions_remaining` | `u8` | No | Extensions the validator can still request |
| `status` | `Status` | Yes | `Open` \| `Released` \| `Refunded` \| `Disputed` |
| `milestone_count` | `u8` | No | 0 = simple deal; 1–8 = milestone deal |
| `released_mask` | `u8` | Yes | Bitmask — bit i set means milestone i was released |
| `milestone_amounts` | `[u64; 8]` | No | Per-milestone amounts (only first `milestone_count` used) |

\* `beneficiary` can be updated via `transfer_beneficiary`.

---

## Events

| Event | Emitted by | Key fields |
|---|---|---|
| `DealCreated` | `create_deal` | deal, buyer, seller, validator, amount, fees, delays, milestone_count |
| `DealReleased` | `release` | deal, buyer, beneficiary, amount, authority |
| `MilestoneReleased` | `release_milestone` | deal, milestone_index, amount, released_mask |
| `DealRefunded` | `refund` | deal, buyer, beneficiary, amount, authority |
| `DealExpired` | `expire_deal` | deal, buyer, beneficiary, amount |
| `DealDisputed` | `dispute` | deal, buyer, beneficiary, opened_by, resolution_deadline |
| `DisputeResolved` | `resolve_dispute` | deal, buyer, beneficiary, buyer_share, seller_share |
| `DisputeExtended` | `extend_dispute` | deal, validator, new_deadline, extensions_remaining |
| `BeneficiaryTransferred` | `transfer_beneficiary` | deal, old_beneficiary, new_beneficiary |

---

## Errors

| Code | Name | Message |
|---|---|---|
| 6000 | `FeeTooHigh` | Fee exceeds the maximum allowed (10%). |
| 6001 | `InvalidAmount` | Amount must be greater than zero. |
| 6002 | `Unauthorized` | Unauthorized signer for this action. |
| 6003 | `NotOpen` | Deal is not in Open state. |
| 6004 | `NotEligible` | Operation not eligible for the current deal state. |
| 6005 | `MathOverflow` | Arithmetic overflow. |
| 6006 | `ReleaseTooEarly` | Release delay has not elapsed yet. |
| 6007 | `DealExpired` | Deal has expired. |
| 6008 | `DealNotExpired` | Deal has not expired yet. |
| 6009 | `InvalidBeneficiaryTokenAccount` | Beneficiary token account does not match the deal's beneficiary. |
| 6010 | `InvalidBuyerTokenAccount` | Buyer token account does not match the deal's buyer. |
| 6011 | `InvalidFeeCollector` | Fee collector token account does not match the provided fee_collector. |
| 6012 | `InvalidReleaseDelay` | Release delay is invalid (negative or exceeds 365 days). |
| 6013 | `BuyerEqualsSeller` | Buyer and seller cannot be the same address. |
| 6014 | `InvalidRentReceiver` | Rent receiver does not match the deal's buyer. |
| 6015 | `InvalidTimeout` | Timeout must be at least 1 hour. |
| 6016 | `InvalidValidator` | Validator cannot be the buyer. |
| 6017 | `TooManyMilestones` | Too many milestones (max 8). |
| 6018 | `InvalidMilestoneAmount` | Milestone amount must be greater than zero. |
| 6019 | `MilestoneSumMismatch` | Sum of milestone amounts must equal the deal amount. |
| 6020 | `UseMilestoneRelease` | Use release_milestone for milestone deals. |
| 6021 | `NotMilestoneDeal` | This is not a milestone deal. |
| 6022 | `InvalidMilestoneIndex` | Milestone index out of range. |
| 6023 | `MilestoneAlreadyReleased` | Milestone has already been released. |
| 6024 | `BeneficiaryEqualsBuyer` | New beneficiary cannot be the buyer. |
| 6025 | `NotDisputed` | Deal must be in Disputed state for this action. |
| 6026 | `InvalidSplit` | buyer_share + seller_share must equal the escrowed amount. |
| 6027 | `DisputeTooEarly` | Dispute cannot be opened before the cooling period has elapsed. |
| 6028 | `InvalidDisputeDelay` | Dispute delay is invalid (negative or exceeds 365 days). |
| 6029 | `InvalidDisputeResolutionWindow` | Dispute resolution window is invalid (must be between 1 day and 365 days). |
| 6030 | `InvalidProtocolFee` | Protocol fee from Treasury exceeds the hardcoded maximum (20 BPS). |
| 6031 | `InvalidTreasuryTokenAccount` | Treasury token account does not match the treasury config fee_receiver. |
| 6032 | `InvalidTreasuryConfig` | Treasury config account data is invalid or corrupted. |
| 6033 | `ValidatorEqualsSeller` | Validator and seller cannot be the same address. |
| 6034 | `BeneficiaryEqualsValidator` | New beneficiary cannot be the validator. |
| 6035 | `TimeoutTooLong` | Timeout exceeds the maximum allowed (365 days). |
| 6036 | `NoExtensionsRemaining` | No dispute extensions remaining. |
| 6037 | `DisputeExtensionTooLong` | Total dispute resolution time would exceed the maximum allowed. |
| 6038 | `DisputeExpired` | Dispute resolution window has already expired. |

---

## Permission Matrix

| Action | Buyer | Seller / Beneficiary | Validator | Permissionless |
|---|---|---|---|---|
| `create_deal` | ✓ | | | |
| `release` (Open, after delay) | ✓ | | ✓ | |
| `release` (Disputed) | | | ✓ | |
| `release_milestone` (Open) | ✓ | | ✓ | |
| `refund` | | ✓ | ✓ | |
| `dispute` | ✓ | ✓ | | |
| `resolve_dispute` | | | ✓ | |
| `extend_dispute` | | | ✓ | |
| `expire_deal` | ✓ | ✓ | ✓ | ✓ |
| `transfer_beneficiary` | | beneficiary only | | |

---

*Generated from the verified IDL at release [v0.1.0](https://github.com/Syndaxia-org/contracts/releases/tag/v0.1.0) — commit `ef22d9d`.*
