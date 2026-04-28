# Syndaxia Protocol — Security Audit Report

**Programs in scope**

| Program | Version | Mainnet Program ID |
|---------|---------|------------|
| `syndaxia-core` | v0.2.0 | `ACFJxibNyTnVJVNTaYgBSi5YoFK3qy3xPqvmVmKynAC1` |
| `syndaxia-treasury` | v0.2.0 | `DvoZj1cKMi8DEvTxBgNEnj9Fhxx9PRAsVTEWEZ2e6YHx` |

**Blockchain**: Solana — Anchor 0.32.0  
**Initial audit date**: March 31, 2026  
**Treasury & milestones review date**: April 1, 2026  
**Post-launch hardening review (Series C) date**: April 27, 2026  
**Audit type**: Internal security review  
**Status**: ✅ All identified vulnerabilities have been remediated and verified by tests

---

## Executive Summary

Syndaxia is a decentralized escrow protocol for peer-to-peer and business-to-business
commerce on Solana. It comprises two programs:

- **`syndaxia-core`** — Deal lifecycle: SPL token escrow, milestone support,
  third-party validator arbitration, dispute resolution, and expiration recovery.
- **`syndaxia-treasury`** — Protocol fee governance: rate and recipient management
  with a mandatory 7-day timelock on every change.

The internal review was conducted in three passes. Series A covered the initial
architecture; Series B covered the integration between `syndaxia-core` and
`syndaxia-treasury` along with the milestone feature. Series C is a post-launch
hardening pass conducted while both programs are deployed on mainnet (and still
upgradeable), focused on dispute lifecycle invariants and treasury governance
resilience.

### Findings Summary

| Severity | Series A (initial architecture) | Series B (treasury + milestones) | Series C (post-launch hardening) | Total Remediated |
|----------|---------------------------------|----------------------------------|---------------------------------|-----------------|
| 🔴 Critical | 4 | 1 | 0 | **5** |
| 🟠 High | 4 | 2 | 2 | **8** |
| 🟡 Medium | 5 | 2 | 4 | **11** |
| 🔵 Informational | — | 1 | 3 | **4** |
| **Remaining open** | | | | **0** |

All findings were remediated and covered by regression tests before this report was
published. No vulnerability remains open.

---

## Architecture Overview

### Programs

**`syndaxia-core`** exposes the following instructions:

| Instruction | Authorized Signers | Description |
|-------------|-------------------|-------------|
| `create_deal` | Buyer | Locks tokens + fees in escrow |
| `release` | Buyer or Validator | Releases to beneficiary (single-tranche) |
| `release_milestone` | Buyer or Validator | Releases one milestone by index |
| `refund` | Seller or Validator | Refunds to buyer |
| `dispute` | Buyer | Freezes automatic release |
| `resolve_dispute` | Validator | Settles dispute with an arbitrary split |
| `expire_deal` | Permissionless | Refunds buyer after timeout |
| `transfer_beneficiary` | Current Beneficiary | Updates the release destination |

**`syndaxia-treasury`** exposes the following instructions:

| Instruction | Authorized Signers | Description |
|-------------|-------------------|-------------|
| `initialize` | Multisig | Creates the TreasuryConfig account |
| `propose_fee_change` | Multisig | Proposes a new protocol fee rate (7-day timelock) |
| `cancel_fee_change` | Multisig | Cancels the pending proposal |
| `apply_fee_change` | Permissionless | Applies the rate after timelock elapses |
| `propose_fee_receiver_change` | Multisig | Proposes a new fee recipient (7-day timelock) |
| `cancel_fee_receiver_change` | Multisig | Cancels the pending proposal |
| `apply_fee_receiver_change` | Permissionless | Applies the recipient after timelock elapses |
| `withdraw` | Multisig | Transfers accumulated fees to the fee receiver |

### Deal State Machine

```
create_deal → OPEN ──┬── release (buyer/validator, after delay) ──→ RELEASED
                     ├── release_milestone (partial) ──────────→ OPEN (partial)
                     ├── refund (seller/validator) ─────────────→ REFUNDED
                     ├── dispute (buyer) ─────────────────────→ DISPUTED
                     │       └── resolve_dispute (validator) ──→ RELEASED/REFUNDED
                     │       └── expire (permissionless, +30d) → REFUNDED
                     └── expire (permissionless, after timeout) → REFUNDED
```

Terminal states `RELEASED` and `REFUNDED` are irreversible.

---

