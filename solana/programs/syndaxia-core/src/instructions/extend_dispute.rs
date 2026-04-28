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

use crate::constants::MAX_DISPUTE_RESOLUTION_WINDOW;
use crate::errors::SyndaxiaError;
use crate::state::{Deal, Status};

#[derive(Accounts)]
pub struct ExtendDispute<'info> {
    #[account(mut)]
    pub deal: Account<'info, Deal>,
    pub authority: Signer<'info>,
}

/// Extend the dispute resolution window. Authorized: validator only.
///
/// Each extension DOUBLES the current `dispute_resolution_window` (capped at
/// `MAX_DISPUTE_RESOLUTION_WINDOW`). Limited by `dispute_extensions_remaining`.
///
/// Security: the extension MUST be requested before the current deadline
/// elapses. After the deadline, anyone can call `expire_deal` to refund the
/// buyer; allowing a late extension would let the validator block that path
/// and grief the buyer indefinitely.
pub fn handler(ctx: Context<ExtendDispute>) -> Result<()> {
    let deal = &mut ctx.accounts.deal;

    require!(
        ctx.accounts.authority.key() == deal.validator,
        SyndaxiaError::Unauthorized
    );
    require!(
        deal.status == Status::Disputed,
        SyndaxiaError::NotDisputed
    );
    require!(
        deal.dispute_extensions_remaining > 0,
        SyndaxiaError::NoExtensionsRemaining
    );

    // Reject extension requests issued after the current deadline has elapsed —
    // the deal becomes expirable at that point and the validator's authority
    // over the dispute window terminates.
    let now = Clock::get()?.unix_timestamp;
    let current_deadline = deal
        .disputed_at
        .checked_add(deal.dispute_resolution_window)
        .ok_or(SyndaxiaError::MathOverflow)?;
    require!(now < current_deadline, SyndaxiaError::DisputeExpired);

    // Each extension doubles the current window. Cap: the new window cannot
    // exceed MAX_DISPUTE_RESOLUTION_WINDOW.
    let new_window = deal
        .dispute_resolution_window
        .checked_add(deal.dispute_resolution_window)
        .ok_or(SyndaxiaError::MathOverflow)?;
    require!(
        new_window <= MAX_DISPUTE_RESOLUTION_WINDOW,
        SyndaxiaError::DisputeExtensionTooLong
    );

    deal.dispute_resolution_window = new_window;
    deal.dispute_extensions_remaining -= 1;

    let new_deadline = deal
        .disputed_at
        .checked_add(new_window)
        .ok_or(SyndaxiaError::MathOverflow)?;

    emit!(DisputeExtended {
        deal: deal.key(),
        validator: deal.validator,
        new_deadline,
        extensions_remaining: deal.dispute_extensions_remaining,
    });

    Ok(())
}

#[event]
pub struct DisputeExtended {
    pub deal: Pubkey,
    pub validator: Pubkey,
    pub new_deadline: i64,
    pub extensions_remaining: u8,
}
