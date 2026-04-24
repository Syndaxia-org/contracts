// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Association Syndaxia (Governance)
//
// BaseContext — equivalent of Morpho Blue's BaseTest.
// Every integration test calls setupBase() in its before() hook.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SyndaxiaCore } from "../../target/types/syndaxia_core";
import { createMint, createAccount, mintTo } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";

export interface BaseContext {
  provider: anchor.AnchorProvider;
  program: Program<SyndaxiaCore>;
  admin: anchor.Wallet;
  mint: PublicKey;
  feeCollector: Keypair;
  feeCollectorTokenAccount: PublicKey;
  validator: Keypair;
}

// Creates a fresh set of shared actors + a SPL mint.
// Equivalent to Morpho's setUp(): deploys the protocol and sets up test actors.
export async function setupBase(): Promise<BaseContext> {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SyndaxiaCore as Program<SyndaxiaCore>;
  const admin = provider.wallet as anchor.Wallet;

  const feeCollector = Keypair.generate();
  const validator = Keypair.generate();

  const sig = await provider.connection.requestAirdrop(
    admin.publicKey,
    10 * anchor.web3.LAMPORTS_PER_SOL
  );
  await provider.connection.confirmTransaction(sig);

  const mint = await createMint(
    provider.connection,
    admin.payer,
    admin.publicKey,
    null,
    6
  );

  const feeCollectorTokenAccount = await createAccount(
    provider.connection,
    admin.payer,
    mint,
    feeCollector.publicKey
  );

  return { provider, program, admin, mint, feeCollector, feeCollectorTokenAccount, validator };
}

// Creates a buyer + seller with funded token accounts.
// Equivalent to Morpho's _supply() / _supplyCollateralForBorrower() helpers.
export async function setupActors(
  ctx: BaseContext,
  mintAmount = 50_000_000
): Promise<{
  buyer: Keypair;
  seller: Keypair;
  buyerTokenAccount: PublicKey;
  sellerTokenAccount: PublicKey;
}> {
  const buyer = Keypair.generate();
  const seller = Keypair.generate();

  for (const kp of [buyer, seller, ctx.validator]) {
    const sig = await ctx.provider.connection.requestAirdrop(
      kp.publicKey,
      5 * anchor.web3.LAMPORTS_PER_SOL
    );
    await ctx.provider.connection.confirmTransaction(sig);
  }

  const buyerTokenAccount = await createAccount(
    ctx.provider.connection,
    ctx.admin.payer,
    ctx.mint,
    buyer.publicKey
  );

  const sellerTokenAccount = await createAccount(
    ctx.provider.connection,
    ctx.admin.payer,
    ctx.mint,
    seller.publicKey
  );

  await mintTo(
    ctx.provider.connection,
    ctx.admin.payer,
    ctx.mint,
    buyerTokenAccount,
    ctx.admin.publicKey,
    mintAmount
  );

  return { buyer, seller, buyerTokenAccount, sellerTokenAccount };
}
