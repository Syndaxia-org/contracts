# IDL Reference — `syndaxia_treasury`

**Program ID (mainnet):** `DvoZj1cKMi8DEvTxBgNEnj9Fhxx9PRAsVTEWEZ2e6YHx`  
**Version:** 0.1.0  
**Framework:** Anchor 0.32.0  
**Release:** [v0.1.0](https://github.com/Syndaxia-org/contracts/releases/tag/v0.1.0)  
**Verified:** [![OtterSec](https://verify.osec.io/badge/DvoZj1cKMi8DEvTxBgNEnj9Fhxx9PRAsVTEWEZ2e6YHx)](https://verify.osec.io/status/DvoZj1cKMi8DEvTxBgNEnj9Fhxx9PRAsVTEWEZ2e6YHx)  
**Canonical IDL:** [`syndaxia_treasury-v0.1.0.idl.json`](https://github.com/Syndaxia-org/contracts/releases/download/v0.1.0/syndaxia_treasury-v0.1.0.idl.json)

---

## Overview

`syndaxia-treasury` governs the protocol fee rate and fee recipient for the Syndaxia
protocol. All changes go through a mandatory **7-day timelock**. The program is
controlled by the Syndaxia Association multisig (`FgpQNVq9jSqqQ2jq7EDHhhSzMMf51wuEEdWjKzNYG9Wu`
via Squads Protocol).

The protocol fee is capped at **20 BPS (0.20%)** — this ceiling is hardcoded in
`syndaxia-core` and cannot be raised without an on-chain program upgrade.

---

## Config PDA

**Account name:** `TreasuryConfig`  
**Seeds:** `["treasury-config"]`  
**Program:** `DvoZj1cKMi8DEvTxBgNEnj9Fhxx9PRAsVTEWEZ2e6YHx`  
**Discriminator:** `[124, 54, 212, 227, 213, 189, 168, 41]`

`syndaxia-core` reads this account's raw bytes at deal creation to obtain the current
`protocol_fee_bps` and `fee_receiver`. No CPI dependency is required.

---

## Instructions

### `initialize`

Initialize the treasury. Called once by the Syndaxia Association multisig.

**Authorized:** `multisig` (signer, payer)

| Argument | Type | Description |
|---|---|---|
| `fee_receiver` | `pubkey` | Token account that will receive accumulated protocol fees |

| Account | Description |
|---|---|
| `config` (writable PDA) | Creates `TreasuryConfig` |
| `multisig` (writable, signer) | Governance key — payer for the account |
| `system_program` | |

Emits `TreasuryInitialized`.

---

### `propose_fee_change`

Propose a new protocol fee rate. Starts the 7-day timelock.

**Authorized:** `multisig` only  
**Constraint:** `new_fee_bps <= 20` (hard cap)  
**Constraint:** No other fee proposal must be pending (cancel first)  
**Constraint:** `new_fee_bps` must differ from the current rate (no-op guard)

| Argument | Type | Description |
|---|---|---|
| `new_fee_bps` | `u64` | Proposed new rate in basis points (max 20) |

Emits `FeeChangeProposed { proposed_by, new_fee_bps, executable_after }`.

---

### `apply_fee_change`

Apply a pending fee change after the 7-day timelock has elapsed.

**Authorized:** anyone (permissionless)  
**Condition:** A proposal must be pending and `now >= executable_after`

Emits `FeeChangeApplied { old_fee_bps, new_fee_bps }`.

---

### `cancel_fee_change`

Cancel a pending fee change proposal before it is applied.

**Authorized:** `multisig` only

Emits `FeeChangeCancelled { cancelled_by }`.

---

### `propose_fee_receiver_change`

Propose a new protocol fee recipient token account. Starts the 7-day timelock.

**Authorized:** `multisig` only  
**Constraint:** No other receiver proposal must be pending  
**Constraint:** New receiver must differ from current

| Argument | Type | Description |
|---|---|---|
| `new_fee_receiver` | `pubkey` | Proposed new fee receiver token account (owner = multisig) |

Emits `FeeReceiverChangeProposed { proposed_by, new_receiver, executable_after }`.

---

### `apply_fee_receiver_change`

Apply a pending fee receiver change after the timelock.

**Authorized:** anyone (permissionless)

Emits `FeeReceiverUpdated { old_receiver, new_receiver }`.

---

### `cancel_fee_receiver_change`

Cancel a pending fee receiver change.

**Authorized:** `multisig` only

Emits `FeeReceiverChangeCancelled { cancelled_by }`.

---

### `propose_multisig_change`

Propose a governance key rotation. Starts the 7-day timelock.

**Authorized:** current `multisig` only  
**Constraint:** No other multisig proposal must be pending  
**Constraint:** `new_multisig` must not be the zero key

| Argument | Type | Description |
|---|---|---|
| `new_multisig` | `pubkey` | New governance key (Squads vault address) |

Emits `MultisigChangeProposed { proposed_by, new_multisig, executable_after }`.

---

### `apply_multisig_change`

Apply a pending multisig rotation after the timelock.

**Authorized:** anyone (permissionless)

Emits `MultisigRotated`.

---

### `cancel_multisig_change`

Cancel a pending multisig rotation.

**Authorized:** current `multisig` only

Emits `MultisigChangeCancelled { cancelled_by }`.

---

### `withdraw`

Transfer accumulated protocol fees from the treasury token account to the `fee_receiver`.

**Authorized:** `multisig` only

| Argument | Type | Description |
|---|---|---|
| `amount` | `u64` | Amount to withdraw (must be > 0) |

| Account | Description |
|---|---|
| `config` (PDA) | TreasuryConfig — validates multisig and fee_receiver |
| `multisig` (writable, signer) | Governance key |
| `treasury_token_account` (writable) | Holds accumulated fees |
| `fee_receiver_token_account` (writable) | Destination — must match `config.fee_receiver` |
| `token_program` | |

Emits `FeeWithdrawn { amount, to, by }`.

---

### `migrate_v2`

One-shot migration from v1 account layout to v2 (adds `pending_multisig` fields).
Idempotent. Must be called once before any other instruction on a pre-existing v1 account.

**Authorized:** anyone — payer covers the rent delta

| Account | Description |
|---|---|
| `config` (writable PDA) | Config account (may still be v1 layout) |
| `payer` (writable, signer) | Pays for extra account space |
| `system_program` | |

Emits `ConfigMigratedV2 { config }`.

---

## Governance Flow

```
propose_fee_change(new_rate)
    ↓  (7-day timelock)
apply_fee_change()          ← permissionless after timelock

propose_fee_receiver_change(new_receiver)
    ↓  (7-day timelock)
apply_fee_receiver_change() ← permissionless after timelock

propose_multisig_change(new_multisig)
    ↓  (7-day timelock)
apply_multisig_change()     ← permissionless after timelock
```

Any proposal can be cancelled by the multisig before the timelock elapses.

---

## Events

| Event | Emitted by | Key fields |
|---|---|---|
| `TreasuryInitialized` | `initialize` | — |
| `FeeChangeProposed` | `propose_fee_change` | proposed_by, new_fee_bps, executable_after |
| `FeeChangeApplied` | `apply_fee_change` | old_fee_bps, new_fee_bps |
| `FeeChangeCancelled` | `cancel_fee_change` | cancelled_by |
| `FeeReceiverChangeProposed` | `propose_fee_receiver_change` | proposed_by, new_receiver, executable_after |
| `FeeReceiverUpdated` | `apply_fee_receiver_change` | old_receiver, new_receiver |
| `FeeReceiverChangeCancelled` | `cancel_fee_receiver_change` | cancelled_by |
| `MultisigChangeProposed` | `propose_multisig_change` | proposed_by, new_multisig, executable_after |
| `MultisigRotated` | `apply_multisig_change` | — |
| `MultisigChangeCancelled` | `cancel_multisig_change` | cancelled_by |
| `FeeWithdrawn` | `withdraw` | amount, to, by |
| `ConfigMigratedV2` | `migrate_v2` | config |

---

## Errors

| Code | Name | Message |
|---|---|---|
| 6000 | `FeeTooHigh` | Proposed fee exceeds the maximum allowed (20 BPS = 0.20%). |
| 6001 | `Unauthorized` | Unauthorized: signer is not the governance multisig. |
| 6002 | `NoPendingProposal` | No pending fee change proposal to apply or cancel. |
| 6003 | `TimelockNotElapsed` | Timelock period has not elapsed yet. |
| 6004 | `MathOverflow` | Arithmetic overflow. |
| 6005 | `InvalidAmount` | Amount must be greater than zero. |
| 6006 | `InvalidTokenAccount` | Treasury token account authority does not match the config PDA. |
| 6007 | `InvalidFeeReceiver` | Fee receiver token account does not match config.fee_receiver. |
| 6008 | `NoPendingReceiverProposal` | No pending fee receiver change proposal to apply or cancel. |
| 6009 | `ProposalAlreadyPending` | A proposal of this kind is already pending; cancel it first. |
| 6010 | `NoOpProposal` | Proposed value is identical to the current configuration (no-op). |
| 6011 | `InvalidMultisig` | Multisig pubkey cannot be the default (zero) key. |
| 6012 | `NoPendingMultisigProposal` | No pending multisig change proposal to apply or cancel. |
| 6013 | `AlreadyMigrated` | Account has already been migrated to v2 layout. |

---

## Security Properties

- **Fee ceiling:** `protocol_fee_bps <= 20` enforced both in treasury and cross-checked in core (error `InvalidProtocolFee` if exceeded)
- **Timelock:** All parameter changes require 7 days between proposal and application
- **Multisig:** Controlled by Squads Protocol vault — no single key can govern unilaterally
- **Key rotation:** Multisig can be rotated via the same 7-day timelock process
- **Permissionless apply:** Anyone can trigger `apply_*` after timelock, preventing the multisig from blocking a change it previously approved

---

*Generated from the verified IDL at release [v0.1.0](https://github.com/Syndaxia-org/contracts/releases/tag/v0.1.0) — commit `ef22d9d`.*
