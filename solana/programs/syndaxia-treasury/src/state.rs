// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Association Syndaxia (Governance)

use anchor_lang::prelude::*;

/// Global treasury configuration. Singleton PDA — seeds: ["treasury-config"].
/// The `config` PDA is also the authority over the treasury token account,
/// so only the program can sign withdrawals via the PDA seeds.
#[account]
pub struct TreasuryConfig {
    /// The multisig that controls governance actions (propose, cancel, withdraw).
    pub multisig: Pubkey,
    /// The wallet (owner) that should receive withdrawn protocol fees.
    /// ⚠️ BREAKING LAYOUT WARNING: syndaxia-core reads raw bytes at offsets
    /// 40..72 (fee_receiver) and 72..80 (protocol_fee_bps).
    /// DO NOT reorder or insert fields before offset 80.
    pub fee_receiver: Pubkey,
    /// Current active protocol fee in basis points (0–20 BPS).
    pub protocol_fee_bps: u64,
    /// Pending fee proposal (None if no proposal active).
    pub pending_fee_bps: Option<u64>,
    /// Unix timestamp after which the pending fee proposal can be applied.
    pub timelock_until: i64,
    /// Pending fee_receiver change (None if no proposal active).
    pub pending_fee_receiver: Option<Pubkey>,
    /// Unix timestamp after which the pending fee_receiver change can be applied.
    pub receiver_timelock_until: i64,
    /// PDA bump seed.
    pub bump: u8,
}

impl TreasuryConfig {
    /// Account space:
    /// 8 discriminator
    /// + 32 multisig
    /// + 32 fee_receiver
    /// + 8  protocol_fee_bps
    /// + 9  pending_fee_bps (Option<u64> = 1 tag + 8 data)
    /// + 8  timelock_until
    /// + 33 pending_fee_receiver (Option<Pubkey> = 1 tag + 32 data)
    /// + 8  receiver_timelock_until
    /// + 1  bump
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 9 + 8 + 33 + 8 + 1;
}
