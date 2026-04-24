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

/// Maximum fee in basis points (10%). Hardcoded — no admin can change this.
pub const MAX_FEE_BPS: u64 = 1000;

/// BPS denominator (100% = 10,000 BPS).
pub const BPS_DENOMINATOR: u64 = 10000;

/// Maximum allowed release delay in seconds (365 days).
pub const MAX_RELEASE_DELAY: i64 = 365 * 24 * 3600;

/// Minimum timeout in seconds (1 hour). Safety floor — marketplaces choose
/// their own timeout per deal, but cannot go below this.
pub const MIN_TIMEOUT: i64 = 3600;

/// Maximum timeout in seconds (365 days). Prevents deals from being locked forever.
pub const MAX_TIMEOUT: i64 = 365 * 24 * 3600;

/// Maximum allowed dispute delay in seconds (365 days).
pub const MAX_DISPUTE_DELAY: i64 = 365 * 24 * 3600;

/// Minimum dispute resolution window per deal (1 day).
pub const MIN_DISPUTE_RESOLUTION_WINDOW: i64 = 24 * 3600;

/// Maximum dispute resolution window per deal (365 days).
pub const MAX_DISPUTE_RESOLUTION_WINDOW: i64 = 365 * 24 * 3600;

/// Maximum number of times the validator can extend a dispute resolution window.
pub const MAX_DISPUTE_EXTENSIONS: u8 = 2;

/// Maximum number of milestones per deal.
pub const MAX_MILESTONES: usize = 8;

/// Absolute ceiling for the protocol fee (20 BPS = 0.20%).
/// Even if the Treasury governance votes for a higher value, the Core will reject it.
/// This protects users permanently — this constant can never be changed post-deployment.
pub const MAX_PROTOCOL_FEE_BPS: u64 = 20;

/// The Program ID of syndaxia-treasury. Used to derive and verify the TreasuryConfig PDA.
/// Hardcoded here so no caller can substitute a fake treasury account.
///
/// Build devnet  : `anchor build`                        (default)
/// Build mainnet : `anchor build --features mainnet`
///
/// Pour obtenir l'adresse mainnet :
///   1. Générer le keypair treasury mainnet : `solana-keygen new -o .keys/treasury-mainnet.json`
///   2. Lire l'adresse : `solana-keygen pubkey .keys/treasury-mainnet.json`
///   3. Remplacer REMPLACER_PAR_ADRESSE_TREASURY_MAINNET ci-dessous
///   4. Rebuild core avec --features mainnet puis déployer
#[cfg(not(feature = "mainnet"))]
pub const TREASURY_PROGRAM_ID: Pubkey = pubkey!("D8H3JetPqdFasLXGbAqjhrrArfoYmy8PwQtt8KehZLxd");

#[cfg(feature = "mainnet")]
pub const TREASURY_PROGRAM_ID: Pubkey = pubkey!("DvoZj1cKMi8DEvTxBgNEnj9Fhxx9PRAsVTEWEZ2e6YHx");

/// Seeds for the TreasuryConfig PDA — must match the constant in syndaxia-treasury.
pub const TREASURY_CONFIG_SEED: &[u8] = b"treasury-config";