## Findings

### Series A — Initial Architecture

#### A-CRIT-1 · Market Substitution (Critical)

An attacker could pass a fake market account to the `release` instruction,
bypassing validator authorization and draining any escrow.

**Remediation**: Anchor `has_one` constraint on the deal's market field.  
**Test coverage**: ✅

---

#### A-CRIT-2 · Token Account Redirect (Critical)

`release` and `refund` did not verify that the destination token accounts belonged
to the deal's registered parties. An attacker could redirect funds to an arbitrary wallet.

**Remediation**: Explicit owner constraints (`beneficiary_token_account.owner == deal.beneficiary`, `buyer_token_account.owner == deal.buyer`).  
**Test coverage**: ✅

---

#### A-CRIT-3 · Fee Collector Hijack (Critical)

The marketplace fee token account was accepted without validation, allowing an
attacker to capture 100% of marketplace fees by substituting their own account.

**Remediation**: `fee_collector_token_account.owner == fee_collector.key()` constraint added.  
**Test coverage**: ✅

---

#### A-CRIT-4 · Release Delay Bypass (Critical)

The `release_delay` parameter was stored on the deal account but never enforced.
Any buyer could release funds immediately, ignoring the configured lockup period.

**Remediation**: On-chain timestamp check before every release in `Open` state.  
**Test coverage**: ✅

---

#### A-HIGH-1 · Uncapped Protocol Fee (High)

No upper bound was enforced on `protocol_fee_bps` at deal creation time, allowing
a misconfigured treasury to impose a fee above the intended 0.2% cap.

**Remediation**: `require!(protocol_fee_bps <= MAX_PROTOCOL_FEE_BPS)` enforced in `create_deal`; total fee also validated against 100%.

---

#### A-HIGH-2 · Escrow Rent Leak (High)

The escrow token account was never closed after a final transfer (release / refund /
expire), permanently locking the lamport rent inside the account.

**Remediation**: `token::close_account()` called after every final transfer; rent returned to the buyer.

---

#### A-HIGH-3 · No On-chain Events (High)

No Anchor events were emitted, making off-chain indexing and monitoring impossible.

**Remediation**: Anchor events emitted in every instruction.

---

#### A-HIGH-4 · No Deal Expiry Mechanism (High)

Open deals with an unresponsive seller had no recovery path; buyer funds could be
locked indefinitely.

**Remediation**: Permissionless `expire_deal` instruction added. Effective expiry = `created_at + release_delay + timeout` (minimum timeout: 1 hour).

---

#### A-MED-1 · Negative `release_delay` (Medium)

A negative `release_delay` could cause arithmetic issues in timestamp comparisons.

**Remediation**: `require!(release_delay >= 0)`.

---

#### A-MED-2 · Excessively Large `release_delay` (Medium)

A value approaching `i64::MAX` would make the release window permanently
unreachable via integer overflow.

**Remediation**: `require!(release_delay <= MAX_RELEASE_DELAY)` (365 days maximum).

---

#### A-MED-3 · Self-Dealing (Buyer == Seller) (Medium)

No guard prevented a user from creating a deal with themselves as both buyer and
seller.

**Remediation**: `require!(buyer.key() != seller.key(), BuyerEqualsSeller)`.

---

#### A-MED-4 · Expire/Release Delay Conflict (Medium)

The expiry formula did not account for `release_delay`, which could make a deal
expire before the seller's release window had even started.

**Remediation**: Effective timeout = `release_delay + timeout`, guaranteeing the seller always has a full `timeout` window after the release delay lapses.

---

#### A-MED-5 · Deprecated `Rent` Sysvar (Medium)

Code passed a `Rent` sysvar that has been handled automatically since Anchor 0.29,
adding unnecessary account overhead.

**Remediation**: Sysvar removed.

---

### Series B — Treasury Integration & Milestones

#### B-CRIT-1 · Partial Milestones → Funds Permanently Locked (Critical)

After one or more milestones were released, `refund`, `expire`, and
`resolve_dispute` referenced `deal.amount` (the original total) instead of the
remaining escrow balance. Any attempt to refund or settle a partially-released
milestone deal would fail, permanently locking the remaining funds.

**Remediation**: `Deal::remaining_escrow_amount()` helper added; all affected instructions now use this value instead of `deal.amount`.  
**Test coverage**: ✅

---

#### B-HIGH-1 · Disputed Deals Cannot Expire (High)

