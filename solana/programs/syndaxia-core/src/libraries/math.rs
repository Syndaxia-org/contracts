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

use crate::constants::BPS_DENOMINATOR;
use crate::errors::SyndaxiaError;

/// Calculate fee in basis points on a given amount.
/// Uses checked arithmetic to prevent overflows.
pub fn calculate_fee(amount: u64, fee_bps: u64) -> Result<u64> {
    amount
        .checked_mul(fee_bps)
        .and_then(|v| v.checked_div(BPS_DENOMINATOR))
        .ok_or_else(|| error!(SyndaxiaError::MathOverflow))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calculate_fee_normal() {
        assert_eq!(calculate_fee(1_000_000, 500).unwrap(), 50_000);
    }

    #[test]
    fn test_calculate_fee_zero_bps() {
        assert_eq!(calculate_fee(1_000_000, 0).unwrap(), 0);
    }

    #[test]
    fn test_calculate_fee_zero_amount() {
        assert_eq!(calculate_fee(0, 500).unwrap(), 0);
    }

    #[test]
    fn test_calculate_fee_max_bps() {
        assert_eq!(calculate_fee(1_000_000, 1000).unwrap(), 100_000);
    }

    #[test]
    fn test_calculate_fee_precision() {
        assert_eq!(calculate_fee(100, 300).unwrap(), 3);
    }

    #[test]
    fn test_calculate_fee_rounding_down() {
        assert_eq!(calculate_fee(99, 100).unwrap(), 0);
    }
}
