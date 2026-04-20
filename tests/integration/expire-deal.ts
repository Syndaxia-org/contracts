// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Association Syndaxia (Governance)
//
// Expire deal integration tests.
// Note: happy-path expiry tests (Open past timeout, Disputed past resolution window)
// require clock advancement which isn't easily achievable with anchor's local test
// validator without bankrun. These tests focus on the rejection paths.

import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { setupBase, setupActors, BaseContext } from "../helpers/setup";
import { setupTreasury } from "../helpers/treasury";
import { createTestDeal } from "../helpers/deal";

describe("expire_deal", () => {
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

  it("rejects expiry on Open deal before timeout has elapsed", async () => {
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
      timeout: new anchor.BN(30 * 24 * 3600), // 30 days — way in the future
    });

    try {
      await ctx.program.methods
        .expireDeal()
        .accounts({
          deal: dealKeypair.publicKey,
          authority: buyer.publicKey,
          beneficiaryTokenAccount: sellerTokenAccount,
          buyerTokenAccount,
          rentReceiver: buyer.publicKey,
        })
        .signers([buyer]).rpc();
      expect.fail("Should have thrown DealNotExpired");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.toString()).to.contain("DealNotExpired");
    }
  });

  it("rejects expiry on Disputed deal before resolution window has elapsed", async () => {
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
      disputeDelay: new anchor.BN(0),
      disputeResolutionWindow: new anchor.BN(30 * 24 * 3600), // 30 days
    });

    // Open dispute
    await ctx.program.methods
      .dispute()
      .accounts({ deal: dealKeypair.publicKey, authority: buyer.publicKey })
      .signers([buyer]).rpc();

    try {
      await ctx.program.methods
        .expireDeal()
        .accounts({
          deal: dealKeypair.publicKey,
          authority: buyer.publicKey,
          beneficiaryTokenAccount: sellerTokenAccount,
          buyerTokenAccount,
          rentReceiver: buyer.publicKey,
        })
        .signers([buyer]).rpc();
      expect.fail("Should have thrown DealNotExpired");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.toString()).to.contain("DealNotExpired");
    }
  });

  it("rejects expiry on already Released deal", async () => {
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
    });

    // Release the deal first
    await ctx.program.methods
      .release()
      .accounts({
        deal: dealKeypair.publicKey,
        authority: buyer.publicKey,
        beneficiaryTokenAccount: sellerTokenAccount,
        buyerTokenAccount,
        rentReceiver: buyer.publicKey,
      })
      .signers([buyer]).rpc();

    try {
      await ctx.program.methods
        .expireDeal()
        .accounts({
          deal: dealKeypair.publicKey,
          authority: buyer.publicKey,
          beneficiaryTokenAccount: sellerTokenAccount,
          buyerTokenAccount,
          rentReceiver: buyer.publicKey,
        })
        .signers([buyer]).rpc();
      expect.fail("Should have rejected: deal already released");
    } catch (err: any) {
      const s = err.error?.errorCode?.code || err.toString();
      expect(s).to.satisfy((v: string) =>
        v.includes("NotEligible") || v.includes("AccountNotInitialized")
      );
    }
  });

  it("rejects expiry on Refunded deal", async () => {
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
    });

    // Refund the deal (validator-initiated)
    await ctx.program.methods
      .refund()
      .accounts({
        deal: dealKeypair.publicKey,
        authority: ctx.validator.publicKey,
        beneficiaryTokenAccount: sellerTokenAccount,
        buyerTokenAccount,
        rentReceiver: buyer.publicKey,
      })
      .signers([ctx.validator]).rpc();

    try {
      await ctx.program.methods
        .expireDeal()
        .accounts({
          deal: dealKeypair.publicKey,
          authority: buyer.publicKey,
          beneficiaryTokenAccount: sellerTokenAccount,
          buyerTokenAccount,
          rentReceiver: buyer.publicKey,
        })
        .signers([buyer]).rpc();
      expect.fail("Should have rejected: deal already refunded");
    } catch (err: any) {
      const s = err.error?.errorCode?.code || err.toString();
      expect(s).to.satisfy((v: string) =>
        v.includes("NotEligible") || v.includes("AccountNotInitialized")
      );
    }
  });
});
