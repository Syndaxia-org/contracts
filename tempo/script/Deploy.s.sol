// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Satflows SAS
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/SyndaxiaFactory.sol";

/// @notice Deploys SyndaxiaFactory on Tempo (mainnet or Moderato testnet).
///
/// Required environment variables:
///   PRIVATE_KEY            — deployer root key (hex, with 0x prefix)
///   GOVERNANCE             — multisig address that controls protocol params
///   PROTOCOL_FEE_RECEIVER  — address that receives the protocol fee
///
/// Optional:
///   PROTOCOL_FEE_BPS       — protocol fee in basis points (default: 10 = 0.10%)
///
/// Usage:
///   forge script script/Deploy.s.sol --rpc-url moderato --broadcast
///   forge script script/Deploy.s.sol --rpc-url tempo    --broadcast --verify
contract Deploy is Script {
    function run() external {
        uint256 deployerKey      = vm.envUint("PRIVATE_KEY");
        address governance       = vm.envAddress("GOVERNANCE");
        address feeReceiver      = vm.envAddress("PROTOCOL_FEE_RECEIVER");
        uint256 protocolFeeBps   = vm.envOr("PROTOCOL_FEE_BPS", uint256(10));

        vm.startBroadcast(deployerKey);

        SyndaxiaFactory factory = new SyndaxiaFactory(
            governance,
            protocolFeeBps,
            feeReceiver
        );

        vm.stopBroadcast();

        console2.log("SyndaxiaFactory deployed at:", address(factory));
        console2.log("  governance          :", governance);
        console2.log("  protocolFeeBps      :", protocolFeeBps);
        console2.log("  protocolFeeReceiver :", feeReceiver);
    }
}
