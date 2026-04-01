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

/// Resolve a dispute by splitting escrowed funds between buyer and seller.
/// Authorized: validator only.
/// `buyer_share + seller_share` must equal `deal.amount`.
pub fn handler(
    ctx: Context<ReleaseRefund>,
    buyer_share: u64,
    seller_share: u64,
) -> Result<()> {
    let deal = &mut ctx.accounts.deal;

    // Only the validator can resolve a dispute
    require!(
        ctx.accounts.authority.key() == deal.validator,
        SyndaxiaError::Unauthorized
    );
    require!(
        deal.status == Status::Disputed,
        SyndaxiaError::NotDisputed
    );
    // Shares must sum to the escrowed amount
    let total = buyer_share
        .checked_add(seller_share)
        .ok_or(SyndaxiaError::MathOverflow)?;
    require!(total == deal.amount, SyndaxiaError::InvalidSplit);

    deal.status = Status::Released;

    let deal_key = deal.key();
    let seeds = &[
        b"escrow",
        deal_key.as_ref(),
        &[ctx.bumps.escrow_token_account],
    ];
    let signer = &[&seeds[..]];

    // Transfer seller's share to beneficiary
    if seller_share > 0 {
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
            seller_share,
        )?;
    }

    // Transfer buyer's share back to buyer
    if buyer_share > 0 {
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
            buyer_share,
        )?;
    }

    // Close escrow, return rent to buyer
    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.escrow_token_account.to_account_info(),
            destination: ctx.accounts.rent_receiver.to_account_info(),
            authority: ctx.accounts.escrow_token_account.to_account_info(),
        },
        signer,
    ))?;

    emit!(DisputeResolved {
        deal: deal_key,
        buyer: deal.buyer,
        beneficiary: deal.beneficiary,
        buyer_share,
        seller_share,
        validator: deal.validator,
    });

    Ok(())
}

#[event]
pub struct DisputeResolved {
    pub deal: Pubkey,
    pub buyer: Pubkey,
    pub beneficiary: Pubkey,
    pub buyer_share: u64,
    pub seller_share: u64,
    pub validator: Pubkey,
}
