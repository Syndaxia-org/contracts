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
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer};

use crate::errors::SyndaxiaError;
use crate::state::{Deal, Status};

#[derive(Accounts)]
pub struct ReleaseMilestone<'info> {
    #[account(mut)]
    pub deal: Account<'info, Deal>,
    pub authority: Signer<'info>,
    #[account(mut, constraint = beneficiary_token_account.owner == deal.beneficiary @ SyndaxiaError::InvalidBeneficiaryTokenAccount)]
    pub beneficiary_token_account: Account<'info, TokenAccount>,
    #[account(mut, constraint = buyer_token_account.owner == deal.buyer @ SyndaxiaError::InvalidBuyerTokenAccount)]
    pub buyer_token_account: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"escrow", deal.key().as_ref()], bump)]
    pub escrow_token_account: Account<'info, TokenAccount>,
    /// CHECK: receives rent when the escrow account is closed (after final milestone)
    #[account(mut, constraint = rent_receiver.key() == deal.buyer @ SyndaxiaError::InvalidRentReceiver)]
    pub rent_receiver: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Release a single milestone from a milestone deal.
/// Authorized: buyer or validator.
pub fn handler(ctx: Context<ReleaseMilestone>, milestone_index: u8) -> Result<()> {
    let deal = &mut ctx.accounts.deal;

    require!(
        deal.status == Status::Open || deal.status == Status::Disputed,
        SyndaxiaError::NotEligible
    );
    // From Disputed, only the validator can act (protects the arbitration mechanism).
    // From Open, buyer or validator are both authorized.
    if deal.status == Status::Disputed {
        require!(
            ctx.accounts.authority.key() == deal.validator,
            SyndaxiaError::Unauthorized
        );
    } else {
        require!(
            ctx.accounts.authority.key() == deal.buyer
                || ctx.accounts.authority.key() == deal.validator,
            SyndaxiaError::Unauthorized
        );
    }
    require!(deal.milestone_count > 0, SyndaxiaError::NotMilestoneDeal);
    require!(
        milestone_index < deal.milestone_count,
        SyndaxiaError::InvalidMilestoneIndex
    );

    let bit = 1u8 << milestone_index;
    require!(deal.released_mask & bit == 0, SyndaxiaError::MilestoneAlreadyReleased);

    // Enforce release delay unless disputed
    if deal.status == Status::Open && deal.release_delay > 0 {
        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= deal.created_at.checked_add(deal.release_delay).ok_or(SyndaxiaError::MathOverflow)?,
            SyndaxiaError::ReleaseTooEarly
        );

        // Reject if deal has already expired — prevents race with expire_deal.
        let expiry = deal.created_at
            .checked_add(deal.release_delay)
            .and_then(|v| v.checked_add(deal.timeout))
            .ok_or(SyndaxiaError::MathOverflow)?;
        require!(now < expiry, SyndaxiaError::DealExpired);
    }

    let ms_amount = deal.milestone_amounts[milestone_index as usize];
    deal.released_mask |= bit;

    let deal_key = deal.key();
    let seeds = &[
        b"escrow",
        deal_key.as_ref(),
        &[ctx.bumps.escrow_token_account],
    ];
    let signer = &[&seeds[..]];

    // Transfer milestone amount to beneficiary
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow_token_account.to_account_info(),
                to: ctx.accounts.beneficiary_token_account.to_account_info(),
                authority: ctx.accounts.escrow_token_account.to_account_info(),
            },
            signer,
        ),
        ms_amount,
    )?;

    // If all milestones released, close escrow and mark deal as Released
    if deal.all_milestones_released() {
        deal.status = Status::Released;

        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.escrow_token_account.to_account_info(),
                destination: ctx.accounts.rent_receiver.to_account_info(),
                authority: ctx.accounts.escrow_token_account.to_account_info(),
            },
            signer,
        ))?;
    }

    emit!(MilestoneReleased {
        deal: deal_key,
        milestone_index,
        amount: ms_amount,
        released_mask: deal.released_mask,
        all_released: deal.status == Status::Released,
        authority: ctx.accounts.authority.key(),
    });

    Ok(())
}

#[event]
pub struct MilestoneReleased {
    pub deal: Pubkey,
    pub milestone_index: u8,
    pub amount: u64,
    pub released_mask: u8,
    pub all_released: bool,
    pub authority: Pubkey,
}
