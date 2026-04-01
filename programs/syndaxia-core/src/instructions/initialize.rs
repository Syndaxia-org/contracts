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

use crate::constants::MAX_PROTOCOL_FEE_BPS;
use crate::errors::SyndaxiaError;
use crate::state::ProtocolConfig;

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = admin, space = 8 + 32 + 32 + 8 + 1, seeds = [b"config"], bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: stored in config, not read
    pub fee_collector: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Initialize>, protocol_fee_bps: u64) -> Result<()> {
    require!(protocol_fee_bps <= MAX_PROTOCOL_FEE_BPS, SyndaxiaError::FeeTooHigh);

    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.fee_collector = ctx.accounts.fee_collector.key();
    config.protocol_fee_bps = protocol_fee_bps;
    config.bump = ctx.bumps.config;

    emit!(ProtocolInitialized {
        admin: config.admin,
        fee_collector: config.fee_collector,
        protocol_fee_bps,
    });

    Ok(())
}

#[event]
pub struct ProtocolInitialized {
    pub admin: Pubkey,
    pub fee_collector: Pubkey,
    pub protocol_fee_bps: u64,
}
