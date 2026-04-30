# Syndaxia Tempo — Deal Simulation Guide

> End-to-end walkthrough of the Syndaxia escrow lifecycle on Tempo (Moderato testnet).
> Transactions verified on-chain — not a dry run.

---

## Prerequisites

```bash
# Foundry nightly (already installed if you followed the setup guide)
export PATH="$HOME/.foundry/bin:$PATH"

# Environment variables
export PRIVATE_KEY=0x...          # buyer private key (must hold pathUSD)
export SELLER=0x...               # seller address
export FACTORY=0x872E66cB7be460CC4a17fa858254028B002E0463  # Moderato
```

Ensure the buyer wallet holds **pathUSD** (testnet stablecoin, 6 decimals):
```bash
cast call 0x20C0000000000000000000000000000000000000 \
  "balanceOf(address)(uint256)" $BUYER_ADDRESS \
  --rpc-url https://rpc.moderato.tempo.xyz
# 5000000 = 5.000000 pathUSD
```

---

## Run the full simulation

```bash
cd contracts/tempo
forge script script/SimulateDeal.s.sol --rpc-url moderato --broadcast
```

The script executes two independent scenarios:
- **Scenario A** — simple single-tranche deal (approve → create → release)
- **Scenario B** — 3-milestone deal (approve → create → release ×3)

---

## Scenario A — Simple Deal

### 1. Approve the Factory

The buyer approves `SyndaxiaFactory` to pull `amount + protocolFee` from their wallet:

```
amount       = 1_000_000 (1.000000 pathUSD)
protocolFee  = 1_000_000 × 10 / 10_000 = 1_000 (0.001000 pathUSD)
totalApprove = 1_001_000
```

```bash
cast send 0x20C0000000000000000000000000000000000000 \
  "approve(address,uint256)" \
  0x872E66cB7be460CC4a17fa858254028B002E0463 1001000 \
  --rpc-url https://rpc.moderato.tempo.xyz \
  --private-key $PRIVATE_KEY
```

### 2. Create the Escrow

`SyndaxiaFactory.createEscrow()` atomically:
1. Pulls `1_001_000` pathUSD from buyer
2. Deploys a new `SyndaxiaEscrow` instance
3. Sends `1_000` pathUSD → `protocolFeeReceiver` (protocol fee)
4. Sends `1_000_000` pathUSD → escrow contract

```
Testnet execution (Scenario A):
  Escrow: 0x79b436c348cF9236B7102df4eDcd7b942F82fdac
  Events: DealCreated, EscrowCreated, Transfer×3
```

Key parameters used:
| Parameter | Value | Notes |
|-----------|-------|-------|
| `amount` | 1_000_000 | 1 pathUSD |
| `feeBps` | 0 | No marketplace fee |
| `releaseDelay` | 0 | Immediate release allowed |
| `timeout` | 86_400 | 1 day |
| `disputeResolutionWindow` | 604_800 | 7 days (minimum) |
| `milestoneCount` | 0 | Single-tranche deal |
| `metadataHash` | `keccak256("Syndaxia testnet deal #simple-A")` | Links to off-chain docs |

### 3. Release

The buyer calls `release()` directly (no validator needed for buyer-initiated release):

```bash
cast send 0x79b436c348cF9236B7102df4eDcd7b942F82fdac \
  "release()" \
  --rpc-url https://rpc.moderato.tempo.xyz \
  --private-key $PRIVATE_KEY
```

Internally, `_transferOut` calls `transferWithMemo` with the escrow address as memo:
```
transferWithMemo(seller, 1_000_000, 0x0000...79b436c3...)
  → event TransferWithMemo(from: escrow, to: seller, amount: 1_000_000, memo: <escrow_addr>)
```

The memo enables **automatic deal reconciliation** on the backend: every pathUSD received by the seller can be mapped to its originating escrow without scanning all transfers.

```
Result:
  escrow balance → 0
  seller received → 1_000_000 pathUSD
  status → Released
```

---

## Scenario B — Milestone Deal (3 tranches)

### Deal structure

```
Total amount : 1_000_000 pathUSD
Milestone 0  :   400_000 (40%)
Milestone 1  :   400_000 (40%)
Milestone 2  :   200_000 (20%)
```

```
Testnet execution (Scenario B):
  Escrow: 0x1eC5f6755E235034a71e3314FBa993B7163Aa97A
```

### Release sequence

Each `releaseMilestone(index)` call releases one tranche and updates `releasedMask`:

| Call | `releasedMask` before | Released | Remaining in escrow |
|------|-----------------------|----------|---------------------|
| `releaseMilestone(0)` | `0b000` | 400_000 | 600_000 |
| `releaseMilestone(1)` | `0b001` | 400_000 | 200_000 |
| `releaseMilestone(2)` | `0b011` | 200_000 | 0 → status: Released |

The escrow closes automatically when `releasedMask == (1 << milestoneCount) - 1` (all bits set).

```bash
# Release milestone 0
cast send $ESCROW "releaseMilestone(uint8)" 0 --rpc-url https://rpc.moderato.tempo.xyz --private-key $PRIVATE_KEY

# Release milestone 1
cast send $ESCROW "releaseMilestone(uint8)" 1 --rpc-url https://rpc.moderato.tempo.xyz --private-key $PRIVATE_KEY

# Release milestone 2
cast send $ESCROW "releaseMilestone(uint8)" 2 --rpc-url https://rpc.moderato.tempo.xyz --private-key $PRIVATE_KEY
```

---

## Other flows (manual)

### Dispute & resolve

```bash
# Open a dispute (buyer or seller)
cast send $ESCROW "dispute()" --rpc-url moderato-rpc --private-key $BUYER_KEY

# Validator resolves: 60% seller / 40% buyer refund
cast send $ESCROW "resolveDispute(uint256,uint256)" 600000 400000 \
  --rpc-url https://rpc.moderato.tempo.xyz --private-key $VALIDATOR_KEY
```

### Expire (permissionless)

After `createdAt + releaseDelay + timeout` has elapsed, anyone can trigger expiry and refund the buyer:

```bash
cast send $ESCROW "expire()" --rpc-url https://rpc.moderato.tempo.xyz --private-key $ANY_KEY
```

### Refund (seller-initiated)

The seller can voluntarily refund the buyer at any time:

```bash
cast send $ESCROW "refund()" --rpc-url https://rpc.moderato.tempo.xyz --private-key $SELLER_KEY
```

### Transfer beneficiary (factoring)

The current beneficiary can transfer their payment right to another address:

```bash
cast send $ESCROW "transferBeneficiary(address)" $NEW_BENEFICIARY \
  --rpc-url https://rpc.moderato.tempo.xyz --private-key $SELLER_KEY
```

---

## Read escrow state (cast)

```bash
ESCROW=0x79b436c348cF9236B7102df4eDcd7b942F82fdac
RPC=https://rpc.moderato.tempo.xyz

# Status (0=Open 1=Released 2=Refunded 3=Disputed)
cast call $ESCROW "status()(uint8)" --rpc-url $RPC

# Remaining balance
cast call $ESCROW "remainingEscrowAmount()(uint256)" --rpc-url $RPC

# Beneficiary (current payee — may differ from seller after transferBeneficiary)
cast call $ESCROW "beneficiary()(address)" --rpc-url $RPC

# Released milestone mask
cast call $ESCROW "releasedMask()(uint8)" --rpc-url $RPC

# Milestone amount at index
cast call $ESCROW "milestoneAmount(uint8)(uint256)" 0 --rpc-url $RPC
```

---

## Deployed contracts (Moderato — chain ID 42431)

| Contract | Address |
|----------|---------|
| `SyndaxiaGovernance` | `0x6F9d129Cb1596E73FfE02f969dBcF02BcEE89FcB` |
| `SyndaxiaFactory` | `0x872E66cB7be460CC4a17fa858254028B002E0463` |
| `SyndaxiaEscrow` (simple, scenario A) | `0x79b436c348cF9236B7102df4eDcd7b942F82fdac` |
| `SyndaxiaEscrow` (milestone, scenario B) | `0x1eC5f6755E235034a71e3314FBa993B7163Aa97A` |
| `pathUSD` (testnet stablecoin) | `0x20C0000000000000000000000000000000000000` |

---

## Implementation note: `transferWithMemo` and low-level calls

During testnet simulation, a subtle incompatibility was discovered: the pathUSD `transferWithMemo` implementation returns `void` rather than `bool`, contrary to the ITIP20 interface definition. A Solidity `try/catch` on a `returns (bool)` function panics with an ABI-decoding error when the actual return data is empty — this panic is **not caught** by the catch block.

The fix in `_transferOut` uses a low-level `.call()` instead:

```solidity
(bool ok, ) = address(token).call(
    abi.encodeWithSignature("transferWithMemo(address,uint256,bytes32)", to, value, memo)
);
if (!ok) {
    ok = token.transfer(to, value);  // fallback to standard ERC-20
    if (!ok) revert TransferFailed();
}
```

This approach handles all variants: `transferWithMemo` returning `bool`, returning `void`, or reverting.
