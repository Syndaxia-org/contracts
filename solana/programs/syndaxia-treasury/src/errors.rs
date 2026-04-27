// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Association Syndaxia (Governance)

use anchor_lang::prelude::*;

#[error_code]
pub enum TreasuryError {
    #[msg("Proposed fee exceeds the maximum allowed (20 BPS = 0.20%).")]
    FeeTooHigh,
    #[msg("Unauthorized: signer is not the governance multisig.")]
    Unauthorized,
    #[msg("No pending fee change proposal to apply or cancel.")]
    NoPendingProposal,
    #[msg("Timelock period has not elapsed yet.")]
    TimelockNotElapsed,
    #[msg("Arithmetic overflow.")]
    MathOverflow,
    #[msg("Amount must be greater than zero.")]
    InvalidAmount,
    #[msg("Treasury token account authority does not match the config PDA.")]
    InvalidTokenAccount,
    #[msg("Fee receiver token account does not match config.fee_receiver.")]
    InvalidFeeReceiver,
    #[msg("No pending fee receiver change proposal to apply or cancel.")]
    NoPendingReceiverProposal,
}