`expire_deal` only accepted deals in `Open` status. If the buyer disputed a deal
and the validator became unavailable (lost key, disappeared), the remaining funds
were locked indefinitely with no recovery path.

Additionally, a dispute opened near the original expiry deadline could leave the
validator with less than a minute to arbitrate.

**Remediation**:
- `expire_deal` now accepts both `Open` and `Disputed` states.
- A `disputed_at` timestamp is recorded when a dispute is opened.
- Disputed deals expire `disputed_at + 30 days`, giving the validator a guaranteed
  full resolution window regardless of when the deal was created.

**Test coverage**: ✅

---

#### B-HIGH-2 · Instant Fee Receiver Change (High)

`update_fee_receiver` in `syndaxia-treasury` allowed the multisig to redirect all
future protocol fees to any address immediately. A compromised multisig key could
silently redirect 100% of fees with no observation window, while the fee rate
change already carried a 7-day timelock.

**Remediation**: `update_fee_receiver` replaced by a three-step flow
(`propose_fee_receiver_change` → `cancel_fee_receiver_change` →
`apply_fee_receiver_change`) with an identical 7-day timelock. Any proposed change
is visible on-chain and cancellable by the multisig before it takes effect.

**Test coverage**: ✅

---

#### B-MED-1 · Seller == Validator (Medium)

No guard prevented the seller from designating themselves as the deal's validator.
In a dispute, they would arbitrate their own case and could award themselves 100%
of the funds.

**Remediation**: `require!(seller.key() != validator.key(), ValidatorEqualsSeller)`.  
**Test coverage**: ✅

---

#### B-INFO-1 · Treasury Fee Flow Misalignment (Informational)

`create_deal` sent protocol fees to a token account owned by the `fee_receiver`
wallet, while `withdraw` in the Treasury program required the token account to be
owned by the Treasury Config PDA. These were two different accounts; `withdraw` could
never access the fees deposited by `create_deal`.

**Remediation**: `create_deal` now validates that `treasury_token_account.owner ==
treasury_config.key()` (the PDA), aligning both programs on the same account.

---

### Series C — Post-Launch Hardening

This series was conducted after the initial mainnet deployment, while both programs
remain upgradeable. It focuses on (a) lifecycle invariants in the dispute flow that
were correct in the happy path but unsafe at boundaries, and (b) governance
resilience of the treasury program.

#### C-HIGH-1 · Dispute Extension After Deadline (High)

**Risk**: A validator could call `extend_dispute` after the dispute resolution
window had already elapsed, retroactively re-opening a deal that should have been
eligible for `expire_deal` (refund to buyer). This created a griefing vector
against the buyer and broke the lifecycle guarantee that an expired dispute
cannot be resurrected.

**Remediation**: `extend_dispute` now rejects calls past the current dispute
deadline with `DisputeExpired`. Once the window has elapsed, only `expire_deal`
remains callable, ensuring the buyer is reliably refunded.

---

#### C-HIGH-2 · Multisig Cannot Be Rotated (High)

**Risk**: The treasury governance multisig stored in `TreasuryConfig` was
immutable. Loss or compromise of the multisig keys would have permanently
bricked governance, forcing recovery via program upgrade — itself slated to be
locked in the future. This was a single point of permanent failure.

**Remediation**: A timelocked multisig rotation mechanism was added
(`propose_multisig_change` / `cancel_multisig_change` / `apply_multisig_change`)
mirroring the existing fee-change pattern with a 7-day timelock. Cancellation
remains under the current multisig; application is permissionless after the
timelock. Account layout was extended in a backwards-compatible way via a
one-shot `migrate_v2` instruction that resizes pre-existing accounts in place
and zero-initialises the appended fields. The `syndaxia-core` cross-program
offsets used to read `fee_receiver` and `protocol_fee_bps` were preserved.

---

#### C-MED-1 · Dispute Resolution After Deadline (Medium)

**Risk**: `resolve_dispute` did not check the dispute deadline. A validator
could resolve a dispute long after its window had elapsed, contradicting the
intended invariant that an expired dispute can only be settled by
`expire_deal` (full refund to the buyer).

**Remediation**: `resolve_dispute` now rejects calls past the dispute deadline
with `DisputeExpired`. Combined with C-HIGH-1, this guarantees a strict
lifecycle: while the window is open, the validator may extend or resolve;
once elapsed, only the buyer-refund path remains.

---

#### C-MED-2 · Beneficiary Transfer During Dispute (Medium)

