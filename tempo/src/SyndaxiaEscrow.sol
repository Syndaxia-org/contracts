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

import "./interfaces/ITIP20.sol";

/// @title  SyndaxiaEscrow
/// @notice Immutable, single-use escrow for P2P & B2B commerce on Tempo.
///         Supports simple deals and milestone-based deals (up to 8 milestones).
///         All deal parameters are fixed at construction. No admin keys, no upgrades.
/// @dev    Designed for the Tempo chain (EVM, no native gas token). All transfers
///         use TIP-20 / IERC20. BALANCE and CALLVALUE opcodes always return 0 on Tempo —
///         use token.balanceOf(address(this)) for escrow balance.
///         Storage is minimized (2 mutable slots) because Tempo charges 250k gas per new slot.
contract SyndaxiaEscrow {

    // ─────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────

    uint256 public constant MAX_FEE_BPS                   = 1_000;  // 10%
    uint256 public constant BPS_DENOMINATOR               = 10_000;
    uint256 public constant MAX_RELEASE_DELAY             = 365 days;
    uint256 public constant MIN_TIMEOUT                   = 1 hours;
    uint256 public constant MAX_TIMEOUT                   = 365 days;
    uint256 public constant MAX_DISPUTE_DELAY             = 365 days;
    uint256 public constant MIN_DISPUTE_RESOLUTION_WINDOW = 7 days;
    uint256 public constant MAX_DISPUTE_RESOLUTION_WINDOW = 365 days;
    uint8   public constant MAX_DISPUTE_EXTENSIONS        = 1;
    uint8   public constant MAX_MILESTONES                = 8;

    // ─────────────────────────────────────────────────────────────
    // Types
    // ─────────────────────────────────────────────────────────────

    enum Status { Open, Released, Refunded, Disputed }

    // ─────────────────────────────────────────────────────────────
    // Immutables — stored in contract bytecode, zero storage cost
    // ─────────────────────────────────────────────────────────────

    address  public immutable buyer;
    address  public immutable seller;
    address  public immutable validator;
    address  public immutable feeCollector;
    IERC20   public immutable token;
    uint256  public immutable amount;
    uint256  public immutable feeBps;
    bytes32  public immutable metadataHash;
    uint256  public immutable createdAt;
    uint256  public immutable releaseDelay;
    uint256  public immutable timeout;
    uint256  public immutable disputeDelay;
    uint8    public immutable milestoneCount;

    // Solidity 0.8.x does not support immutable arrays.
    // 8 separate immutables avoid the 250k-gas-per-slot storage cost on Tempo.
    uint256 private immutable _ms0;
    uint256 private immutable _ms1;
    uint256 private immutable _ms2;
    uint256 private immutable _ms3;
    uint256 private immutable _ms4;
    uint256 private immutable _ms5;
    uint256 private immutable _ms6;
    uint256 private immutable _ms7;

    // ─────────────────────────────────────────────────────────────
    // Mutable storage — packed into 2 slots
    //
    // Slot 0 (23 bytes used):
    //   beneficiary                  address  20B
    //   status                       uint8     1B
    //   releasedMask                 uint8     1B
    //   disputeExtensionsRemaining   uint8     1B
    //
    // Slot 1 (10 bytes used):
    //   disputedAt                   uint40    5B
    //   disputeResolutionWindow      uint40    5B
    // ─────────────────────────────────────────────────────────────

    address public beneficiary;
    Status  public status;
    uint8   public releasedMask;
    uint8   public disputeExtensionsRemaining;

    uint40  public disputedAt;
    uint40  public disputeResolutionWindow;

    // ─────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────

    error InvalidToken();
    error InvalidAmount();
    error InvalidFeeBps();
    error InvalidReleaseDelay();
    error InvalidTimeout();
    error InvalidDisputeDelay();
    error InvalidDisputeResolutionWindow();
    error BuyerEqualsSeller();
    error InvalidValidator();
    error ValidatorEqualsSeller();
    error TooManyMilestones();
    error InvalidMilestoneAmount();
    error MilestoneSumMismatch();
    error InvalidMilestoneIndex();
    error MilestoneAlreadyReleased();
    error NotMilestoneDeal();
    error UseMilestoneRelease();
    error Unauthorized();
    error NotOpen();
    error NotEligible();
    error NotDisputed();
    error ReleaseTooEarly();
    error DealExpired();
    error DealNotExpired();
    error DisputeTooEarly();
    error InvalidSplit();
    error DisputeExpired();
    error NoExtensionsRemaining();
    error DisputeExtensionTooLong();
    error BeneficiaryEqualsBuyer();
    error BeneficiaryEqualsValidator();
    error TransferFailed();

    // ─────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────

    event DealCreated(
        address indexed buyer,
        address indexed seller,
        address indexed validator,
        address         token,
        uint256         amount,
        uint256         feeBps,
        bytes32         metadataHash,
        uint8           milestoneCount
    );
    event DealReleased(
        address indexed beneficiary,
        uint256         amount,
        address         authority
    );
    event MilestoneReleased(
        uint8   indexed milestoneIndex,
        uint256         amount,
        uint8           releasedMask,
        bool            allReleased,
        address         authority
    );
    event DealDisputed(
        address indexed openedBy,
        uint256         resolutionDeadline
    );
    event DisputeResolved(
        address indexed validator,
        address indexed beneficiary,
        uint256         buyerShare,
        uint256         sellerShare
    );
    event DealRefunded(uint256 amount, address authority);
    event EscrowExpired(uint256 amount);
    event BeneficiaryTransferred(
        address indexed oldBeneficiary,
        address indexed newBeneficiary
    );
    event DisputeExtended(uint256 newDeadline, uint8 extensionsRemaining);

    // ─────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────

    constructor(
        address    _buyer,
        address    _seller,
        address    _validator,
        address    _feeCollector,
        address    _token,
        uint256    _amount,
        uint256    _feeBps,
        bytes32    _metadataHash,
        uint256    _releaseDelay,
        uint256    _timeout,
        uint256    _disputeDelay,
        uint256    _disputeResolutionWindow,
        uint8      _milestoneCount,
        uint256[8] memory _milestoneAmounts
    ) {
        if (_token == address(0))              revert InvalidToken();
        if (_amount == 0)                      revert InvalidAmount();
        if (_feeBps > MAX_FEE_BPS)             revert InvalidFeeBps();
        if (_buyer == _seller)                 revert BuyerEqualsSeller();
        if (_buyer == _validator)              revert InvalidValidator();
        if (_seller == _validator)             revert ValidatorEqualsSeller();
        if (_releaseDelay > MAX_RELEASE_DELAY) revert InvalidReleaseDelay();
        if (_timeout < MIN_TIMEOUT || _timeout > MAX_TIMEOUT) revert InvalidTimeout();
        if (_disputeDelay > MAX_DISPUTE_DELAY) revert InvalidDisputeDelay();
        if (_disputeResolutionWindow < MIN_DISPUTE_RESOLUTION_WINDOW ||
            _disputeResolutionWindow > MAX_DISPUTE_RESOLUTION_WINDOW) {
            revert InvalidDisputeResolutionWindow();
        }
        if (_milestoneCount > MAX_MILESTONES) revert TooManyMilestones();

        if (_milestoneCount > 0) {
            uint256 sum;
            for (uint8 i; i < _milestoneCount; ++i) {
                if (_milestoneAmounts[i] == 0) revert InvalidMilestoneAmount();
                sum += _milestoneAmounts[i];
            }
            if (sum != _amount) revert MilestoneSumMismatch();
        }

        buyer          = _buyer;
        seller         = _seller;
        validator      = _validator;
        feeCollector   = _feeCollector;
        token          = IERC20(_token);
        amount         = _amount;
        feeBps         = _feeBps;
        metadataHash   = _metadataHash;
        createdAt      = block.timestamp;
        releaseDelay   = _releaseDelay;
        timeout        = _timeout;
        disputeDelay   = _disputeDelay;
        milestoneCount = _milestoneCount;

        _ms0 = _milestoneAmounts[0];
        _ms1 = _milestoneAmounts[1];
        _ms2 = _milestoneAmounts[2];
        _ms3 = _milestoneAmounts[3];
        _ms4 = _milestoneAmounts[4];
        _ms5 = _milestoneAmounts[5];
        _ms6 = _milestoneAmounts[6];
        _ms7 = _milestoneAmounts[7];

        // Slot 0 — beneficiary and disputeExtensionsRemaining are non-zero at creation.
        // status (Open=0) and releasedMask (0) are written implicitly.
        beneficiary                = _seller;
        disputeExtensionsRemaining = MAX_DISPUTE_EXTENSIONS;

        // Slot 1 — disputeResolutionWindow is non-zero; disputedAt starts at 0.
        // forge-lint: disable-next-line(unsafe-typecast) — safe: MAX_DISPUTE_RESOLUTION_WINDOW = 365 days < 2^40
        disputeResolutionWindow = uint40(_disputeResolutionWindow);

        emit DealCreated(_buyer, _seller, _validator, _token, _amount, _feeBps, _metadataHash, _milestoneCount);
    }

    // ─────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────

    function milestoneAmount(uint8 index) public view returns (uint256) {
        if (index == 0) return _ms0;
        if (index == 1) return _ms1;
        if (index == 2) return _ms2;
        if (index == 3) return _ms3;
        if (index == 4) return _ms4;
        if (index == 5) return _ms5;
        if (index == 6) return _ms6;
        if (index == 7) return _ms7;
        revert InvalidMilestoneIndex();
    }

    /// Funds currently held in escrow. Accounts for partial milestone releases.
    /// On Tempo, BALANCE opcode always returns 0 — always use token.balanceOf.
    function remainingEscrowAmount() public view returns (uint256) {
        return token.balanceOf(address(this));
    }

    // ─────────────────────────────────────────────────────────────
    // Actions
    // ─────────────────────────────────────────────────────────────

    /// Release the full escrowed amount to the beneficiary. Simple deals only.
    /// Authorized: buyer or validator. From Disputed: validator only.
    function release() external {
        Status s = status;
        if (s != Status.Open && s != Status.Disputed) revert NotEligible();
        if (milestoneCount > 0) revert UseMilestoneRelease();

        if (s == Status.Disputed) {
            if (msg.sender != validator) revert Unauthorized();
        } else {
            if (msg.sender != buyer && msg.sender != validator) revert Unauthorized();
            _checkReleaseTiming();
        }

        address bene = beneficiary;
        status = Status.Released;

        _transferOut(bene, amount);
        emit DealReleased(bene, amount, msg.sender);
    }

    /// Release a single milestone. Milestone deals only.
    /// Authorized: buyer or validator. From Disputed: validator only.
    function releaseMilestone(uint8 index) external {
        Status s = status;
        if (s != Status.Open && s != Status.Disputed) revert NotEligible();
        if (milestoneCount == 0)      revert NotMilestoneDeal();
        if (index >= milestoneCount)  revert InvalidMilestoneIndex();

        // forge-lint: disable-next-line(incorrect-shift)
        uint8 bit = uint8(1 << index);
        if (releasedMask & bit != 0) revert MilestoneAlreadyReleased();

        if (s == Status.Disputed) {
            if (msg.sender != validator) revert Unauthorized();
        } else {
            if (msg.sender != buyer && msg.sender != validator) revert Unauthorized();
            _checkReleaseTiming();
        }

        uint256 msAmount = milestoneAmount(index);
        releasedMask |= bit;

        // forge-lint: disable-next-line(incorrect-shift)
        uint8 fullMask = uint8((1 << milestoneCount) - 1);
        bool  allDone  = (releasedMask & fullMask) == fullMask;
        if (allDone) status = Status.Released;

        address bene = beneficiary;
        _transferOut(bene, msAmount);
        emit MilestoneReleased(index, msAmount, releasedMask, allDone, msg.sender);
    }

    /// Open a dispute. Authorized: buyer or beneficiary (seller).
    /// Frozen once disputed — beneficiary cannot change until resolution.
    function dispute() external {
        if (status != Status.Open) revert NotOpen();
        if (msg.sender != buyer && msg.sender != beneficiary) revert Unauthorized();

        if (disputeDelay > 0 && block.timestamp < createdAt + disputeDelay) {
            revert DisputeTooEarly();
        }

        uint40 now_ = uint40(block.timestamp);
        status     = Status.Disputed;
        disputedAt = now_;

        emit DealDisputed(msg.sender, uint256(now_) + uint256(disputeResolutionWindow));
    }

    /// Resolve a dispute by splitting remaining funds between buyer and seller.
    /// buyerShare + sellerShare must equal the current escrow balance.
    /// Authorized: validator only. Must be called before the resolution deadline.
    function resolveDispute(uint256 buyerShare, uint256 sellerShare) external {
        if (msg.sender != validator)   revert Unauthorized();
        if (status != Status.Disputed) revert NotDisputed();

        if (block.timestamp >= uint256(disputedAt) + uint256(disputeResolutionWindow)) {
            revert DisputeExpired();
        }

        uint256 remaining = token.balanceOf(address(this));
        if (buyerShare + sellerShare != remaining) revert InvalidSplit();

        address bene = beneficiary;
        status = Status.Released;

        if (sellerShare > 0) _transferOut(bene, sellerShare);
        if (buyerShare > 0)  _transferOut(buyer, buyerShare);

        emit DisputeResolved(msg.sender, bene, buyerShare, sellerShare);
    }

    /// Refund the buyer. Authorized: beneficiary (seller) or validator.
    /// From Disputed: validator only.
    function refund() external {
        Status s = status;
        if (s != Status.Open && s != Status.Disputed) revert NotEligible();

        if (s == Status.Disputed) {
            if (msg.sender != validator) revert Unauthorized();
        } else {
            if (msg.sender != beneficiary && msg.sender != validator) revert Unauthorized();
        }

        uint256 refundAmount = token.balanceOf(address(this));
        status = Status.Refunded;

        _transferOut(buyer, refundAmount);
        emit DealRefunded(refundAmount, msg.sender);
    }

    /// Permissionless expiry — anyone can trigger once the timeout has elapsed.
    /// Open:     expires at createdAt + releaseDelay + timeout.
    /// Disputed: expires at disputedAt + disputeResolutionWindow (validator SLA).
    function expire() external {
        Status s = status;
        if (s != Status.Open && s != Status.Disputed) revert NotEligible();

        uint256 expiry = s == Status.Open
            ? createdAt + releaseDelay + timeout
            : uint256(disputedAt) + uint256(disputeResolutionWindow);

        if (block.timestamp < expiry) revert DealNotExpired();

        uint256 refundAmount = token.balanceOf(address(this));
        status = Status.Refunded;

        _transferOut(buyer, refundAmount);
        emit EscrowExpired(refundAmount);
    }

    /// Transfer the beneficiary role (e.g. invoice factoring to a vault).
    /// Open state only — frozen during disputes to protect the validator's arbitration target.
    function transferBeneficiary(address newBeneficiary) external {
        if (msg.sender != beneficiary)   revert Unauthorized();
        if (status != Status.Open)       revert NotEligible();
        if (newBeneficiary == buyer)     revert BeneficiaryEqualsBuyer();
        if (newBeneficiary == validator) revert BeneficiaryEqualsValidator();

        address old = beneficiary;
        beneficiary = newBeneficiary;
        emit BeneficiaryTransferred(old, newBeneficiary);
    }

    /// Double the dispute resolution window. Authorized: validator only.
    /// Must be requested before the current deadline — after it, expire() is the buyer's path.
    function extendDispute() external {
        if (msg.sender != validator)         revert Unauthorized();
        if (status != Status.Disputed)       revert NotDisputed();
        if (disputeExtensionsRemaining == 0) revert NoExtensionsRemaining();

        uint256 current  = uint256(disputeResolutionWindow);
        uint256 deadline = uint256(disputedAt) + current;
        if (block.timestamp >= deadline) revert DisputeExpired();

        uint256 newWindow = current * 2;
        if (newWindow > MAX_DISPUTE_RESOLUTION_WINDOW) revert DisputeExtensionTooLong();

        // forge-lint: disable-next-line(unsafe-typecast) — safe: newWindow <= MAX_DISPUTE_RESOLUTION_WINDOW = 365 days < 2^40
        disputeResolutionWindow     = uint40(newWindow);
        disputeExtensionsRemaining -= 1;

        emit DisputeExtended(uint256(disputedAt) + newWindow, disputeExtensionsRemaining);
    }

    // ─────────────────────────────────────────────────────────────
    // Internal
    // ─────────────────────────────────────────────────────────────

    function _checkReleaseTiming() internal view {
        if (releaseDelay > 0) {
            uint256 earliest = createdAt + releaseDelay;
            if (block.timestamp < earliest) revert ReleaseTooEarly();
            // Guard against racing with expire() after the deal has timed out.
            if (block.timestamp >= earliest + timeout) revert DealExpired();
        }
    }

    /// Transfers tokens out of escrow. Uses transferWithMemo (Tempo TIP-20 native)
    /// with the escrow address as memo for off-chain reconciliation. Falls back to transfer().
    function _transferOut(address to, uint256 value) internal {
        bytes32 memo = bytes32(uint256(uint160(address(this))));
        try ITIP20(address(token)).transferWithMemo(to, value, memo) returns (bool ok) {
            if (!ok) revert TransferFailed();
        } catch {
            bool ok = token.transfer(to, value);
            if (!ok) revert TransferFailed();
        }
    }
}
