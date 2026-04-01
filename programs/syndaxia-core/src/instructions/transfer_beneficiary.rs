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

use crate::errors::SyndaxiaError;
use crate::state::{Deal, Status};

#[derive(Accounts)]
pub struct TransferBeneficiary<'info> {
    #[account(mut)]
    pub deal: Account<'info, Deal>,
    pub beneficiary: Signer<'info>,
}

/// Transfer the beneficiary (payee) of a deal.
/// Only the current beneficiary can call this.
/// This is the "hook" that allows external contracts (e.g. a Vault doing
/// invoice factoring) to receive the funds instead of the original seller.
pub fn handler(ctx: Context<TransferBeneficiary>, new_beneficiary: Pubkey) -> Result<()> {
    let deal = &mut ctx.accounts.deal;

    require!(
        ctx.accounts.beneficiary.key() == deal.beneficiary,
        SyndaxiaError::Unauthorized
    );
    require!(
        deal.status == Status::Open || deal.status == Status::Disputed,
        SyndaxiaError::NotEligible
    );
    require!(
        new_beneficiary != deal.buyer,
        SyndaxiaError::BeneficiaryEqualsBuyer
    );

    let old = deal.beneficiary;
    deal.beneficiary = new_beneficiary;

    emit!(BeneficiaryTransferred {
        deal: deal.key(),
        old_beneficiary: old,
        new_beneficiary,
    });

    Ok(())
}

#[event]
pub struct BeneficiaryTransferred {
    pub deal: Pubkey,
    pub old_beneficiary: Pubkey,
    pub new_beneficiary: Pubkey,
}
