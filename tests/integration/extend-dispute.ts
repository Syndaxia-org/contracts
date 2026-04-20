// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Association Syndaxia (Governance)
//
// Extend dispute integration tests.
// Covers: validator extends dispute window, extension limit enforcement,
//         max window cap, unauthorized extension attempts.

import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { setupBase, setupActors, BaseContext } from "../helpers/setup";
import { setupTreasury } from "../helpers/treasury";
import { createTestDeal } from "../helpers/deal";

describe("extend_dispute", () => {
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

  it("validator extends dispute resolution window", async () => {
    const window = new anchor.BN(7 * 24 * 3600); // 7 days
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
      disputeDelay: new anchor.BN(0),
      disputeResolutionWindow: window,
    });

    // Open dispute
    await ctx.program.methods
      .dispute()
      .accounts({ deal: dealKeypair.publicKey, authority: buyer.publicKey })
      .signers([buyer]).rpc();

    // Extend
    await ctx.program.methods
      .extendDispute()
      .accounts({ deal: dealKeypair.publicKey, authority: ctx.validator.publicKey })
      .signers([ctx.validator]).rpc();

    const deal = await ctx.program.account.deal.fetch(dealKeypair.publicKey);
    // Window doubles: 7d → 14d
    expect(deal.disputeResolutionWindow.toNumber()).to.equal(14 * 24 * 3600);
    expect(deal.disputeExtensionsRemaining).to.equal(1);
  });

  it("validator can extend twice (max extensions = 2)", async () => {
    const window = new anchor.BN(7 * 24 * 3600); // 7 days
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
      disputeDelay: new anchor.BN(0),
      disputeResolutionWindow: window,
    });

    await ctx.program.methods
      .dispute()
      .accounts({ deal: dealKeypair.publicKey, authority: buyer.publicKey })
      .signers([buyer]).rpc();

    // First extension: 7d → 14d
    await ctx.program.methods
      .extendDispute()
      .accounts({ deal: dealKeypair.publicKey, authority: ctx.validator.publicKey })
      .signers([ctx.validator]).rpc();

    // Second extension: 14d → 21d
    await ctx.program.methods
      .extendDispute()
      .accounts({ deal: dealKeypair.publicKey, authority: ctx.validator.publicKey })
      .signers([ctx.validator]).rpc();

    const deal = await ctx.program.account.deal.fetch(dealKeypair.publicKey);
    // Window doubles twice: 7d → 14d → 28d
    expect(deal.disputeResolutionWindow.toNumber()).to.equal(28 * 24 * 3600);
    expect(deal.disputeExtensionsRemaining).to.equal(0);
  });

  it("rejects third extension (no extensions remaining)", async () => {
    const window = new anchor.BN(7 * 24 * 3600);
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
      disputeDelay: new anchor.BN(0),
      disputeResolutionWindow: window,
    });

    await ctx.program.methods
      .dispute()
      .accounts({ deal: dealKeypair.publicKey, authority: buyer.publicKey })
      .signers([buyer]).rpc();

    // Use both extensions
    await ctx.program.methods
      .extendDispute()
      .accounts({ deal: dealKeypair.publicKey, authority: ctx.validator.publicKey })
      .signers([ctx.validator]).rpc();
    await ctx.program.methods
      .extendDispute()
      .accounts({ deal: dealKeypair.publicKey, authority: ctx.validator.publicKey })
      .signers([ctx.validator]).rpc();

    // Third extension should fail
    try {
      await ctx.program.methods
        .extendDispute()
        .accounts({ deal: dealKeypair.publicKey, authority: ctx.validator.publicKey })
        .signers([ctx.validator]).rpc();
      expect.fail("Should have thrown NoExtensionsRemaining");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.toString()).to.contain("NoExtensionsRemaining");
    }
  });

  it("rejects extension that would exceed MAX_DISPUTE_RESOLUTION_WINDOW", async () => {
    // Set window to 200 days — doubling to 400 days would exceed 365 day max
    const window = new anchor.BN(200 * 24 * 3600);
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
      disputeDelay: new anchor.BN(0),
      disputeResolutionWindow: window,
    });

    await ctx.program.methods
      .dispute()
      .accounts({ deal: dealKeypair.publicKey, authority: buyer.publicKey })
      .signers([buyer]).rpc();

    try {
      await ctx.program.methods
        .extendDispute()
        .accounts({ deal: dealKeypair.publicKey, authority: ctx.validator.publicKey })
        .signers([ctx.validator]).rpc();
      expect.fail("Should have thrown DisputeExtensionTooLong");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.toString()).to.contain("DisputeExtensionTooLong");
    }
  });

  it("rejects extension by non-validator", async () => {
    const window = new anchor.BN(7 * 24 * 3600);
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
      disputeDelay: new anchor.BN(0),
      disputeResolutionWindow: window,
    });

    await ctx.program.methods
      .dispute()
      .accounts({ deal: dealKeypair.publicKey, authority: buyer.publicKey })
      .signers([buyer]).rpc();

    try {
      await ctx.program.methods
        .extendDispute()
        .accounts({ deal: dealKeypair.publicKey, authority: buyer.publicKey })
        .signers([buyer]).rpc();
      expect.fail("Should have thrown Unauthorized");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.toString()).to.contain("Unauthorized");
    }
  });

  it("rejects extension on non-disputed deal", async () => {
    const window = new anchor.BN(7 * 24 * 3600);
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
      disputeResolutionWindow: window,
    });

    try {
      await ctx.program.methods
        .extendDispute()
        .accounts({ deal: dealKeypair.publicKey, authority: ctx.validator.publicKey })
        .signers([ctx.validator]).rpc();
      expect.fail("Should have thrown NotDisputed");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.toString()).to.contain("NotDisputed");
    }
  });

  it("deal creation sets dispute_extensions_remaining to 2", async () => {
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
    });

    const deal = await ctx.program.account.deal.fetch(dealKeypair.publicKey);
    expect(deal.disputeExtensionsRemaining).to.equal(2);
  });
});
