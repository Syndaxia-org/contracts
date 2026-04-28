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
        config.pending_multisig = None;
        config.multisig_timelock_until = 0;

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
        // T-MED-1: cannot overwrite a pending proposal silently.
        require!(
            ctx.accounts.config.pending_fee_bps.is_none(),
            TreasuryError::ProposalAlreadyPending
        );
        // T-MED-3: no-op proposal would only delay future legitimate changes.
        require!(
            new_fee_bps != ctx.accounts.config.protocol_fee_bps,
            TreasuryError::NoOpProposal
        );

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
        // T-MED-2: reject default / current receiver to avoid bricking withdrawals.
        require!(new_fee_receiver != Pubkey::default(), TreasuryError::InvalidFeeReceiver);
        require!(
            new_fee_receiver != ctx.accounts.config.fee_receiver,
            TreasuryError::NoOpProposal
        );
        // T-MED-1: cannot overwrite a pending proposal silently.
        require!(
            ctx.accounts.config.pending_fee_receiver.is_none(),
            TreasuryError::ProposalAlreadyPending
        );

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

        // T-INFO-1: drop misleading `updated_by` (apply is permissionless).
        emit!(FeeReceiverUpdated {
            old_receiver: old,
            new_receiver: pending,
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

    // ── T-HIGH-1: multisig rotation (timelocked) ──────────────────────────

    /// Propose a new multisig (governance key rotation). Starts the 7-day timelock.
    pub fn propose_multisig_change(ctx: Context<GovernanceAction>, new_multisig: Pubkey) -> Result<()> {
        require!(new_multisig != Pubkey::default(), TreasuryError::InvalidMultisig);
        require!(
            new_multisig != ctx.accounts.config.multisig,
            TreasuryError::NoOpProposal
        );
        require!(
            ctx.accounts.config.pending_multisig.is_none(),
            TreasuryError::ProposalAlreadyPending
        );

        let config = &mut ctx.accounts.config;
        let now = Clock::get()?.unix_timestamp;
        config.pending_multisig = Some(new_multisig);
        config.multisig_timelock_until = now
            .checked_add(FEE_CHANGE_TIMELOCK)
            .ok_or(TreasuryError::MathOverflow)?;

        emit!(MultisigChangeProposed {
            proposed_by: ctx.accounts.multisig.key(),
            new_multisig,
            executable_after: config.multisig_timelock_until,
        });
        Ok(())
    }

    /// Cancel a pending multisig rotation. Only the (current) multisig can cancel.
    pub fn cancel_multisig_change(ctx: Context<GovernanceAction>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(config.pending_multisig.is_some(), TreasuryError::NoPendingMultisigProposal);
        config.pending_multisig = None;
        config.multisig_timelock_until = 0;

        emit!(MultisigChangeCancelled {
            cancelled_by: ctx.accounts.multisig.key(),
        });
        Ok(())
    }

    /// Apply a pending multisig rotation after the timelock. Permissionless.
    pub fn apply_multisig_change(ctx: Context<ApplyFeeChange>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let pending = config.pending_multisig.ok_or(TreasuryError::NoPendingMultisigProposal)?;
        let now = Clock::get()?.unix_timestamp;
        require!(now >= config.multisig_timelock_until, TreasuryError::TimelockNotElapsed);

        let old = config.multisig;
        config.multisig = pending;
        config.pending_multisig = None;
        config.multisig_timelock_until = 0;

        emit!(MultisigRotated { old_multisig: old, new_multisig: pending });
        Ok(())
    }

    /// One-shot migration of v1 accounts to v2 layout (adds pending_multisig fields).
    /// Idempotent: safe to call once. Caller (any signer) pays the rent delta.
    /// Must be the FIRST instruction called against the upgraded program for any
    /// pre-existing v1 account, otherwise normal deserialize will fail.
    pub fn migrate_v2(ctx: Context<MigrateV2>) -> Result<()> {
        let config_ai = &ctx.accounts.config;
        let cur_len = config_ai.data_len();
        require!(cur_len == TreasuryConfig::SPACE_V1, TreasuryError::AlreadyMigrated);

        // Realloc the account to V2 size and zero-init the appended bytes.
        let new_len = TreasuryConfig::SPACE;
        let rent = Rent::get()?;
        let new_minimum = rent.minimum_balance(new_len);
        let lamports_needed = new_minimum.saturating_sub(config_ai.lamports());
        if lamports_needed > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: config_ai.to_account_info(),
                    },
                ),
                lamports_needed,
            )?;
        }
        config_ai.to_account_info().resize(new_len)?;
        // Explicitly zero the appended bytes (Option<Pubkey>=None tag 0, i64=0).
        {
            let info = config_ai.to_account_info();
            let mut data = info.try_borrow_mut_data()?;
            for byte in data[cur_len..new_len].iter_mut() {
                *byte = 0;
            }
        }

        // Appended bytes are zero → Option<Pubkey>=None (tag 0), i64=0. Already correct.

        emit!(ConfigMigratedV2 { config: config_ai.key() });
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

#[derive(Accounts)]
pub struct MigrateV2<'info> {
    /// Config account (raw — may still be v1 layout). Verified by seeds.
    /// CHECK: validated via PDA seeds; written via raw realloc.
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
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
}

#[event]
pub struct MultisigChangeProposed {
    pub proposed_by: Pubkey,
    pub new_multisig: Pubkey,
    pub executable_after: i64,
}

#[event]
pub struct MultisigChangeCancelled {
    pub cancelled_by: Pubkey,
}

#[event]
pub struct MultisigRotated {
    pub old_multisig: Pubkey,
    pub new_multisig: Pubkey,
}

#[event]
pub struct ConfigMigratedV2 {
    pub config: Pubkey,
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
