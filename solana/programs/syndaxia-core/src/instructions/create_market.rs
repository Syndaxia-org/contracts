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

use crate::constants::MAX_MARKET_FEE_BPS;
use crate::errors::SyndaxiaError;
use crate::state::Market;

#[derive(Accounts)]
#[instruction(market_fee_bps: u64)]
pub struct CreateMarket<'info> {
    #[account(
        init, payer = payer, space = 8 + 32 + 8 + 1,
        seeds = [b"market", validator.key().as_ref(), &market_fee_bps.to_le_bytes()], bump
    )]
    pub market: Account<'info, Market>,
    /// CHECK: any account can be a validator
    pub validator: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CreateMarket>, market_fee_bps: u64) -> Result<()> {
    require!(market_fee_bps <= MAX_MARKET_FEE_BPS, SyndaxiaError::FeeTooHigh);

    let market = &mut ctx.accounts.market;
    market.validator = ctx.accounts.validator.key();
    market.market_fee_bps = market_fee_bps;
    market.bump = ctx.bumps.market;

    emit!(MarketCreated {
        market: market.key(),
        validator: market.validator,
        market_fee_bps,
    });

    Ok(())
}

#[event]
pub struct MarketCreated {
    pub market: Pubkey,
    pub validator: Pubkey,
    pub market_fee_bps: u64,
}
