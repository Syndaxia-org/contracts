// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Association Syndaxia (Governance)
//
// Licensed under the Business Source License 1.1 (the "License");
// you may not use this file except in compliance with the License.
#![allow(unexpected_cfgs)]
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

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod libraries;
pub mod state;

use instructions::*;

declare_id!("ACFJxibNyTnVJVNTaYgBSi5YoFK3qy3xPqvmVmKynAC1");

#[program]
pub mod syndaxia_core {
    use super::*;

    /// Create a deal and escrow the buyer's funds.
    /// All parameters (validator, fees, timeout, milestones) are set here
    /// and become immutable. No global config, no admin.
    pub fn create_deal(
        ctx: Context<CreateDeal>,
        amount: u64,
        fee_bps: u64,
        release_delay: i64,
        timeout: i64,
        dispute_delay: i64,
        dispute_resolution_window: i64,
        metadata_hash: [u8; 32],
        milestone_amounts: Vec<u64>,
    ) -> Result<()> {
        instructions::create_deal::handler(ctx, amount, fee_bps, release_delay, timeout, dispute_delay, dispute_resolution_window, metadata_hash, milestone_amounts)
    }

    /// Release all escrowed funds to the beneficiary (simple deal, no milestones).
    /// Authorized: buyer or validator.
    pub fn release(ctx: Context<ReleaseRefund>) -> Result<()> {
        instructions::release::handler(ctx)
    }

    /// Release a single milestone from a milestone deal.
    /// Authorized: buyer or validator.
    pub fn release_milestone(ctx: Context<ReleaseMilestone>, milestone_index: u8) -> Result<()> {
        instructions::release_milestone::handler(ctx, milestone_index)
    }

    /// Refund escrowed funds to the buyer.
    /// Authorized: beneficiary (seller) or validator.
    pub fn refund(ctx: Context<ReleaseRefund>) -> Result<()> {
        instructions::refund::handler(ctx)
    }

    /// Open a dispute to block automatic release.
    /// Authorized: buyer or beneficiary (seller).
    pub fn dispute(ctx: Context<DisputeDeal>) -> Result<()> {
        instructions::dispute::handler(ctx)
    }

    /// Resolve a dispute by splitting escrowed funds between buyer and seller.
    /// Authorized: validator only.
    /// `buyer_share + seller_share` must equal the escrowed amount.
    pub fn resolve_dispute(
        ctx: Context<ReleaseRefund>,
        buyer_share: u64,
        seller_share: u64,
    ) -> Result<()> {
        instructions::resolve_dispute::handler(ctx, buyer_share, seller_share)
    }

    /// Expire a deal past its timeout and refund the buyer (permissionless).
    pub fn expire_deal(ctx: Context<ReleaseRefund>) -> Result<()> {
        instructions::expire::handler(ctx)
    }

    /// Extend the dispute resolution window.
    /// Authorized: validator only. Limited to MAX_DISPUTE_EXTENSIONS extensions.
    pub fn extend_dispute(ctx: Context<ExtendDispute>) -> Result<()> {
        instructions::extend_dispute::handler(ctx)
    }

    /// Transfer the beneficiary (payee) of a deal.
    /// Only the current beneficiary can call this — enables factoring/vault hooks.
    pub fn transfer_beneficiary(ctx: Context<TransferBeneficiary>, new_beneficiary: Pubkey) -> Result<()> {
        instructions::transfer_beneficiary::handler(ctx, new_beneficiary)
    }
}
