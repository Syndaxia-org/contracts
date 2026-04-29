# Security Policy

## Scope

This security policy applies to the Syndaxia Protocol smart contracts deployed on
Solana mainnet:

| Program | Program ID | Version |
|---|---|---|
| `syndaxia-core` | `ACFJxibNyTnVJVNTaYgBSi5YoFK3qy3xPqvmVmKynAC1` | v0.1.0 |
| `syndaxia-treasury` | `DvoZj1cKMi8DEvTxBgNEnj9Fhxx9PRAsVTEWEZ2e6YHx` | v0.1.0 |

Both programs are **verified on-chain** via [OtterSec](https://verify.osec.io) — the
deployed bytecode matches the source at commit
[`ef22d9d`](https://github.com/Syndaxia-org/contracts/tree/ef22d9d8d5e431ea1225405393f52dd3c60f18f3).

---

## Reporting a Vulnerability

**Do not disclose vulnerabilities publicly before we have had the opportunity to fix them.**

Please report security issues by email to:

> **security@syndaxia.org**

Include in your report:
- A clear description of the vulnerability
- Program(s) and instruction(s) affected
- Steps to reproduce or a proof-of-concept (localnet or devnet preferred)
- Your assessment of impact and severity
- Any suggested remediation (optional)

We will acknowledge your report within **48 hours** and provide an initial assessment
within **5 business days**.

---

## Disclosure Policy

We follow a **coordinated disclosure** process:

1. Researcher reports the vulnerability privately to `security@syndaxia.org`
2. We confirm receipt and triage severity within 48 hours
3. We develop and test a fix (target: < 7 days for Critical, < 21 days for High)
4. We deploy the fix via the Squads multisig upgrade authority
5. We notify the reporter and agree on a public disclosure date (typically 30 days after fix)
6. Public disclosure — we credit the researcher unless they prefer anonymity

---

## In-Scope Assets

### `syndaxia-core` — Escrow lifecycle

All on-chain instructions are in scope:

- `create_deal` — escrow creation and fee collection
- `release` / `release_milestone` — fund release to beneficiary
- `refund` — fund return to buyer
- `dispute` / `resolve_dispute` / `extend_dispute` — dispute flow
- `expire_deal` — permissionless expiration
- `transfer_beneficiary` — beneficiary reassignment (factoring hook)

### `syndaxia-treasury` — Governance

All on-chain instructions are in scope:

- `propose_fee_change` / `apply_fee_change` / `cancel_fee_change`
- `propose_fee_receiver_change` / `apply_fee_receiver_change` / `cancel_fee_receiver_change`
- `propose_multisig_change` / `apply_multisig_change` / `cancel_multisig_change`
- `withdraw`
- `migrate_v2`

---

## Out-of-Scope

The following are **not** in scope for the bug bounty:

- Off-chain components (web console, SDKs, APIs)
- Issues requiring physical access or social engineering
- Issues in third-party dependencies (Anchor framework, SPL token program)
- Token freeze authority risk — acknowledged design limitation (see below)
- Validator collusion — acknowledged design limitation (see below)
- Issues already listed in the Known Limitations section

---

## Known Limitations and Accepted Risks

The following are known design trade-offs, **not** reportable as vulnerabilities:

### Validator Collusion
The validator can collude with the seller to arbitrarily resolve disputes in the
seller's favour. This is a trust assumption explicitly disclosed to buyers. Markets
are expected to select validators with established reputations.

### Token Freeze Authority
If the SPL token mint has an active freeze authority, the escrow token account can
be frozen, preventing settlement. Syndaxia recommends using USDC (Circle's frozen
authority is inactive) or other freeze-authority-free tokens.

### Upgrade Authority
Both programs remain upgradeable via the Squads multisig
(`FgpQNVq9jSqqQ2jq7EDHhhSzMMf51wuEEdWjKzNYG9Wu`). An upgrade could in theory alter
program behaviour. The upgrade key requires m-of-n consensus from the Syndaxia
Association members.

### Protocol Fee Rate Changes
The protocol fee can be increased up to the hardcoded ceiling of 20 BPS (0.20%)
by the Syndaxia Association after a mandatory 7-day timelock. Existing open deals
are not affected — the fee is fixed at deal creation time.

---

## Security Architecture

### Immutable Deal Parameters
Every deal's financial parameters (amount, fees, delays, parties) are set at
creation and cannot be modified. There is no admin backdoor on individual deals.

### No Global Admin on Deals
`syndaxia-core` has no global configuration account. Each deal is fully
self-contained. Compromising the treasury multisig cannot affect open deals.

### Multisig Governance
All protocol-level changes (fee rate, fee recipient, key rotation) require:
1. A formal on-chain proposal
2. A 7-day timelock
3. M-of-N approval from the Syndaxia Association multisig (Squads Protocol)

### Verified Builds
Both programs are verified via the OtterSec registry. The source-to-bytecode
correspondence can be independently checked at:
- https://verify.osec.io/status/ACFJxibNyTnVJVNTaYgBSi5YoFK3qy3xPqvmVmKynAC1
- https://verify.osec.io/status/DvoZj1cKMi8DEvTxBgNEnj9Fhxx9PRAsVTEWEZ2e6YHx

### Automated Static Analysis
Both programs were scanned with **Sec3 X-Ray v0.0.6** (open-source, Docker image
`ghcr.io/sec3-product/x-ray:latest`) on April 29, 2026 — covering all 9 attack
surfaces in `syndaxia-core` and all 12 in `syndaxia-treasury`.

Rules checked: IntegerOverflow, IntegerUnderflow, UnverifiedParsedAccount,
BumpSeedNotValidated, InsecurePDASharing, ArbitraryCPI, IncorrectLogic, and others.

**Result: no vulnerabilities detected in either program.**

### Internal Audit
An internal security review was conducted in three passes (March–April 2026)
covering 5 Critical, 8 High, 11 Medium, and 4 Informational findings — all
remediated. See [docs/SECURITY_AUDIT.md](./docs/SECURITY_AUDIT.md) for the full report.

---

## Contact

| Channel | Address |
|---|---|
| Security reports | security@syndaxia.org |
| General | contact@syndaxia.org |
| Website | https://syndaxia.org |
| GitHub | https://github.com/Syndaxia-org |

*Syndaxia Association — Loi 1901, France*