**Risk**: `transfer_beneficiary` accepted both `Open` and `Disputed` states.
While the operation only changes the future payee (not the funds at rest),
allowing it during a dispute could be used by the seller side to obfuscate
the destination of funds mid-arbitration, complicating the validator's
decision.

**Remediation**: `transfer_beneficiary` now restricts the transition to the
`Open` state only. Beneficiary changes during arbitration are rejected with
`NotEligible`.

---

#### C-MED-3 · Silent Overwrite of Pending Treasury Proposals (Medium)

**Risk**: Calling `propose_fee_change` or `propose_fee_receiver_change` while
a proposal of the same kind was already pending silently overwrote it and
restarted the 7-day timelock. A compromised governance key could cycle
proposals indefinitely to delay any user-favorable change. There was also no
on-chain trace of the original proposal being superseded.

**Remediation**: Both proposals now require any pending proposal of the same
kind to be explicitly cancelled first (`cancel_*` emits a dedicated event).
New error: `ProposalAlreadyPending`. Same protection extended to the new
`propose_multisig_change` (C-HIGH-2).

---

#### C-MED-4 · Insufficient Validation on Treasury Proposals (Medium)

**Risk**: `propose_fee_receiver_change` accepted `Pubkey::default()` as the
new receiver. If applied, no token account could ever satisfy the
`owner == config.fee_receiver` constraint, permanently bricking withdrawals.
In parallel, all three proposal types (fee, receiver, multisig) accepted
no-op values (identical to the current configuration), which only served to
delay legitimate subsequent proposals while emitting misleading events.

**Remediation**: The new receiver and the new multisig are both required to
be non-default. All three proposal types now reject values identical to the
current configuration with `NoOpProposal`.

---

#### C-INFO-1 · Misleading Permissionless-Apply Events (Informational)

**Issue**: `FeeReceiverUpdated` carried an `updated_by: Pubkey::default()`
field because `apply_fee_receiver_change` is permissionless. Block explorers
rendered this as a literal address, falsely suggesting an actor.

**Remediation**: The misleading field was removed.

---

#### C-INFO-2 · Dispute Resolution Window Lower Bound (Informational)

**Issue**: The minimum acceptable `dispute_resolution_window` was 24 hours.
While no immediate exploit existed, such a short window could be selected
at deal creation in a way that disadvantages the counterparty by leaving
insufficient time to evaluate evidence.

**Remediation**: The minimum was raised to 7 days, matching the protocol's
governance timelock and giving all parties — including external arbitrators —
adequate time to react.

---

#### C-INFO-3 · Dead Code (Informational)

**Issue**: Unused scaffolding files (legacy `Market`, `Config` state types
and their initialization handlers) remained in the program crate. They had
no effect on runtime behavior but increased the audit surface and risked
being wired in inadvertently during future refactors.

**Remediation**: All dead modules were removed.

---

## Attack Vector Analysis

| Vector | Status |
|--------|--------|
| CPI-based authorization bypass | ✅ Protected — `Signer` checks remain valid under CPI |
| PDA account resurrection | ✅ Protected — deals use random keypairs; Anchor `init` rejects existing discriminators |
| Solana clock manipulation | ✅ Negligible — validator consensus clock; max drift ~1–2 s; delays are in hours/days |
| Front-running / MEV (Jito bundles) | ✅ Protected — sensitive instructions require a `Signer` that searchers cannot forge |
| Excess tokens sent to escrow | ✅ Protected — instructions transfer exactly `remaining_escrow_amount()`; surplus returned via `close_account` |
| Mint confusion | ✅ Protected — SPL Token Program rejects cross-mint transfers |
| Reentrancy | ✅ Protected — Solana has no CPI callbacks; Token Program CPIs are atomic |
| Dead validator DoS (disputed deals locked) | ✅ Remediated — B-HIGH-1 |
| Treasury multisig compromise | ✅ Mitigated — 7-day timelock on all governance changes (fee rate + recipient) |
| Corrupt treasury config injection | ✅ Protected — PDA derivation uses a hardcoded `TREASURY_PROGRAM_ID`; fee capped at 20 BPS after deserialization |
| Token freeze authority (USDC/Circle) | ⚠️ Accepted residual risk — inherent to SPL, not mitigable at protocol level |
| Validator + seller collusion | ⚠️ Accepted residual risk — off-chain reputation; buyer selects the validator |

---

## Arithmetic Protections

