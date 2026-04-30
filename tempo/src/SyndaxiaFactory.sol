// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Satflows SAS
//
// Licensed under the Business Source License 1.1 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at https://mariadb.com/bsl11/
//
// Parameters:
//   Change Date:    2029-01-01
//   Change License: Apache License, Version 2.0
//   Additional Use Grant: Exclusive right for commercial exploitation is
//     granted to Satflows SAS. Commercial use by any other entity requires
//     prior written consent from Association Syndaxia (the Licensor).
pragma solidity ^0.8.24;

import "./SyndaxiaEscrow.sol";
import "./interfaces/ITIP20.sol";

/// @title  SyndaxiaFactory
/// @notice Deploys SyndaxiaEscrow instances and collects the protocol fee.
///         The protocol fee is capped at MAX_PROTOCOL_FEE_BPS — governance cannot exceed it.
///         Buyer approves this contract for (amount + marketerFee + protocolFee) before calling
///         createEscrow. All three transfers happen atomically in the same transaction.
contract SyndaxiaFactory {

    // ─────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────

    /// Absolute ceiling for the protocol fee (0.20%). Hardcoded — governance cannot exceed it.
    uint256 public constant MAX_PROTOCOL_FEE_BPS = 20;
    uint256 public constant BPS_DENOMINATOR      = 10_000;

    // ─────────────────────────────────────────────────────────────
    // Immutables
    // ─────────────────────────────────────────────────────────────

    /// Governance address (multisig / Safe) — the only account that can update protocol params.
    address public immutable governance;

    // ─────────────────────────────────────────────────────────────
    // Mutable state
    // ─────────────────────────────────────────────────────────────

    uint256 public protocolFeeBps;
    address public protocolFeeReceiver;

    // ─────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────

    error Unauthorized();
    error ProtocolFeeTooHigh();
    error InvalidReceiver();
    error TransferFailed();

    // ─────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────

    event EscrowCreated(
        address indexed escrow,
        address indexed buyer,
        address indexed seller,
        address         token,
        uint256         amount,
        uint256         protocolFee,
        uint256         marketerFee
    );
    event ProtocolFeeUpdated(uint256 newFeeBps);
    event ProtocolFeeReceiverUpdated(address newReceiver);

    // ─────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────

    constructor(address _governance, uint256 _protocolFeeBps, address _protocolFeeReceiver) {
        if (_protocolFeeBps > MAX_PROTOCOL_FEE_BPS) revert ProtocolFeeTooHigh();
        if (_protocolFeeReceiver == address(0))     revert InvalidReceiver();

        governance           = _governance;
        protocolFeeBps       = _protocolFeeBps;
        protocolFeeReceiver  = _protocolFeeReceiver;
    }

    // ─────────────────────────────────────────────────────────────
    // Escrow deployment
    // ─────────────────────────────────────────────────────────────

    /// Deploy a new SyndaxiaEscrow and fund it.
    /// Caller is the buyer. Requires prior approval of (amount + marketerFee + protocolFee).
    function createEscrow(
        address    seller,
        address    validator,
        address    feeCollector,
        address    token,
        uint256    amount,
        uint256    feeBps,
        bytes32    metadataHash,
        uint256    releaseDelay,
        uint256    timeout,
        uint256    disputeDelay,
        uint256    disputeResolutionWindow,
        uint8      milestoneCount,
        uint256[8] memory milestoneAmounts
    ) external returns (address escrow) {
        uint256 marketerFee  = (amount * feeBps)          / BPS_DENOMINATOR;
        uint256 protocolFee  = (amount * protocolFeeBps)   / BPS_DENOMINATOR;
        uint256 totalRequired = amount + marketerFee + protocolFee;

        // Pull all funds from buyer — single approval, single transferFrom.
        if (!IERC20(token).transferFrom(msg.sender, address(this), totalRequired)) {
            revert TransferFailed();
        }

        // Deploy escrow (validates all params in constructor).
        escrow = address(new SyndaxiaEscrow(
            msg.sender,
            seller,
            validator,
            feeCollector,
            token,
            amount,
            feeBps,
            metadataHash,
            releaseDelay,
            timeout,
            disputeDelay,
            disputeResolutionWindow,
            milestoneCount,
            milestoneAmounts
        ));

        // Distribute fees and fund escrow.
        if (protocolFee > 0) {
            if (!IERC20(token).transfer(protocolFeeReceiver, protocolFee)) revert TransferFailed();
        }
        if (marketerFee > 0) {
            if (!IERC20(token).transfer(feeCollector, marketerFee)) revert TransferFailed();
        }
        if (!IERC20(token).transfer(escrow, amount)) revert TransferFailed();

        emit EscrowCreated(escrow, msg.sender, seller, token, amount, protocolFee, marketerFee);
    }

    // ─────────────────────────────────────────────────────────────
    // Governance
    // ─────────────────────────────────────────────────────────────

    function setProtocolFee(uint256 newFeeBps) external {
        if (msg.sender != governance)             revert Unauthorized();
        if (newFeeBps > MAX_PROTOCOL_FEE_BPS)     revert ProtocolFeeTooHigh();
        protocolFeeBps = newFeeBps;
        emit ProtocolFeeUpdated(newFeeBps);
    }

    function setProtocolFeeReceiver(address newReceiver) external {
        if (msg.sender != governance)     revert Unauthorized();
        if (newReceiver == address(0))    revert InvalidReceiver();
        protocolFeeReceiver = newReceiver;
        emit ProtocolFeeReceiverUpdated(newReceiver);
    }
}
