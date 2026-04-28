// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Association Syndaxia (Governance)
//
// Licensed under the Business Source License 1.1 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://mariadb.com/bsl11/
//
// Parameters of the License for this software:
// - Change Date: 2029-01-01
// - Change License: Apache License, Version 2.0
// - Additional Use Grant:
//   Exclusive right for commercial exploitation is granted to Satflows SAS.
//   Commercial use by any other entity is strictly prohibited without prior
//   written consent from the Licensor (Association Syndaxia).

use anchor_lang::prelude::*;

#[error_code]
pub enum SyndaxiaError {
    #[msg("Fee exceeds the maximum allowed (10%).")]
    FeeTooHigh,
    #[msg("Amount must be greater than zero.")]
    InvalidAmount,
    #[msg("Unauthorized signer for this action.")]
    Unauthorized,
    #[msg("Deal is not in Open state.")]
    NotOpen,
    #[msg("Operation not eligible for the current deal state.")]
    NotEligible,
    #[msg("Arithmetic overflow.")]
    MathOverflow,
    #[msg("Release delay has not elapsed yet.")]
    ReleaseTooEarly,
    #[msg("Deal has expired.")]
    DealExpired,
    #[msg("Deal has not expired yet.")]
    DealNotExpired,
    #[msg("Beneficiary token account does not match the deal's beneficiary.")]
    InvalidBeneficiaryTokenAccount,
    #[msg("Buyer token account does not match the deal's buyer.")]
    InvalidBuyerTokenAccount,
    #[msg("Fee collector token account does not match the provided fee_collector.")]
    InvalidFeeCollector,
    #[msg("Release delay is invalid (negative or exceeds 365 days).")]
    InvalidReleaseDelay,
    #[msg("Buyer and seller cannot be the same address.")]
    BuyerEqualsSeller,
    #[msg("Rent receiver does not match the deal's buyer.")]
    InvalidRentReceiver,
    #[msg("Timeout must be at least 1 hour.")]
    InvalidTimeout,
    #[msg("Validator cannot be the buyer.")]
    InvalidValidator,
    #[msg("Too many milestones (max 8).")]
    TooManyMilestones,
    #[msg("Milestone amount must be greater than zero.")]
    InvalidMilestoneAmount,
    #[msg("Sum of milestone amounts must equal the deal amount.")]
    MilestoneSumMismatch,
    #[msg("Use release_milestone for milestone deals.")]
    UseMilestoneRelease,
    #[msg("This is not a milestone deal.")]
    NotMilestoneDeal,
    #[msg("Milestone index out of range.")]
    InvalidMilestoneIndex,
    #[msg("Milestone has already been released.")]
    MilestoneAlreadyReleased,
    #[msg("New beneficiary cannot be the buyer.")]
    BeneficiaryEqualsBuyer,
    #[msg("Deal must be in Disputed state for this action.")]
    NotDisputed,
    #[msg("buyer_share + seller_share must equal the escrowed amount.")]
    InvalidSplit,
    #[msg("Dispute cannot be opened before the cooling period has elapsed.")]
    DisputeTooEarly,
    #[msg("Dispute delay is invalid (negative or exceeds 365 days).")]
    InvalidDisputeDelay,
    #[msg("Dispute resolution window is invalid (must be between 1 day and 365 days).")]
    InvalidDisputeResolutionWindow,
    #[msg("Protocol fee from Treasury exceeds the hardcoded maximum (20 BPS).")]
    InvalidProtocolFee,
    #[msg("Treasury token account does not match the treasury config fee_receiver.")]
    InvalidTreasuryTokenAccount,
    #[msg("Treasury config account data is invalid or corrupted.")]
    InvalidTreasuryConfig,
    #[msg("Validator and seller cannot be the same address.")]
    ValidatorEqualsSeller,
    #[msg("New beneficiary cannot be the validator.")]
    BeneficiaryEqualsValidator,
    #[msg("Timeout exceeds the maximum allowed (365 days).")]
    TimeoutTooLong,
    #[msg("No dispute extensions remaining.")]
    NoExtensionsRemaining,
    #[msg("Total dispute resolution time would exceed the maximum allowed.")]
    DisputeExtensionTooLong,
    #[msg("Dispute resolution window has already expired.")]
    DisputeExpired,
}
