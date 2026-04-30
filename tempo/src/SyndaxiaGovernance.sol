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

interface ISyndaxiaFactory {
    function setProtocolFee(uint256 newFeeBps) external;
    function setProtocolFeeReceiver(address newReceiver) external;
}

/// @title  SyndaxiaGovernance
/// @notice Timelocked governance for SyndaxiaFactory protocol parameters.
///         Mirrors the syndaxia-treasury Solana program: every sensitive change
///         goes through a propose → wait 7 days → apply flow.
///         The apply step is permissionless — anyone can execute once the delay elapses.
///
/// @dev    Deployment order:
///           1. Deploy SyndaxiaGovernance(admin, factory=address(0))
///           2. Deploy SyndaxiaFactory(governance=SyndaxiaGovernance address, ...)
///           3. Call SyndaxiaGovernance.setFactory(SyndaxiaFactory address)
///              (one-time; thereafter factory is immutable)
contract SyndaxiaGovernance {

    // ─────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────

    uint256 public constant TIMELOCK_DELAY       = 7 days;
    uint256 public constant MAX_PROTOCOL_FEE_BPS = 20;

    // ─────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────

    address public admin;
    address public factory;

    struct FeeProposal {
        uint256 newFeeBps;
        uint40  readyAt;
        bool    exists;
    }

    struct AddressProposal {
        address newAddress;
        uint40  readyAt;
        bool    exists;
    }

    FeeProposal     public pendingFee;
    AddressProposal public pendingReceiver;
    AddressProposal public pendingAdmin;

    // ─────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────

    error Unauthorized();
    error FactoryAlreadySet();
    error InvalidAddress();
    error FeeTooHigh();
    error NoOpProposal();
    error ProposalAlreadyPending();
    error NoPendingProposal();
    error TimelockNotElapsed();

    // ─────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────

    event FactorySet(address indexed factory);

    event FeeChangeProposed(uint256 newFeeBps, uint256 executableAfter);
    event FeeChangeCancelled();
    event FeeChangeApplied(uint256 oldFeeBps, uint256 newFeeBps);

    event ReceiverChangeProposed(address newReceiver, uint256 executableAfter);
    event ReceiverChangeCancelled();
    event ReceiverChangeApplied(address oldReceiver, address newReceiver);

    event AdminChangeProposed(address newAdmin, uint256 executableAfter);
    event AdminChangeCancelled();
    event AdminRotated(address oldAdmin, address newAdmin);

    // ─────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────

    constructor(address _admin) {
        if (_admin == address(0)) revert InvalidAddress();
        admin = _admin;
    }

    // ─────────────────────────────────────────────────────────────
    // One-time factory binding
    // ─────────────────────────────────────────────────────────────

    /// Bind the factory address. Can only be called once by admin.
    function setFactory(address _factory) external {
        if (msg.sender != admin)    revert Unauthorized();
        if (factory != address(0))  revert FactoryAlreadySet();
        if (_factory == address(0)) revert InvalidAddress();
        factory = _factory;
        emit FactorySet(_factory);
    }

    // ─────────────────────────────────────────────────────────────
    // Protocol fee governance
    // ─────────────────────────────────────────────────────────────

    function proposeFeeChange(uint256 newFeeBps) external {
        if (msg.sender != admin)                          revert Unauthorized();
        if (newFeeBps > MAX_PROTOCOL_FEE_BPS)             revert FeeTooHigh();
        if (pendingFee.exists)                            revert ProposalAlreadyPending();

        // forge-lint: disable-next-line(unsafe-typecast) — safe: timestamp + 7 days fits in uint40 until year 36812
        uint40 readyAt = uint40(block.timestamp + TIMELOCK_DELAY);
        pendingFee = FeeProposal(newFeeBps, readyAt, true);
        emit FeeChangeProposed(newFeeBps, readyAt);
    }

    function cancelFeeChange() external {
        if (msg.sender != admin)  revert Unauthorized();
        if (!pendingFee.exists)   revert NoPendingProposal();
        delete pendingFee;
        emit FeeChangeCancelled();
    }

    /// Permissionless once timelock has elapsed.
    function applyFeeChange() external {
        if (!pendingFee.exists)                        revert NoPendingProposal();
        if (block.timestamp < pendingFee.readyAt)      revert TimelockNotElapsed();

        uint256 newFeeBps = pendingFee.newFeeBps;
        delete pendingFee;

        ISyndaxiaFactory(factory).setProtocolFee(newFeeBps);
        emit FeeChangeApplied(0, newFeeBps); // old value readable from Factory
    }

    // ─────────────────────────────────────────────────────────────
    // Fee receiver governance
    // ─────────────────────────────────────────────────────────────

    function proposeReceiverChange(address newReceiver) external {
        if (msg.sender != admin)         revert Unauthorized();
        if (newReceiver == address(0))   revert InvalidAddress();
        if (pendingReceiver.exists)      revert ProposalAlreadyPending();

        // forge-lint: disable-next-line(unsafe-typecast) — safe: timestamp + 7 days fits in uint40 until year 36812
        uint40 readyAt = uint40(block.timestamp + TIMELOCK_DELAY);
        pendingReceiver = AddressProposal(newReceiver, readyAt, true);
        emit ReceiverChangeProposed(newReceiver, readyAt);
    }

    function cancelReceiverChange() external {
        if (msg.sender != admin)      revert Unauthorized();
        if (!pendingReceiver.exists)  revert NoPendingProposal();
        delete pendingReceiver;
        emit ReceiverChangeCancelled();
    }

    /// Permissionless once timelock has elapsed.
    function applyReceiverChange() external {
        if (!pendingReceiver.exists)                       revert NoPendingProposal();
        if (block.timestamp < pendingReceiver.readyAt)     revert TimelockNotElapsed();

        address newReceiver = pendingReceiver.newAddress;
        delete pendingReceiver;

        ISyndaxiaFactory(factory).setProtocolFeeReceiver(newReceiver);
        emit ReceiverChangeApplied(address(0), newReceiver); // old readable from Factory
    }

    // ─────────────────────────────────────────────────────────────
    // Admin rotation (timelocked)
    // ─────────────────────────────────────────────────────────────

    function proposeAdminChange(address newAdmin) external {
        if (msg.sender != admin)      revert Unauthorized();
        if (newAdmin == address(0))   revert InvalidAddress();
        if (newAdmin == admin)        revert NoOpProposal();
        if (pendingAdmin.exists)      revert ProposalAlreadyPending();

        // forge-lint: disable-next-line(unsafe-typecast) — safe: timestamp + 7 days fits in uint40 until year 36812
        uint40 readyAt = uint40(block.timestamp + TIMELOCK_DELAY);
        pendingAdmin = AddressProposal(newAdmin, readyAt, true);
        emit AdminChangeProposed(newAdmin, readyAt);
    }

    function cancelAdminChange() external {
        if (msg.sender != admin)     revert Unauthorized();
        if (!pendingAdmin.exists)    revert NoPendingProposal();
        delete pendingAdmin;
        emit AdminChangeCancelled();
    }

    /// Permissionless once timelock has elapsed.
    function applyAdminChange() external {
        if (!pendingAdmin.exists)                      revert NoPendingProposal();
        if (block.timestamp < pendingAdmin.readyAt)    revert TimelockNotElapsed();

        address oldAdmin = admin;
        address newAdmin = pendingAdmin.newAddress;
        delete pendingAdmin;

        admin = newAdmin;
        emit AdminRotated(oldAdmin, newAdmin);
    }
}
