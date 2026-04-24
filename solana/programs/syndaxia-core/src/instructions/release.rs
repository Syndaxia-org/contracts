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

/// Shared accounts struct used by `release`, `refund`, and `expire_deal`.
/// Validator is now stored in the Deal itself — no more Market account.
#[derive(Accounts)]
pub struct ReleaseRefund<'info> {
    #[account(mut)]
    pub deal: Account<'info, Deal>,
    pub authority: Signer<'info>,
    #[account(mut, constraint = beneficiary_token_account.owner == deal.beneficiary @ SyndaxiaError::InvalidBeneficiaryTokenAccount)]
    pub beneficiary_token_account: Account<'info, TokenAccount>,
    #[account(mut, constraint = buyer_token_account.owner == deal.buyer @ SyndaxiaError::InvalidBuyerTokenAccount)]
    pub buyer_token_account: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"escrow", deal.key().as_ref()], bump)]
    pub escrow_token_account: Account<'info, TokenAccount>,
    /// CHECK: receives rent when the escrow account is closed
    #[account(mut, constraint = rent_receiver.key() == deal.buyer @ SyndaxiaError::InvalidRentReceiver)]
    pub rent_receiver: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Release all escrowed funds to the beneficiary (simple deal, no milestones).
/// Authorized: buyer or validator.
pub fn handler(ctx: Context<ReleaseRefund>) -> Result<()> {
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
    // Simple release requires milestone_count == 0
    require!(deal.milestone_count == 0, SyndaxiaError::UseMilestoneRelease);

    // Enforce release delay unless the deal is disputed (validator arbitration).
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

    deal.status = Status::Released;

    let deal_key = deal.key();
    let seeds = &[
        b"escrow",
        deal_key.as_ref(),
        &[ctx.bumps.escrow_token_account],
    ];
    let signer = &[&seeds[..]];

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
        deal.amount,
    )?;

    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.escrow_token_account.to_account_info(),
            destination: ctx.accounts.rent_receiver.to_account_info(),
            authority: ctx.accounts.escrow_token_account.to_account_info(),
        },
        signer,
    ))?;

    emit!(DealReleased {
        deal: deal_key,
        buyer: deal.buyer,
        beneficiary: deal.beneficiary,
        amount: deal.amount,
        authority: ctx.accounts.authority.key(),
    });

    Ok(())
}

#[event]
pub struct DealReleased {
    pub deal: Pubkey,
    pub buyer: Pubkey,
    pub beneficiary: Pubkey,
    pub amount: u64,
    pub authority: Pubkey,
}
