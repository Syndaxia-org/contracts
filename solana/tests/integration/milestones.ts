// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Association Syndaxia (Governance)
//
// Milestone deals integration tests.
// Covers: milestone creation, sequential release, bitmask tracking,
//         sum-mismatch rejection, double-release rejection.

import * as anchor from "@coral-xyz/anchor";
import { getAccount } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { setupBase, setupActors, BaseContext } from "../helpers/setup";
import { setupTreasury } from "../helpers/treasury";
import { createTestDeal } from "../helpers/deal";
import { DEAL_AMOUNT, FEE_BPS, RELEASE_DELAY, TIMEOUT, DISPUTE_DELAY, DISPUTE_RESOLUTION_WINDOW, METADATA_HASH } from "../helpers/constants";

describe("milestone deals", () => {
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

  it("creates a milestone deal with 3 milestones", async () => {
    const dealKeypair = Keypair.generate();
    const milestones = [new anchor.BN(400_000), new anchor.BN(300_000), new anchor.BN(300_000)];

    await ctx.program.methods
      .createDeal(DEAL_AMOUNT, FEE_BPS, RELEASE_DELAY, TIMEOUT, DISPUTE_DELAY, DISPUTE_RESOLUTION_WINDOW, METADATA_HASH, milestones)
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
    expect(deal.milestoneCount).to.equal(3);
    expect(deal.releasedMask).to.equal(0);
    expect(deal.milestoneAmounts[0].toNumber()).to.equal(400_000);
    expect(deal.milestoneAmounts[1].toNumber()).to.equal(300_000);
    expect(deal.milestoneAmounts[2].toNumber()).to.equal(300_000);
  });

  it("releases milestones one by one and tracks bitmask", async () => {
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
      milestoneAmounts: [new anchor.BN(600_000), new anchor.BN(400_000)],
    });

    const sellerBefore = await getAccount(ctx.provider.connection, sellerTokenAccount);

    // Release milestone 0 — deal stays Open
    await ctx.program.methods
      .releaseMilestone(0)
      .accounts({
        deal: dealKeypair.publicKey,
        authority: buyer.publicKey,
        beneficiaryTokenAccount: sellerTokenAccount,
        buyerTokenAccount,
        rentReceiver: buyer.publicKey,
      })
      .signers([buyer])
      .rpc();

    let deal = await ctx.program.account.deal.fetch(dealKeypair.publicKey);
    expect(deal.releasedMask).to.equal(1);     // bit 0 set
    expect(JSON.stringify(deal.status)).to.equal(JSON.stringify({ open: {} }));

    const sellerMid = await getAccount(ctx.provider.connection, sellerTokenAccount);
    expect(Number(sellerMid.amount) - Number(sellerBefore.amount)).to.equal(600_000);

    // Release milestone 1 — deal becomes Released
    await ctx.program.methods
      .releaseMilestone(1)
      .accounts({
        deal: dealKeypair.publicKey,
        authority: buyer.publicKey,
        beneficiaryTokenAccount: sellerTokenAccount,
        buyerTokenAccount,
        rentReceiver: buyer.publicKey,
      })
      .signers([buyer])
      .rpc();

    deal = await ctx.program.account.deal.fetch(dealKeypair.publicKey);
    expect(deal.releasedMask).to.equal(3);     // bits 0+1 set
    expect(JSON.stringify(deal.status)).to.equal(JSON.stringify({ released: {} }));

    const sellerAfter = await getAccount(ctx.provider.connection, sellerTokenAccount);
    expect(Number(sellerAfter.amount) - Number(sellerBefore.amount)).to.equal(1_000_000);
  });

  it("rejects release() on a milestone deal (must use release_milestone)", async () => {
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
      milestoneAmounts: [new anchor.BN(500_000), new anchor.BN(500_000)],
    });

    try {
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
      expect.fail("Should have thrown UseMilestoneRelease");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.toString()).to.contain("UseMilestoneRelease");
    }
  });

  it("rejects milestone amounts that don't sum to deal amount", async () => {
    const dealKeypair = Keypair.generate();
    try {
      await ctx.program.methods
        .createDeal(
          DEAL_AMOUNT, FEE_BPS, RELEASE_DELAY, TIMEOUT, DISPUTE_DELAY, DISPUTE_RESOLUTION_WINDOW, METADATA_HASH,
          [new anchor.BN(500_000), new anchor.BN(400_000)] // sum = 900k ≠ 1M
        )
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
      expect.fail("Should have thrown MilestoneSumMismatch");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.toString()).to.contain("MilestoneSumMismatch");
    }
  });

  it("rejects releasing the same milestone twice", async () => {
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
      milestoneAmounts: [new anchor.BN(500_000), new anchor.BN(500_000)],
    });

    await ctx.program.methods
      .releaseMilestone(0)
      .accounts({
        deal: dealKeypair.publicKey,
        authority: buyer.publicKey,
        beneficiaryTokenAccount: sellerTokenAccount,
        buyerTokenAccount,
        rentReceiver: buyer.publicKey,
      })
      .signers([buyer])
      .rpc();

    try {
      await ctx.program.methods
        .releaseMilestone(0)
        .accounts({
          deal: dealKeypair.publicKey,
          authority: buyer.publicKey,
          beneficiaryTokenAccount: sellerTokenAccount,
          buyerTokenAccount,
          rentReceiver: buyer.publicKey,
        })
        .signers([buyer])
        .rpc();
      expect.fail("Should have thrown MilestoneAlreadyReleased");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.toString()).to.contain("MilestoneAlreadyReleased");
    }
  });
});
