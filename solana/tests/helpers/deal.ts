// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Association Syndaxia (Governance)
//
// createTestDeal — shared helper, equivalent of Morpho's _supply() helper.
// Abstracts the full createDeal instruction with sensible defaults.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { SyndaxiaCore } from "../../target/types/syndaxia_core";
import {
  DEAL_AMOUNT,
  DISPUTE_DELAY,
  DISPUTE_RESOLUTION_WINDOW,
  FEE_BPS,
  METADATA_HASH,
  RELEASE_DELAY,
  TIMEOUT,
} from "./constants";

export interface CreateDealOpts {
  program: Program<SyndaxiaCore>;
  buyer: Keypair;
  seller: Keypair;
  validator: Keypair;
  buyerTokenAccount: PublicKey;
  feeCollector: Keypair;
  feeCollectorTokenAccount: PublicKey;
  treasuryConfigPda: PublicKey;
  treasuryTokenAccount: PublicKey;
  mint: PublicKey;
  // Overrideable parameters
  amount?: anchor.BN;
  feeBps?: anchor.BN;
  releaseDelay?: anchor.BN;
  timeout?: anchor.BN;
  disputeDelay?: anchor.BN;
  disputeResolutionWindow?: anchor.BN;
  milestoneAmounts?: anchor.BN[];
}

export async function createTestDeal(opts: CreateDealOpts): Promise<Keypair> {
  const dealKeypair = Keypair.generate();

  await opts.program.methods
    .createDeal(
      opts.amount ?? DEAL_AMOUNT,
      opts.feeBps ?? FEE_BPS,
      opts.releaseDelay ?? RELEASE_DELAY,
      opts.timeout ?? TIMEOUT,
      opts.disputeDelay ?? DISPUTE_DELAY,
      opts.disputeResolutionWindow ?? DISPUTE_RESOLUTION_WINDOW,
      METADATA_HASH,
      opts.milestoneAmounts ?? []
    )
    .accounts({
      deal: dealKeypair.publicKey,
      buyer: opts.buyer.publicKey,
      seller: opts.seller.publicKey,
      validator: opts.validator.publicKey,
      buyerTokenAccount: opts.buyerTokenAccount,
      feeCollector: opts.feeCollector.publicKey,
      feeCollectorTokenAccount: opts.feeCollectorTokenAccount,
      treasuryTokenAccount: opts.treasuryTokenAccount,
      mint: opts.mint,
    })
    .signers([opts.buyer, dealKeypair])
    .rpc();

  return dealKeypair;
}