| Protection | Implementation |
|------------|----------------|
| Multiplication overflow | `checked_mul` |
| Addition overflow | `checked_add` |
| Division by zero | Impossible (`BPS_DENOMINATOR = 10_000` is a compile-time constant) |
| Rounding | Integer truncation (floor) — the protocol never overcharges |
| Total fees > 100% | `require!(fee_bps <= MAX_FEE_BPS)` (marketplace max 10%) |
| Protocol fee cap | `require!(protocol_fee_bps <= MAX_PROTOCOL_FEE_BPS)` (hard cap 20 BPS) |

**Compilation flags** (`Cargo.toml`):
```toml
[profile.release]
overflow-checks = true
lto = "fat"
codegen-units = 1
```

---

## Parameter Limits

| Parameter | Min | Max |
|-----------|-----|-----|
| `protocol_fee_bps` | 0 | 20 (0.2%) |
| `marketplace_fee_bps` | 0 | 1,000 (10%) |
| `amount` | 1 | u64::MAX |
| `release_delay` | 0 | 31,536,000 s (365 days) |
| `timeout` | 3,600 s (1 hour) | — |
| `dispute_delay` | 0 | 31,536,000 s (365 days) |
| `milestone_count` | 0 | 8 |
| Σ `milestone_amounts` | — | must equal `amount` |

---

## Test Coverage

### Integration Tests (TypeScript) — 24 / 24 ✅

Tests cover the full deal lifecycle (creation, release, refund, dispute,
expiration, milestones) as well as 14 dedicated security attack tests targeting
every critical and high finding listed in this report.

### Unit Tests (Rust) — 7 / 7 ✅

Unit tests cover fee arithmetic edge cases: zero BPS, zero amount, maximum BPS,
integer precision, rounding behavior, and overflow guards.

---

## Accepted Residual Risks

| Ref | Description | Decision |
|-----|-------------|---------|
| R.1 | Token freeze authority (e.g., USDC / Circle) can freeze the escrow account | Inherent to SPL; users should select tokens with a trusted or absent freeze authority |
| R.2 | Validator + seller collusion in `resolve_dispute` | Design risk; mitigated by off-chain reputation and buyer's choice of validator |
| R.3 | Deal accounts are not closed after finalization (~0.002 SOL per deal) | By design — on-chain history enables indexing; a `close_deal` instruction is planned for v2 |
| R.4 | Protocol and marketplace fees are not refunded on buyer refund | By design — fees cover the cost of using the protocol |
| R.5 | `TREASURY_PROGRAM_ID` is hardcoded in `syndaxia-core` | `syndaxia-treasury` must be treated as effectively immutable once `syndaxia-core` is frozen |
| R.6 | Token-2022 / Token Extensions not supported | Planned for v2 |

---

## Pre-Mainnet Recommendations

The following steps are **required or strongly recommended** before any mainnet
deployment:

| Priority | Action |
|----------|--------|
| 🔴 Critical | External audit by a recognized Solana security firm (e.g., OtterSec, Neodyme, Sec3) |
| 🔴 Critical | Deploy as `upgradeable` first, with the upgrade authority held by a multisig |
| 🔴 Critical | Multisig administration via Squads Protocol |
| 🟠 High | Public bug bounty program (e.g., Immunefi) |
| 🟠 High | Fuzz testing with Trident or Honggfuzz |
| 🟡 Medium | Verified build via `anchor verify` |
| 🟡 Medium | Public IDL documentation |

### Path to Immutability

```
Phase 1 — Deploy as upgradeable (authority = Squads multisig)
  ├── External audit
  ├── Bug bounty (30+ days)
  └── Mainnet beta with volume caps

Phase 2 — Stabilization (3–6 months)
  ├── On-chain event monitoring
  └── Patch if necessary

Phase 3 — Immutability
  └── Revoke upgrade authority
      ⚠️  syndaxia-treasury must also be treated as immutable at this point.
```

---

## Compilation Safety Checklist

- [x] `overflow-checks = true`
- [x] `lto = "fat"`
- [x] `codegen-units = 1`
- [x] Anchor 0.32.0 (latest stable)
- [x] No unnecessary dependencies
- [x] No `unsafe` Rust

---

*This report reflects the state of the codebase as of April 2026. It represents
an internal pre-publication review and does not replace a formal external audit.
An independent third-party audit is planned prior to mainnet deployment.*

*© 2026 Syndaxia Association & Satflows SAS. All rights reserved.*
