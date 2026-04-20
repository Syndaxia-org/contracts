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
use anchor_spl::token::{self, CloseAccount, Transfer};

use crate::errors::SyndaxiaError;
use crate::state::Status;

use super::release::ReleaseRefund;

/// Expire a deal past its timeout — refunds the buyer.
/// Permissionless: anyone can call once the timeout has elapsed.
/// Effective expiry = `created_at` + `release_delay` + `timeout`.
pub fn handler(ctx: Context<ReleaseRefund>) -> Result<()> {
    let deal = &mut ctx.accounts.deal;

    // Open or Disputed deals can expire by timeout.
    // Disputed deals use a longer timeout to give the validator time to resolve.
    require!(
        deal.status == Status::Open || deal.status == Status::Disputed,
        SyndaxiaError::NotEligible
    );

    let now = Clock::get()?.unix_timestamp;

    let expiry = if deal.status == Status::Open {
        // Open deals: expires at created_at + release_delay + timeout
        let effective_timeout = deal
            .release_delay
            .checked_add(deal.timeout)
            .ok_or(SyndaxiaError::MathOverflow)?;
        deal.created_at
            .checked_add(effective_timeout)
            .ok_or(SyndaxiaError::MathOverflow)?
    } else {
        // Disputed deals: validator has `dispute_resolution_window` seconds (set per deal
        // at creation) from when the dispute was opened.
        // This guarantees the marketplace-configured resolution window even for short-timeout deals.
        deal.disputed_at
            .checked_add(deal.dispute_resolution_window)
            .ok_or(SyndaxiaError::MathOverflow)?
    };
    require!(now >= expiry, SyndaxiaError::DealNotExpired);

    deal.status = Status::Refunded;

    // Use remaining amount for milestone deals with partial releases.
    let refund_amount = deal.remaining_escrow_amount().map_err(|_| SyndaxiaError::MathOverflow)?;

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
                to: ctx.accounts.buyer_token_account.to_account_info(),
                authority: ctx.accounts.escrow_token_account.to_account_info(),
            },
            signer,
        ),
        refund_amount,
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

    emit!(DealExpired {
        deal: deal_key,
        buyer: deal.buyer,
        beneficiary: deal.beneficiary,
        amount: refund_amount,
    });

    Ok(())
}

#[event]
pub struct DealExpired {
    pub deal: Pubkey,
    pub buyer: Pubkey,
    pub beneficiary: Pubkey,
    pub amount: u64,
}
