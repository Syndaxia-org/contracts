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

#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

pub mod errors;
pub mod state;

use errors::TreasuryError;
use state::TreasuryConfig;

#[cfg(not(feature = "no-entrypoint"))]
use solana_security_txt::security_txt;

#[cfg(not(feature = "no-entrypoint"))]
security_txt! {
    name: "syndaxia-treasury",
    project_url: "https://syndaxia.org",
    contacts: "email:security@syndaxia.org",
    policy: "https://syndaxia.org/security",
    source_code: "https://github.com/Syndaxia-org/contracts"
}

declare_id!("DvoZj1cKMi8DEvTxBgNEnj9Fhxx9PRAsVTEWEZ2e6YHx");

/// Maximum protocol fee the governance can ever set (20 BPS = 0.20%).
/// Hardcoded here AND verified in syndaxia-core. Cannot be exceeded even by governance.
pub const MAX_PROTOCOL_FEE_BPS: u64 = 20;

/// Initial rate at deployment.
pub const INITIAL_PROTOCOL_FEE_BPS: u64 = 5;

/// Minimum time (seconds) between a fee proposal and its application.
/// Protects users: 7 days notice before any rate change takes effect.
pub const FEE_CHANGE_TIMELOCK: i64 = 7 * 24 * 3600;

/// Seeds for the TreasuryConfig PDA — must match the constant in syndaxia-core.
pub const CONFIG_SEED: &[u8] = b"treasury-config";

#[program]
pub mod syndaxia_treasury {
    use super::*;

    /// Initialize the treasury. Called once by the Association Syndaxia multisig.
    /// `fee_receiver` is the token account that will receive protocol fees.
    pub fn initialize(ctx: Context<Initialize>, fee_receiver: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.multisig = ctx.accounts.multisig.key();
        config.fee_receiver = fee_receiver;
        config.protocol_fee_bps = INITIAL_PROTOCOL_FEE_BPS;
        config.pending_fee_bps = None;
        config.timelock_until = 0;
        config.pending_fee_receiver = None;
        config.receiver_timelock_until = 0;
        config.bump = ctx.bumps.config;

        emit!(TreasuryInitialized {
            multisig: config.multisig,
            fee_receiver,
            initial_fee_bps: INITIAL_PROTOCOL_FEE_BPS,
        });

        Ok(())
    }

    /// Propose a new protocol fee rate. Starts the 7-day timelock.
    /// Only the multisig can call this.
    pub fn propose_fee_change(ctx: Context<GovernanceAction>, new_fee_bps: u64) -> Result<()> {
        require!(new_fee_bps <= MAX_PROTOCOL_FEE_BPS, TreasuryError::FeeTooHigh);

        let config = &mut ctx.accounts.config;
        let now = Clock::get()?.unix_timestamp;
        config.pending_fee_bps = Some(new_fee_bps);
        config.timelock_until = now
            .checked_add(FEE_CHANGE_TIMELOCK)
            .ok_or(TreasuryError::MathOverflow)?;

        emit!(FeeChangeProposed {
            proposed_by: ctx.accounts.multisig.key(),
            new_fee_bps,
            executable_after: config.timelock_until,
        });

        Ok(())
    }

    /// Cancel a pending fee change proposal. Only the multisig can cancel.
    pub fn cancel_fee_change(ctx: Context<GovernanceAction>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(config.pending_fee_bps.is_some(), TreasuryError::NoPendingProposal);
        config.pending_fee_bps = None;
        config.timelock_until = 0;

        emit!(FeeChangeCancelled {
            cancelled_by: ctx.accounts.multisig.key(),
        });

        Ok(())
    }

    /// Apply a pending fee change after the timelock has elapsed. Permissionless.
    pub fn apply_fee_change(ctx: Context<ApplyFeeChange>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let pending = config.pending_fee_bps.ok_or(TreasuryError::NoPendingProposal)?;
        let now = Clock::get()?.unix_timestamp;
        require!(now >= config.timelock_until, TreasuryError::TimelockNotElapsed);

        let old_fee_bps = config.protocol_fee_bps;
        config.protocol_fee_bps = pending;
        config.pending_fee_bps = None;
        config.timelock_until = 0;

        emit!(FeeChangeApplied {
            old_fee_bps,
            new_fee_bps: pending,
        });

        Ok(())
    }

