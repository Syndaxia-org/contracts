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

/// Maximum number of milestones per deal.
pub const MAX_MILESTONES: usize = 8;

/// A deal carries ALL its parameters — no global config, no mutable admin state.
/// Once created, every field except `status`, `released_mask`, and `beneficiary`
/// is immutable for the lifetime of the deal.
#[account]
pub struct Deal {
    /// The seller (payee). Immutable after creation.
    pub seller: Pubkey,
    /// The buyer (payer). Immutable after creation.
    pub buyer: Pubkey,
    /// The validator (arbitrator for disputes). Immutable after creation.
    pub validator: Pubkey,
    /// Token account owner that receives fees. Immutable after creation.
    pub fee_collector: Pubkey,
    /// Current beneficiary of escrow funds. Defaults to `seller`.
    /// Can be changed by the current beneficiary via `transfer_beneficiary`.
    pub beneficiary: Pubkey,
    /// Total deal amount held in escrow.
    pub amount: u64,
    /// Fee in basis points, deducted at deal creation. Immutable.
    pub fee_bps: u64,
    /// Off-chain metadata hash (e.g. IPFS CID of the invoice/contract).
    pub metadata_hash: [u8; 32],
    /// Unix timestamp when the deal was created.
    pub created_at: i64,
    /// Seconds after creation before buyer/validator can release (Open deals).
    pub release_delay: i64,
    /// Seconds after (created_at + release_delay) before the deal becomes
    /// expirable and anyone can trigger a refund.
    pub timeout: i64,
    /// Seconds after deal creation before a dispute can be opened.
    /// Set per deal by the marketplace; 0 = instant disputes allowed.
    pub dispute_delay: i64,
    /// Current deal status.
    pub status: Status,
    /// Number of milestones (0 = simple deal, >0 = milestone deal).
    pub milestone_count: u8,
    /// Bitmask of released milestones (bit i = milestone i released).
    pub released_mask: u8,
    /// Per-milestone amounts. Only the first `milestone_count` entries are used.
    /// For a simple deal (milestone_count == 0), this is zeroed.
    pub milestone_amounts: [u64; MAX_MILESTONES],
}

impl Deal {
    /// Account size: 8 (discriminator) + fields.
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 32 + 32 + 8 + 8 + 32 + 8 + 8 + 8 + 8 + 1 + 1 + 1 + 64;

    /// Returns true if all milestones have been released.
    pub fn all_milestones_released(&self) -> bool {
        if self.milestone_count == 0 {
            return false;
        }
        let mask = (1u8 << self.milestone_count) - 1;
        self.released_mask & mask == mask
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum Status {
    Open,
    Released,
    Refunded,
    Disputed,
}
