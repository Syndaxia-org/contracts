// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Satflows SAS
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/SyndaxiaFactory.sol";
import "../src/SyndaxiaEscrow.sol";
import "../src/interfaces/ITIP20.sol";

/// @notice End-to-end deal simulation on Tempo (Moderato testnet or mainnet).
///         Runs two scenarios back-to-back:
///           A) Simple deal    — 1 pathUSD, single tranche, immediate release
///           B) Milestone deal — 1 pathUSD, 3 milestones, each released in sequence
///
/// Required environment variables:
///   PRIVATE_KEY   — buyer/deployer key (must hold pathUSD and be approved spender)
///   SELLER        — seller address (receives funds on release)
///
/// Optional:
///   VALIDATOR     — validator address (default: 0xdEaD — not called in this simulation)
///   FACTORY       — factory address (default: Moderato deployment)
///   TOKEN         — TIP-20 token address (default: pathUSD on Moderato)
///
/// Usage:
///   forge script script/SimulateDeal.s.sol --rpc-url moderato --broadcast -vvvv
contract SimulateDeal is Script {

    // ── Moderato testnet defaults ─────────────────────────────────────────────
    address constant DEFAULT_FACTORY = 0x73fB24e14eD6767D695dC99Ec15bf89333cae977;
    address constant DEFAULT_TOKEN   = 0x20C0000000000000000000000000000000000000; // pathUSD
    address constant DEFAULT_VALIDATOR = 0x000000000000000000000000000000000000dEaD;

    uint256 constant AMOUNT     = 1_000_000;  // 1.000000 pathUSD (6 decimals)
    uint256 constant PROTOCOL_FEE_BPS = 10;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address buyer       = vm.addr(deployerKey);
        address seller      = vm.envAddress("SELLER");
        address validator   = vm.envOr("VALIDATOR",   DEFAULT_VALIDATOR);
        address factory     = vm.envOr("FACTORY",     DEFAULT_FACTORY);
        address token       = vm.envOr("TOKEN",       DEFAULT_TOKEN);

        console2.log("=== Syndaxia Deal Simulation ===");
        console2.log("buyer    :", buyer);
        console2.log("seller   :", seller);
        console2.log("validator:", validator);
        console2.log("factory  :", factory);
        console2.log("token    :", token);
        console2.log("");

        _simulateSimpleDeal(deployerKey, buyer, seller, validator, factory, token);
        _simulateMilestoneDeal(deployerKey, buyer, seller, validator, factory, token);
    }

    // ── A) Simple deal ────────────────────────────────────────────────────────

    function _simulateSimpleDeal(
        uint256 key,
        address /* buyer */,
        address seller,
        address validator,
        address factory,
        address token
    ) internal {
        console2.log("--- Scenario A: Simple deal (single tranche) ---");

        uint256 protocolFee   = AMOUNT * PROTOCOL_FEE_BPS / 10_000; // 1_000
        uint256 totalRequired = AMOUNT + protocolFee;

        uint256[8] memory ms;

        vm.startBroadcast(key);

        // 1. Approve factory to pull total from buyer
        IERC20(token).approve(factory, totalRequired);

        // 2. Create escrow — releaseDelay=0 so buyer can release immediately
        address escrow = SyndaxiaFactory(factory).createEscrow(
            seller,
            validator,
            seller,                                   // feeCollector (feeBps=0 → irrelevant)
            token,
            AMOUNT,
            0,                                        // feeBps (no marketplace fee)
            keccak256("Syndaxia testnet deal #simple-A"),
            0,                                        // releaseDelay (immediate)
            1 days,                                   // timeout
            0,                                        // disputeDelay
            7 days,                                   // disputeResolutionWindow (minimum)
            0,                                        // milestoneCount (simple deal)
            ms
        );

        console2.log("Escrow created :", escrow);
        console2.log("  balance      :", IERC20(token).balanceOf(escrow), "units");
        console2.log("  status       : Open");

        // 3. Release — buyer releases to seller (validator not needed for simple release)
        uint256 sellerBefore = IERC20(token).balanceOf(seller);
        SyndaxiaEscrow(escrow).release();
        uint256 sellerAfter  = IERC20(token).balanceOf(seller);

        vm.stopBroadcast();

        console2.log("Release executed:");
        console2.log("  escrow balance  :", IERC20(token).balanceOf(escrow), "(should be 0)");
        console2.log("  seller received :", sellerAfter - sellerBefore, "units");
        console2.log("  status          : Released");
        console2.log("");
    }

    // ── B) Milestone deal ─────────────────────────────────────────────────────

    function _simulateMilestoneDeal(
        uint256 key,
        address /* buyer */,
        address seller,
        address validator,
        address factory,
        address token
    ) internal {
        console2.log("--- Scenario B: Milestone deal (3 tranches) ---");

        // Split 1_000_000 into 3 milestones: 40% / 40% / 20%
        uint256[8] memory ms;
        ms[0] = 400_000; // milestone 0: 0.40 pathUSD
        ms[1] = 400_000; // milestone 1: 0.40 pathUSD
        ms[2] = 200_000; // milestone 2: 0.20 pathUSD

        uint256 protocolFee   = AMOUNT * PROTOCOL_FEE_BPS / 10_000;
        uint256 totalRequired = AMOUNT + protocolFee;

        vm.startBroadcast(key);

        // 1. Approve
        IERC20(token).approve(factory, totalRequired);

        // 2. Create milestone escrow
        address escrow = SyndaxiaFactory(factory).createEscrow(
            seller,
            validator,
            seller,
            token,
            AMOUNT,
            0,
            keccak256("Syndaxia testnet deal #milestone-B"),
            0,        // releaseDelay
            1 days,
            0,        // disputeDelay
            7 days,
            3,        // milestoneCount
            ms
        );

        console2.log("Escrow created :", escrow);
        console2.log("  balance      :", IERC20(token).balanceOf(escrow), "units");
        console2.log("  milestones   : 3 (400k / 400k / 200k)");

        // 3. Release milestone 0 (40%)
        uint256 sellerBefore = IERC20(token).balanceOf(seller);
        SyndaxiaEscrow(escrow).releaseMilestone(0);
        console2.log("Milestone 0 released (+400_000). Remaining:", IERC20(token).balanceOf(escrow));

        // 4. Release milestone 1 (40%)
        SyndaxiaEscrow(escrow).releaseMilestone(1);
        console2.log("Milestone 1 released (+400_000). Remaining:", IERC20(token).balanceOf(escrow));

        // 5. Release milestone 2 (20%) — closes the deal
        SyndaxiaEscrow(escrow).releaseMilestone(2);
        uint256 sellerAfter = IERC20(token).balanceOf(seller);

        vm.stopBroadcast();

        console2.log("Milestone 2 released (+200_000). Remaining:", IERC20(token).balanceOf(escrow), "(should be 0)");
        console2.log("Total received by seller:", sellerAfter - sellerBefore, "units");
        console2.log("Status: Released (all milestones done)");
        console2.log("");
        console2.log("=== Simulation complete ===");
    }
}
