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

use crate::errors::SyndaxiaError;
use crate::state::{Deal, Status};

#[derive(Accounts)]
pub struct DisputeDeal<'info> {
    #[account(mut)]
    pub deal: Account<'info, Deal>,
    pub authority: Signer<'info>,
}

/// Open a dispute on a deal.
/// Authorized: buyer OR beneficiary (seller).
pub fn handler(ctx: Context<DisputeDeal>) -> Result<()> {
    let deal = &mut ctx.accounts.deal;
    require!(
        ctx.accounts.authority.key() == deal.buyer
            || ctx.accounts.authority.key() == deal.beneficiary,
        SyndaxiaError::Unauthorized
    );
    require!(deal.status == Status::Open, SyndaxiaError::NotOpen);

    // Cooling period: force off-chain resolution attempt before on-chain dispute.
    let now = Clock::get()?.unix_timestamp;
    if deal.dispute_delay > 0 {
        let earliest_dispute = deal
            .created_at
            .checked_add(deal.dispute_delay)
            .ok_or(SyndaxiaError::MathOverflow)?;
        require!(now >= earliest_dispute, SyndaxiaError::DisputeTooEarly);
    }

    deal.status = Status::Disputed;
    deal.disputed_at = now;

    emit!(DealDisputed {
        deal: deal.key(),
        buyer: deal.buyer,
        beneficiary: deal.beneficiary,
        opened_by: ctx.accounts.authority.key(),
        resolution_deadline: now
            .checked_add(deal.dispute_resolution_window)
            .unwrap_or(i64::MAX),
    });

    Ok(())
}

#[event]
pub struct DealDisputed {
    pub deal: Pubkey,
    pub buyer: Pubkey,
    pub beneficiary: Pubkey,
    pub opened_by: Pubkey,
    /// Validator must resolve before this timestamp or the deal becomes expirable.
    pub resolution_deadline: i64,
}
