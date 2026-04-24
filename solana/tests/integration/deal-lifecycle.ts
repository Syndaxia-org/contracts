// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Association Syndaxia (Governance)
//
// Deal lifecycle integration tests — no milestones.
// Covers: create, release, refund, dispute flows.
// Each test is independent: createTestDeal() provisions a fresh deal.

import * as anchor from "@coral-xyz/anchor";
import { getAccount } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { setupBase, setupActors, BaseContext } from "../helpers/setup";
import { setupTreasury } from "../helpers/treasury";
import { createTestDeal } from "../helpers/deal";
import { DEAL_AMOUNT, FEE_BPS, RELEASE_DELAY, TIMEOUT, DISPUTE_DELAY, DISPUTE_RESOLUTION_WINDOW, METADATA_HASH } from "../helpers/constants";

describe("deal lifecycle", () => {
  let ctx: BaseContext;
  let buyer: Keypair;
  let seller: Keypair;
  let buyerTokenAccount: PublicKey;
  let sellerTokenAccount: PublicKey;
  let treasuryConfigPda: PublicKey;
  let treasuryTokenAccount: PublicKey;

  before(async () => {
    ctx = await setupBase();
    ({ treasuryConfigPda, treasuryTokenAccount } = await setupTreasury(ctx.provider, ctx.mint));
    ({ buyer, seller, buyerTokenAccount, sellerTokenAccount } = await setupActors(ctx));
  });

  it("creates a deal and escrows funds", async () => {
    const dealKeypair = Keypair.generate();
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), dealKeypair.publicKey.toBuffer()],
      ctx.program.programId
    );

    const buyerBefore = await getAccount(ctx.provider.connection, buyerTokenAccount);

    await ctx.program.methods
      .createDeal(DEAL_AMOUNT, FEE_BPS, RELEASE_DELAY, TIMEOUT, DISPUTE_DELAY, DISPUTE_RESOLUTION_WINDOW, METADATA_HASH, [])
      .accounts({
        deal: dealKeypair.publicKey,
        buyer: buyer.publicKey,
        seller: seller.publicKey,
        validator: ctx.validator.publicKey,
        buyerTokenAccount,
        feeCollector: ctx.feeCollector.publicKey,
        feeCollectorTokenAccount: ctx.feeCollectorTokenAccount,
        treasuryTokenAccount,
        mint: ctx.mint,
      })
      .signers([buyer, dealKeypair])
      .rpc();

    const deal = await ctx.program.account.deal.fetch(dealKeypair.publicKey);
    expect(deal.amount.toNumber()).to.equal(1_000_000);
    expect(deal.buyer.toBase58()).to.equal(buyer.publicKey.toBase58());
    expect(deal.seller.toBase58()).to.equal(seller.publicKey.toBase58());
    expect(deal.validator.toBase58()).to.equal(ctx.validator.publicKey.toBase58());
    expect(deal.beneficiary.toBase58()).to.equal(seller.publicKey.toBase58());
    expect(deal.feeBps.toNumber()).to.equal(500);
    expect(deal.milestoneCount).to.equal(0);
    expect(JSON.stringify(deal.status)).to.equal(JSON.stringify({ open: {} }));

    const escrow = await getAccount(ctx.provider.connection, escrowPda);
    expect(Number(escrow.amount)).to.equal(1_000_000);

    // 5% fee = 50,000
    const feeAccount = await getAccount(ctx.provider.connection, ctx.feeCollectorTokenAccount);
    expect(Number(feeAccount.amount)).to.equal(50_000);

    // buyer paid: escrow (1M) + deal fee (50k) + protocol fee (5 BPS of 1M = 500)
    const buyerAfter = await getAccount(ctx.provider.connection, buyerTokenAccount);
    expect(Number(buyerBefore.amount) - Number(buyerAfter.amount)).to.equal(1_050_500);
  });

  it("rejects deal with zero amount", async () => {
    const dealKeypair = Keypair.generate();
    try {
      await ctx.program.methods
        .createDeal(new anchor.BN(0), FEE_BPS, RELEASE_DELAY, TIMEOUT, DISPUTE_DELAY, DISPUTE_RESOLUTION_WINDOW, METADATA_HASH, [])
        .accounts({
          deal: dealKeypair.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          validator: ctx.validator.publicKey,
          buyerTokenAccount,
          feeCollector: ctx.feeCollector.publicKey,
          feeCollectorTokenAccount: ctx.feeCollectorTokenAccount,
          treasuryTokenAccount,
          mint: ctx.mint,
        })
        .signers([buyer, dealKeypair])
        .rpc();
      expect.fail("Should have thrown InvalidAmount");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.toString()).to.contain("InvalidAmount");
    }
  });

  it("rejects fee > 10%", async () => {
    const dealKeypair = Keypair.generate();
    try {
      await ctx.program.methods
        .createDeal(DEAL_AMOUNT, new anchor.BN(1001), RELEASE_DELAY, TIMEOUT, DISPUTE_DELAY, DISPUTE_RESOLUTION_WINDOW, METADATA_HASH, [])
        .accounts({
          deal: dealKeypair.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          validator: ctx.validator.publicKey,
          buyerTokenAccount,
          feeCollector: ctx.feeCollector.publicKey,
          feeCollectorTokenAccount: ctx.feeCollectorTokenAccount,
          treasuryTokenAccount,
          mint: ctx.mint,
        })
        .signers([buyer, dealKeypair])
        .rpc();
      expect.fail("Should have thrown FeeTooHigh");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.toString()).to.contain("FeeTooHigh");
    }
  });

  it("buyer releases funds to seller", async () => {
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
    });

    const sellerBefore = await getAccount(ctx.provider.connection, sellerTokenAccount);

    await ctx.program.methods
      .release()
      .accounts({
        deal: dealKeypair.publicKey,
        authority: buyer.publicKey,
        beneficiaryTokenAccount: sellerTokenAccount,
        buyerTokenAccount,
        rentReceiver: buyer.publicKey,
      })
      .signers([buyer])
      .rpc();

    const deal = await ctx.program.account.deal.fetch(dealKeypair.publicKey);
    expect(JSON.stringify(deal.status)).to.equal(JSON.stringify({ released: {} }));

    const sellerAfter = await getAccount(ctx.provider.connection, sellerTokenAccount);
    expect(Number(sellerAfter.amount) - Number(sellerBefore.amount)).to.equal(1_000_000);
  });

  it("seller refunds buyer", async () => {
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
    });

    const buyerBefore = await getAccount(ctx.provider.connection, buyerTokenAccount);

    await ctx.program.methods
      .refund()
      .accounts({
        deal: dealKeypair.publicKey,
        authority: seller.publicKey,
        beneficiaryTokenAccount: sellerTokenAccount,
        buyerTokenAccount,
        rentReceiver: buyer.publicKey,
      })
      .signers([seller])
      .rpc();

    const deal = await ctx.program.account.deal.fetch(dealKeypair.publicKey);
    expect(JSON.stringify(deal.status)).to.equal(JSON.stringify({ refunded: {} }));

    const buyerAfter = await getAccount(ctx.provider.connection, buyerTokenAccount);
    expect(Number(buyerAfter.amount) - Number(buyerBefore.amount)).to.equal(1_000_000);
  });

  it("buyer can dispute and validator releases", async () => {
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
    });

    await ctx.program.methods
      .dispute()
      .accounts({ deal: dealKeypair.publicKey, authority: buyer.publicKey })
      .signers([buyer])
      .rpc();

    const dealDisputed = await ctx.program.account.deal.fetch(dealKeypair.publicKey);
    expect(JSON.stringify(dealDisputed.status)).to.equal(JSON.stringify({ disputed: {} }));

    await ctx.program.methods
      .release()
      .accounts({
        deal: dealKeypair.publicKey,
        authority: ctx.validator.publicKey,
        beneficiaryTokenAccount: sellerTokenAccount,
        buyerTokenAccount,
        rentReceiver: buyer.publicKey,
      })
      .signers([ctx.validator])
      .rpc();

    const dealAfter = await ctx.program.account.deal.fetch(dealKeypair.publicKey);
    expect(JSON.stringify(dealAfter.status)).to.equal(JSON.stringify({ released: {} }));
  });

  it("rejects release from unauthorized party", async () => {
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
    });

    const hacker = Keypair.generate();
    const sig = await ctx.provider.connection.requestAirdrop(hacker.publicKey, anchor.web3.LAMPORTS_PER_SOL);
    await ctx.provider.connection.confirmTransaction(sig);

    try {
      await ctx.program.methods
        .release()
        .accounts({
          deal: dealKeypair.publicKey,
          authority: hacker.publicKey,
          beneficiaryTokenAccount: sellerTokenAccount,
          buyerTokenAccount,
          rentReceiver: buyer.publicKey,
        })
        .signers([hacker])
        .rpc();
      expect.fail("Should have thrown Unauthorized");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.toString()).to.contain("Unauthorized");
    }
  });
});
