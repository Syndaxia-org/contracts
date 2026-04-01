// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Association Syndaxia (Governance)
//
// Dispute mechanics integration tests.
// Covers: dispute_delay validation & enforcement, who can dispute,
//         resolve_dispute splits (60/40, 100/0, 0/100),
//         invalid splits, non-validator attempt, wrong state,
//         expire_deal vs disputed deals, timeout boundary.

import * as anchor from "@coral-xyz/anchor";
import { getAccount } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { setupBase, setupActors, BaseContext } from "../helpers/setup";
import { setupTreasury } from "../helpers/treasury";
import { createTestDeal } from "../helpers/deal";
import { DEAL_AMOUNT, FEE_BPS, RELEASE_DELAY, TIMEOUT, DISPUTE_DELAY, METADATA_HASH } from "../helpers/constants";

describe("dispute mechanics & resolve_dispute", () => {
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

  // ── dispute_delay parameter validation ─────────────────────────────────────

  it("rejects negative dispute_delay", async () => {
    const dealKeypair = Keypair.generate();
    try {
      await ctx.program.methods
        .createDeal(DEAL_AMOUNT, FEE_BPS, RELEASE_DELAY, TIMEOUT, new anchor.BN(-1), METADATA_HASH, [])
        .accounts({
          deal: dealKeypair.publicKey, buyer: buyer.publicKey, seller: seller.publicKey,
          validator: ctx.validator.publicKey, buyerTokenAccount,
          feeCollector: ctx.feeCollector.publicKey,
          feeCollectorTokenAccount: ctx.feeCollectorTokenAccount,
          treasuryTokenAccount, mint: ctx.mint,
        })
        .signers([buyer, dealKeypair]).rpc();
      expect.fail("Should have thrown InvalidDisputeDelay");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.toString()).to.contain("InvalidDisputeDelay");
    }
  });

  it("rejects dispute_delay > 365 days", async () => {
    const dealKeypair = Keypair.generate();
    try {
      await ctx.program.methods
        .createDeal(DEAL_AMOUNT, FEE_BPS, RELEASE_DELAY, TIMEOUT, new anchor.BN(366 * 24 * 3600), METADATA_HASH, [])
        .accounts({
          deal: dealKeypair.publicKey, buyer: buyer.publicKey, seller: seller.publicKey,
          validator: ctx.validator.publicKey, buyerTokenAccount,
          feeCollector: ctx.feeCollector.publicKey,
          feeCollectorTokenAccount: ctx.feeCollectorTokenAccount,
          treasuryTokenAccount, mint: ctx.mint,
        })
        .signers([buyer, dealKeypair]).rpc();
      expect.fail("Should have thrown InvalidDisputeDelay");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.toString()).to.contain("InvalidDisputeDelay");
    }
  });

  it("accepts dispute_delay at exactly 365 days (boundary)", async () => {
    const dealKeypair = Keypair.generate();
    await ctx.program.methods
      .createDeal(DEAL_AMOUNT, FEE_BPS, RELEASE_DELAY, TIMEOUT, new anchor.BN(365 * 24 * 3600), METADATA_HASH, [])
      .accounts({
        deal: dealKeypair.publicKey, buyer: buyer.publicKey, seller: seller.publicKey,
        validator: ctx.validator.publicKey, buyerTokenAccount,
        feeCollector: ctx.feeCollector.publicKey,
        feeCollectorTokenAccount: ctx.feeCollectorTokenAccount,
        treasuryTokenAccount, mint: ctx.mint,
      })
      .signers([buyer, dealKeypair]).rpc();

    const deal = await ctx.program.account.deal.fetch(dealKeypair.publicKey);
    expect(deal.disputeDelay.toNumber()).to.equal(365 * 24 * 3600);
  });

  // ── dispute_delay enforcement ───────────────────────────────────────────────

  it("dispute_delay = 0 allows instant dispute", async () => {
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
      disputeDelay: new anchor.BN(0),
    });

    await ctx.program.methods
      .dispute()
      .accounts({ deal: dealKeypair.publicKey, authority: buyer.publicKey })
      .signers([buyer]).rpc();

    const deal = await ctx.program.account.deal.fetch(dealKeypair.publicKey);
    expect(JSON.stringify(deal.status)).to.equal(JSON.stringify({ disputed: {} }));
  });

  it("rejects dispute before cooling period has elapsed", async () => {
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
      disputeDelay: new anchor.BN(999_999),
    });

    try {
      await ctx.program.methods
        .dispute()
        .accounts({ deal: dealKeypair.publicKey, authority: buyer.publicKey })
        .signers([buyer]).rpc();
      expect.fail("Should have thrown DisputeTooEarly");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.toString()).to.contain("DisputeTooEarly");
    }
  });

  // ── Who can dispute ─────────────────────────────────────────────────────────

  it("seller (beneficiary) can open dispute", async () => {
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
      disputeDelay: new anchor.BN(0),
    });

    await ctx.program.methods
      .dispute()
      .accounts({ deal: dealKeypair.publicKey, authority: seller.publicKey })
      .signers([seller]).rpc();

    const deal = await ctx.program.account.deal.fetch(dealKeypair.publicKey);
    expect(JSON.stringify(deal.status)).to.equal(JSON.stringify({ disputed: {} }));
  });

  it("unauthorized party cannot open dispute", async () => {
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
      disputeDelay: new anchor.BN(0),
    });

    const hacker = Keypair.generate();
    const sig = await ctx.provider.connection.requestAirdrop(hacker.publicKey, anchor.web3.LAMPORTS_PER_SOL);
    await ctx.provider.connection.confirmTransaction(sig);

    try {
      await ctx.program.methods
        .dispute()
        .accounts({ deal: dealKeypair.publicKey, authority: hacker.publicKey })
        .signers([hacker]).rpc();
      expect.fail("Should have thrown Unauthorized");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.toString()).to.contain("Unauthorized");
    }
  });

  // ── resolve_dispute ─────────────────────────────────────────────────────────

  it("validator resolves dispute with 60/40 split", async () => {
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
      disputeDelay: new anchor.BN(0),
    });

    await ctx.program.methods
      .dispute()
      .accounts({ deal: dealKeypair.publicKey, authority: buyer.publicKey })
      .signers([buyer]).rpc();

    const sellerBefore = await getAccount(ctx.provider.connection, sellerTokenAccount);
    const buyerBefore = await getAccount(ctx.provider.connection, buyerTokenAccount);

    // buyer gets 400k back, seller gets 600k
    await ctx.program.methods
      .resolveDispute(new anchor.BN(400_000), new anchor.BN(600_000))
      .accounts({
        deal: dealKeypair.publicKey,
        authority: ctx.validator.publicKey,
        beneficiaryTokenAccount: sellerTokenAccount,
        buyerTokenAccount,
        rentReceiver: buyer.publicKey,
      })
      .signers([ctx.validator]).rpc();

    const deal = await ctx.program.account.deal.fetch(dealKeypair.publicKey);
    expect(JSON.stringify(deal.status)).to.equal(JSON.stringify({ released: {} }));

    const sellerAfter = await getAccount(ctx.provider.connection, sellerTokenAccount);
    const buyerAfter = await getAccount(ctx.provider.connection, buyerTokenAccount);
    expect(Number(sellerAfter.amount) - Number(sellerBefore.amount)).to.equal(600_000);
    expect(Number(buyerAfter.amount) - Number(buyerBefore.amount)).to.equal(400_000);
  });

  it("validator resolves dispute 100% to buyer (full refund)", async () => {
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
      disputeDelay: new anchor.BN(0),
    });

    await ctx.program.methods
      .dispute()
      .accounts({ deal: dealKeypair.publicKey, authority: buyer.publicKey })
      .signers([buyer]).rpc();

    const buyerBefore = await getAccount(ctx.provider.connection, buyerTokenAccount);

    await ctx.program.methods
      .resolveDispute(DEAL_AMOUNT, new anchor.BN(0))
      .accounts({
        deal: dealKeypair.publicKey,
        authority: ctx.validator.publicKey,
        beneficiaryTokenAccount: sellerTokenAccount,
        buyerTokenAccount,
        rentReceiver: buyer.publicKey,
      })
      .signers([ctx.validator]).rpc();

    const buyerAfter = await getAccount(ctx.provider.connection, buyerTokenAccount);
    expect(Number(buyerAfter.amount) - Number(buyerBefore.amount)).to.equal(1_000_000);
  });

  it("validator resolves dispute 100% to seller", async () => {
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
      disputeDelay: new anchor.BN(0),
    });

    await ctx.program.methods
      .dispute()
      .accounts({ deal: dealKeypair.publicKey, authority: buyer.publicKey })
      .signers([buyer]).rpc();

    const sellerBefore = await getAccount(ctx.provider.connection, sellerTokenAccount);

    await ctx.program.methods
      .resolveDispute(new anchor.BN(0), DEAL_AMOUNT)
      .accounts({
        deal: dealKeypair.publicKey,
        authority: ctx.validator.publicKey,
        beneficiaryTokenAccount: sellerTokenAccount,
        buyerTokenAccount,
        rentReceiver: buyer.publicKey,
      })
      .signers([ctx.validator]).rpc();

    const sellerAfter = await getAccount(ctx.provider.connection, sellerTokenAccount);
    expect(Number(sellerAfter.amount) - Number(sellerBefore.amount)).to.equal(1_000_000);
  });

  it("rejects resolve_dispute with invalid split (sum != deal amount)", async () => {
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
      disputeDelay: new anchor.BN(0),
    });

    await ctx.program.methods
      .dispute()
      .accounts({ deal: dealKeypair.publicKey, authority: buyer.publicKey })
      .signers([buyer]).rpc();

    try {
      await ctx.program.methods
        .resolveDispute(new anchor.BN(500_000), new anchor.BN(600_000)) // 1.1M ≠ 1M
        .accounts({
          deal: dealKeypair.publicKey,
          authority: ctx.validator.publicKey,
          beneficiaryTokenAccount: sellerTokenAccount,
          buyerTokenAccount,
          rentReceiver: buyer.publicKey,
        })
        .signers([ctx.validator]).rpc();
      expect.fail("Should have thrown InvalidSplit");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.toString()).to.contain("InvalidSplit");
    }
  });

  it("non-validator cannot resolve dispute", async () => {
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
      disputeDelay: new anchor.BN(0),
    });

    await ctx.program.methods
      .dispute()
      .accounts({ deal: dealKeypair.publicKey, authority: buyer.publicKey })
      .signers([buyer]).rpc();

    try {
      await ctx.program.methods
        .resolveDispute(new anchor.BN(500_000), new anchor.BN(500_000))
        .accounts({
          deal: dealKeypair.publicKey,
          authority: buyer.publicKey,
          beneficiaryTokenAccount: sellerTokenAccount,
          buyerTokenAccount,
          rentReceiver: buyer.publicKey,
        })
        .signers([buyer]).rpc();
      expect.fail("Should have thrown Unauthorized");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.toString()).to.contain("Unauthorized");
    }
  });

  it("cannot resolve a non-disputed deal (Open state)", async () => {
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
    });

    try {
      await ctx.program.methods
        .resolveDispute(new anchor.BN(500_000), new anchor.BN(500_000))
        .accounts({
          deal: dealKeypair.publicKey,
          authority: ctx.validator.publicKey,
          beneficiaryTokenAccount: sellerTokenAccount,
          buyerTokenAccount,
          rentReceiver: buyer.publicKey,
        })
        .signers([ctx.validator]).rpc();
      expect.fail("Should have thrown NotDisputed");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.toString()).to.contain("NotDisputed");
    }
  });

  // ── expire_deal ─────────────────────────────────────────────────────────────

  it("expire_deal rejects disputed deals (must go through validator)", async () => {
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
      disputeDelay: new anchor.BN(0),
    });

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
      expect.fail("Should have rejected: disputed deals cannot expire");
    } catch (err: any) {
      const s = err.error?.errorCode?.code || err.toString();
      expect(s).to.satisfy((v: string) => v.includes("NotEligible") || v.includes("DealNotExpired"));
    }
  });

  // ── timeout boundary ────────────────────────────────────────────────────────

  it("accepts timeout at exactly 1 hour (boundary)", async () => {
    const dealKeypair = Keypair.generate();
    await ctx.program.methods
      .createDeal(DEAL_AMOUNT, FEE_BPS, RELEASE_DELAY, new anchor.BN(3600), DISPUTE_DELAY, METADATA_HASH, [])
      .accounts({
        deal: dealKeypair.publicKey, buyer: buyer.publicKey, seller: seller.publicKey,
        validator: ctx.validator.publicKey, buyerTokenAccount,
        feeCollector: ctx.feeCollector.publicKey,
        feeCollectorTokenAccount: ctx.feeCollectorTokenAccount,
        treasuryTokenAccount, mint: ctx.mint,
      })
      .signers([buyer, dealKeypair]).rpc();

    const deal = await ctx.program.account.deal.fetch(dealKeypair.publicKey);
    expect(deal.timeout.toNumber()).to.equal(3600);
  });

  it("rejects timeout < 1 hour", async () => {
    const dealKeypair = Keypair.generate();
    try {
      await ctx.program.methods
        .createDeal(DEAL_AMOUNT, FEE_BPS, RELEASE_DELAY, new anchor.BN(1800), DISPUTE_DELAY, METADATA_HASH, [])
        .accounts({
          deal: dealKeypair.publicKey, buyer: buyer.publicKey, seller: seller.publicKey,
          validator: ctx.validator.publicKey, buyerTokenAccount,
          feeCollector: ctx.feeCollector.publicKey,
          feeCollectorTokenAccount: ctx.feeCollectorTokenAccount,
          treasuryTokenAccount, mint: ctx.mint,
        })
        .signers([buyer, dealKeypair]).rpc();
      expect.fail("Should have thrown InvalidTimeout");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.toString()).to.contain("InvalidTimeout");
    }
  });
});