    /// Update the fee receiver token account. Only the multisig can call this.
    /// Starts a 7-day timelock — use `apply_fee_receiver_change` after the delay.
    pub fn propose_fee_receiver_change(ctx: Context<GovernanceAction>, new_fee_receiver: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let now = Clock::get()?.unix_timestamp;
        config.pending_fee_receiver = Some(new_fee_receiver);
        config.receiver_timelock_until = now
            .checked_add(FEE_CHANGE_TIMELOCK)
            .ok_or(TreasuryError::MathOverflow)?;

        emit!(FeeReceiverChangeProposed {
            proposed_by: ctx.accounts.multisig.key(),
            new_receiver: new_fee_receiver,
            executable_after: config.receiver_timelock_until,
        });

        Ok(())
    }

    /// Cancel a pending fee receiver change. Only the multisig can cancel.
    pub fn cancel_fee_receiver_change(ctx: Context<GovernanceAction>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(config.pending_fee_receiver.is_some(), TreasuryError::NoPendingReceiverProposal);
        config.pending_fee_receiver = None;
        config.receiver_timelock_until = 0;

        emit!(FeeReceiverChangeCancelled {
            cancelled_by: ctx.accounts.multisig.key(),
        });

        Ok(())
    }

    /// Apply a pending fee receiver change after the timelock. Permissionless.
    pub fn apply_fee_receiver_change(ctx: Context<ApplyFeeChange>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let pending = config.pending_fee_receiver.ok_or(TreasuryError::NoPendingReceiverProposal)?;
        let now = Clock::get()?.unix_timestamp;
        require!(now >= config.receiver_timelock_until, TreasuryError::TimelockNotElapsed);

        let old = config.fee_receiver;
        config.fee_receiver = pending;
        config.pending_fee_receiver = None;
        config.receiver_timelock_until = 0;

        emit!(FeeReceiverUpdated {
            old_receiver: old,
            new_receiver: pending,
            updated_by: Pubkey::default(), // permissionless
        });

        Ok(())
    }

    /// Withdraw accumulated protocol fees from the treasury token account to the fee_receiver.
    /// Only the multisig can call this.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, TreasuryError::InvalidAmount);

        let seeds = &[CONFIG_SEED, &[ctx.accounts.config.bump]];
        let signer = &[&seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.treasury_token_account.to_account_info(),
                    to: ctx.accounts.fee_receiver_token_account.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;

        emit!(FeeWithdrawn {
            amount,
            to: ctx.accounts.fee_receiver_token_account.key(),
            by: ctx.accounts.multisig.key(),
        });

        Ok(())
    }
}

// ── Account Contexts ──────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = multisig,
        space = TreasuryConfig::SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, TreasuryConfig>,
    #[account(mut)]
    pub multisig: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct GovernanceAction<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = multisig @ TreasuryError::Unauthorized,
    )]
    pub config: Account<'info, TreasuryConfig>,
    pub multisig: Signer<'info>,
}

#[derive(Accounts)]
pub struct ApplyFeeChange<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, TreasuryConfig>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = multisig @ TreasuryError::Unauthorized,
    )]
    pub config: Account<'info, TreasuryConfig>,
    #[account(mut)]
    pub multisig: Signer<'info>,
    /// Treasury's token account holding accumulated fees.
    #[account(
        mut,
        constraint = treasury_token_account.owner == config.key() @ TreasuryError::InvalidTokenAccount,
    )]
    pub treasury_token_account: Account<'info, TokenAccount>,
    /// Destination — must match config.fee_receiver ownership.
    #[account(
        mut,
        constraint = fee_receiver_token_account.owner == config.fee_receiver @ TreasuryError::InvalidFeeReceiver,
    )]
    pub fee_receiver_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

// ── Events ────────────────────────────────────────────────────────────────────

#[event]
pub struct TreasuryInitialized {
    pub multisig: Pubkey,
    pub fee_receiver: Pubkey,
    pub initial_fee_bps: u64,
}

#[event]
pub struct FeeChangeProposed {
    pub proposed_by: Pubkey,
    pub new_fee_bps: u64,
    pub executable_after: i64,
}

#[event]
pub struct FeeChangeCancelled {
    pub cancelled_by: Pubkey,
}

#[event]
pub struct FeeChangeApplied {
    pub old_fee_bps: u64,
    pub new_fee_bps: u64,
}

#[event]
pub struct FeeReceiverUpdated {
    pub old_receiver: Pubkey,
    pub new_receiver: Pubkey,
    pub updated_by: Pubkey,
}

#[event]
pub struct FeeReceiverChangeProposed {
    pub proposed_by: Pubkey,
    pub new_receiver: Pubkey,
    pub executable_after: i64,
}

#[event]
pub struct FeeReceiverChangeCancelled {
    pub cancelled_by: Pubkey,
}

#[event]
pub struct FeeWithdrawn {
    pub amount: u64,
    pub to: Pubkey,
    pub by: Pubkey,
}
