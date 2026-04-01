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
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::{
    MAX_DISPUTE_DELAY, MAX_FEE_BPS, MAX_MILESTONES, MAX_PROTOCOL_FEE_BPS,
    MAX_RELEASE_DELAY, MIN_TIMEOUT, TREASURY_CONFIG_SEED, TREASURY_PROGRAM_ID,
};
use crate::errors::SyndaxiaError;
use crate::libraries::math::calculate_fee;
use crate::state::{Deal, Status};

#[derive(Accounts)]
pub struct CreateDeal<'info> {
    #[account(init, payer = buyer, space = Deal::SPACE)]
    pub deal: Account<'info, Deal>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: stored in deal state as seller
    pub seller: UncheckedAccount<'info>,
    /// CHECK: stored in deal state as validator (arbitrator)
    pub validator: UncheckedAccount<'info>,
    #[account(mut, constraint = buyer_token_account.owner == buyer.key() @ SyndaxiaError::InvalidBuyerTokenAccount)]
    pub buyer_token_account: Account<'info, TokenAccount>,
    /// CHECK: stored in deal state as fee_collector
    pub fee_collector: UncheckedAccount<'info>,
    #[account(mut, constraint = fee_collector_token_account.owner == fee_collector.key() @ SyndaxiaError::InvalidFeeCollector)]
    pub fee_collector_token_account: Account<'info, TokenAccount>,
    /// Treasury config PDA (syndaxia-treasury program).
    /// Address verified via seeds ["treasury-config"] + TREASURY_PROGRAM_ID — no CPI type dependency.
    /// Data is read manually: fee_receiver @ offset 40, protocol_fee_bps @ offset 72.
    /// CHECK: PDA address verified by seeds constraint against TREASURY_PROGRAM_ID.
    #[account(
        seeds = [TREASURY_CONFIG_SEED],
        bump,
        seeds::program = TREASURY_PROGRAM_ID,
    )]
    pub treasury_config: AccountInfo<'info>,
    /// Token account that will receive the protocol fee.
    /// Owner verified in handler against treasury_config.fee_receiver (read from raw bytes).
    #[account(mut)]
    pub treasury_token_account: Account<'info, TokenAccount>,
    #[account(
        init, payer = buyer, seeds = [b"escrow", deal.key().as_ref()], bump,
        token::mint = mint, token::authority = escrow_token_account,
    )]
    pub escrow_token_account: Account<'info, TokenAccount>,
    pub mint: Account<'info, anchor_spl::token::Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreateDeal>,
    amount: u64,
    fee_bps: u64,
    release_delay: i64,
    timeout: i64,
    dispute_delay: i64,
    metadata_hash: [u8; 32],
    milestone_amounts: Vec<u64>,
) -> Result<()> {
    require!(amount > 0, SyndaxiaError::InvalidAmount);
    require!(fee_bps <= MAX_FEE_BPS, SyndaxiaError::FeeTooHigh);
    require!(release_delay >= 0, SyndaxiaError::InvalidReleaseDelay);
    require!(release_delay <= MAX_RELEASE_DELAY, SyndaxiaError::InvalidReleaseDelay);
    require!(timeout >= MIN_TIMEOUT, SyndaxiaError::InvalidTimeout);
    require!(dispute_delay >= 0, SyndaxiaError::InvalidDisputeDelay);
    require!(dispute_delay <= MAX_DISPUTE_DELAY, SyndaxiaError::InvalidDisputeDelay);
    require!(
        ctx.accounts.buyer.key() != ctx.accounts.seller.key(),
        SyndaxiaError::BuyerEqualsSeller
    );
    require!(
        ctx.accounts.buyer.key() != ctx.accounts.validator.key(),
        SyndaxiaError::InvalidValidator
    );

    // ── Milestone validation ──
    let milestone_count = milestone_amounts.len();
    require!(milestone_count <= MAX_MILESTONES, SyndaxiaError::TooManyMilestones);

    let mut ms_array = [0u64; 8];
    if milestone_count > 0 {
        let mut sum: u64 = 0;
        for (i, &ms_amount) in milestone_amounts.iter().enumerate() {
            require!(ms_amount > 0, SyndaxiaError::InvalidMilestoneAmount);
            sum = sum.checked_add(ms_amount).ok_or(SyndaxiaError::MathOverflow)?;
            ms_array[i] = ms_amount;
        }
        require!(sum == amount, SyndaxiaError::MilestoneSumMismatch);
    }

    // ── Protocol fee (Treasury) ──
    // Manual deserialization: no CPI type dependency on syndaxia-treasury.
    // TreasuryConfig layout: 8 disc | 32 multisig | 32 fee_receiver | 8 protocol_fee_bps | ...
    let (protocol_fee_bps, treasury_fee_receiver) = {
        let data = ctx.accounts.treasury_config.try_borrow_data()?;
        require!(data.len() >= 80, SyndaxiaError::InvalidTreasuryConfig);
        let fee_receiver = Pubkey::try_from(&data[40..72])
            .map_err(|_| error!(SyndaxiaError::InvalidTreasuryConfig))?;
        let bps = u64::from_le_bytes(
            data[72..80].try_into().map_err(|_| error!(SyndaxiaError::InvalidTreasuryConfig))?,
        );
        (bps, fee_receiver)
    };
    // Double-check: guard against a governance bug setting a value above our hardcoded cap.
    require!(protocol_fee_bps <= MAX_PROTOCOL_FEE_BPS, SyndaxiaError::InvalidProtocolFee);
    // Verify the treasury token account belongs to the fee_receiver declared in treasury state.
    require!(
        ctx.accounts.treasury_token_account.owner == treasury_fee_receiver,
        SyndaxiaError::InvalidTreasuryTokenAccount
    );
    let protocol_fee = calculate_fee(amount, protocol_fee_bps)?;
    if protocol_fee > 0 {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.buyer_token_account.to_account_info(),
                    to: ctx.accounts.treasury_token_account.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            protocol_fee,
        )?;
    }

    // ── Marketeer fee transfer ──
    let fee = calculate_fee(amount, fee_bps)?;
    if fee > 0 {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.buyer_token_account.to_account_info(),
                    to: ctx.accounts.fee_collector_token_account.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            fee,
        )?;
    }

    // ── Principal to escrow ──
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.buyer_token_account.to_account_info(),
                to: ctx.accounts.escrow_token_account.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            },
        ),
        amount,
    )?;

    // ── Populate deal state ──
    let deal = &mut ctx.accounts.deal;
    deal.seller = ctx.accounts.seller.key();
    deal.buyer = ctx.accounts.buyer.key();
    deal.validator = ctx.accounts.validator.key();
    deal.fee_collector = ctx.accounts.fee_collector.key();
    deal.beneficiary = ctx.accounts.seller.key();
    deal.amount = amount;
    deal.fee_bps = fee_bps;
    deal.metadata_hash = metadata_hash;
    deal.created_at = Clock::get()?.unix_timestamp;
    deal.release_delay = release_delay;
    deal.timeout = timeout;
    deal.dispute_delay = dispute_delay;
    deal.status = Status::Open;
    deal.milestone_count = milestone_count as u8;
    deal.released_mask = 0;
    deal.milestone_amounts = ms_array;

    emit!(DealCreated {
        deal: deal.key(),
        buyer: deal.buyer,
        seller: deal.seller,
        validator: deal.validator,
        beneficiary: deal.beneficiary,
        amount,
        marketeer_fee: fee,
        protocol_fee,
        fee_bps,
        protocol_fee_bps,
        release_delay,
        timeout,
        dispute_delay,
        metadata_hash,
        milestone_count: deal.milestone_count,
    });

    Ok(())
}

#[event]
pub struct DealCreated {
    pub deal: Pubkey,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub validator: Pubkey,
    pub beneficiary: Pubkey,
    pub amount: u64,
    pub marketeer_fee: u64,
    pub protocol_fee: u64,
    pub fee_bps: u64,
    pub protocol_fee_bps: u64,
    pub release_delay: i64,
    pub timeout: i64,
    pub dispute_delay: i64,
    pub metadata_hash: [u8; 32],
    pub milestone_count: u8,
}
