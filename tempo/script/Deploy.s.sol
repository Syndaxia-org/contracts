// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Satflows SAS
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/SyndaxiaFactory.sol";
import "../src/SyndaxiaGovernance.sol";

/// @notice Deploys the full Syndaxia protocol on Tempo (Governance + Factory).
///
/// Deployment order (atomic in one script):
///   1. Deploy SyndaxiaGovernance(admin)
///   2. Deploy SyndaxiaFactory(governance=SyndaxiaGovernance, feeBps, feeReceiver)
///   3. SyndaxiaGovernance.setFactory(factory)
///
/// Required environment variables:
///   PRIVATE_KEY            — deployer root key (hex, with 0x prefix)
///   ADMIN                  — governance admin (multisig / Safe)
///   PROTOCOL_FEE_RECEIVER  — address that receives the protocol fee
///
/// Optional:
///   PROTOCOL_FEE_BPS       — protocol fee in basis points (default: 10 = 0.10%)
///
/// Usage:
///   forge script script/Deploy.s.sol --rpc-url moderato --broadcast
///   forge script script/Deploy.s.sol --rpc-url tempo    --broadcast
contract Deploy is Script {
    function run() external {
        uint256 deployerKey    = vm.envUint("PRIVATE_KEY");
        address admin          = vm.envAddress("ADMIN");
        address feeReceiver    = vm.envAddress("PROTOCOL_FEE_RECEIVER");
        uint256 protocolFeeBps = vm.envOr("PROTOCOL_FEE_BPS", uint256(10));

        address deployer = vm.addr(deployerKey);
        vm.startBroadcast(deployerKey);

        // Step 1 — Governance with deployer as temporary admin so setFactory works atomically.
        //          Admin is rotated to the real multisig in step 4 (7-day timelock applies).
        SyndaxiaGovernance governance = new SyndaxiaGovernance(deployer);

        // Step 2 — Factory (governance immutable = governance contract address)
        SyndaxiaFactory factory = new SyndaxiaFactory(
            address(governance),
            protocolFeeBps,
            feeReceiver
        );

        // Step 3 — Bind factory (deployer is admin, so this succeeds)
        governance.setFactory(address(factory));

        // Step 4 — Propose admin rotation to the real multisig (7-day timelock)
        governance.proposeAdminChange(admin);

        vm.stopBroadcast();

        console2.log("SyndaxiaGovernance deployed at:", address(governance));
        console2.log("  current admin (temp):", deployer);
        console2.log("  pending admin       :", admin);
        console2.log("  (apply after 7 days via governance.applyAdminChange())");
        console2.log("");
        console2.log("SyndaxiaFactory deployed at:   ", address(factory));
        console2.log("  governance          :", address(governance));
        console2.log("  protocolFeeBps      :", protocolFeeBps);
        console2.log("  protocolFeeReceiver :", feeReceiver);
    }
}
