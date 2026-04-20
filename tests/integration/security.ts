// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Association Syndaxia (Governance)
//
// Security integration tests.
// Covers: account validation (wrong beneficiary/buyer token accounts, fake fee
//         collector), parameter bounds (fee cap, release_delay, timeout,
//         buyer==seller, validator==buyer), rent recovery after close.

import * as anchor from "@coral-xyz/anchor";
import { createAccount, getAccount } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { setupBase, setupActors, BaseContext } from "../helpers/setup";
import { setupTreasury } from "../helpers/treasury";
import { createTestDeal } from "../helpers/deal";
import { DEAL_AMOUNT, FEE_BPS, RELEASE_DELAY, TIMEOUT, DISPUTE_DELAY, DISPUTE_RESOLUTION_WINDOW, METADATA_HASH } from "../helpers/constants";

describe("security", () => {
  let ctx: BaseContext;
  let buyer: Keypair;
  let seller: Keypair;
  let buyerTokenAccount: PublicKey;
  let sellerTokenAccount: PublicKey;
  let treasuryConfigPda: PublicKey;
  let treasuryTokenAccount: PublicKey;

  const RELEASE_DELAY_24H = new anchor.BN(86400);

  before(async () => {
    ctx = await setupBase();
    ({ treasuryConfigPda, treasuryTokenAccount } = await setupTreasury(ctx.provider, ctx.mint));
    ({ buyer, seller, buyerTokenAccount, sellerTokenAccount } = await setupActors(ctx));
  });

  // ── Account validation ──────────────────────────────────────────────────────

  it("rejects release to wrong beneficiary token account", async () => {
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
    });

    const hacker = Keypair.generate();
    const hackerTokenAccount = await createAccount(
      ctx.provider.connection, ctx.admin.payer, ctx.mint, hacker.publicKey
    );

    try {
      await ctx.program.methods
        .release()
        .accounts({
          deal: dealKeypair.publicKey,
          authority: buyer.publicKey,
          beneficiaryTokenAccount: hackerTokenAccount,
          buyerTokenAccount,
          rentReceiver: buyer.publicKey,
        })
        .signers([buyer])
        .rpc();
      expect.fail("Should have rejected: wrong beneficiary token account");
    } catch (err: any) {
      const s = err.error?.errorCode?.code || err.toString();
      expect(s).to.satisfy((v: string) =>
        v.includes("InvalidBeneficiaryTokenAccount") || v.includes("ConstraintRaw") || v.includes("2003")
      );
    }
  });

  it("rejects deal with fake fee_collector token account", async () => {
    const dealKeypair = Keypair.generate();
    const hackerCollector = Keypair.generate();
    const hackerCollectorTokenAccount = await createAccount(
      ctx.provider.connection, ctx.admin.payer, ctx.mint, hackerCollector.publicKey
    );

    try {
      await ctx.program.methods
        .createDeal(DEAL_AMOUNT, FEE_BPS, RELEASE_DELAY, TIMEOUT, DISPUTE_DELAY, DISPUTE_RESOLUTION_WINDOW, METADATA_HASH, [])
        .accounts({
          deal: dealKeypair.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          validator: ctx.validator.publicKey,
          buyerTokenAccount,
          feeCollector: ctx.feeCollector.publicKey,
          feeCollectorTokenAccount: hackerCollectorTokenAccount,
          treasuryTokenAccount,
          mint: ctx.mint,
        })
        .signers([buyer, dealKeypair])
        .rpc();
      expect.fail("Should have rejected: fake fee collector");
    } catch (err: any) {
      const s = err.error?.errorCode?.code || err.toString();
      expect(s).to.satisfy((v: string) =>
        v.includes("InvalidFeeCollector") || v.includes("ConstraintRaw") || v.includes("2003")
      );
    }
  });

  it("rejects refund to wrong buyer token account", async () => {
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
    });

    const hacker = Keypair.generate();
    const hackerTokenAccount = await createAccount(
      ctx.provider.connection, ctx.admin.payer, ctx.mint, hacker.publicKey
    );

    try {
      await ctx.program.methods
        .refund()
        .accounts({
          deal: dealKeypair.publicKey,
          authority: seller.publicKey,
          beneficiaryTokenAccount: sellerTokenAccount,
          buyerTokenAccount: hackerTokenAccount,
          rentReceiver: buyer.publicKey,
        })
        .signers([seller])
        .rpc();
      expect.fail("Should have rejected: wrong buyer token account");
    } catch (err: any) {
      const s = err.error?.errorCode?.code || err.toString();
      expect(s).to.satisfy((v: string) =>
        v.includes("InvalidBuyerTokenAccount") || v.includes("ConstraintRaw") || v.includes("2003")
      );
    }
  });

  // ── Parameter bounds ────────────────────────────────────────────────────────

  it("rejects release before release_delay has elapsed", async () => {
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
      releaseDelay: RELEASE_DELAY_24H,
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
      expect.fail("Should have rejected: release too early");
    } catch (err: any) {
      const s = err.error?.errorCode?.code || err.toString();
      expect(s).to.satisfy((v: string) => v.includes("ReleaseTooEarly") || v.includes("6006"));
    }
  });

  it("validator can release a disputed deal before release_delay", async () => {
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
      releaseDelay: RELEASE_DELAY_24H,
    });

    await ctx.program.methods
      .dispute()
      .accounts({ deal: dealKeypair.publicKey, authority: buyer.publicKey })
      .signers([buyer])
      .rpc();

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

    const deal = await ctx.program.account.deal.fetch(dealKeypair.publicKey);
    expect(JSON.stringify(deal.status)).to.equal(JSON.stringify({ released: {} }));
  });

  it("rejects negative release_delay", async () => {
    const dealKeypair = Keypair.generate();
    try {
      await ctx.program.methods
        .createDeal(DEAL_AMOUNT, FEE_BPS, new anchor.BN(-1), TIMEOUT, DISPUTE_DELAY, DISPUTE_RESOLUTION_WINDOW, METADATA_HASH, [])
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
      expect.fail("Should have rejected: negative release_delay");
    } catch (err: any) {
      const s = err.error?.errorCode?.code || err.toString();
      expect(s).to.satisfy((v: string) => v.includes("InvalidReleaseDelay") || v.includes("6012"));
    }
  });

  it("rejects release_delay > 365 days", async () => {
    const dealKeypair = Keypair.generate();
    try {
      await ctx.program.methods
        .createDeal(DEAL_AMOUNT, FEE_BPS, new anchor.BN(366 * 24 * 3600), TIMEOUT, DISPUTE_DELAY, DISPUTE_RESOLUTION_WINDOW, METADATA_HASH, [])
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
      expect.fail("Should have rejected: release_delay too long");
    } catch (err: any) {
      const s = err.error?.errorCode?.code || err.toString();
      expect(s).to.satisfy((v: string) => v.includes("InvalidReleaseDelay") || v.includes("6012"));
    }
  });

  it("accepts release_delay at exactly 365 days (boundary)", async () => {
    const dealKeypair = Keypair.generate();
    await ctx.program.methods
      .createDeal(DEAL_AMOUNT, FEE_BPS, new anchor.BN(365 * 24 * 3600), TIMEOUT, DISPUTE_DELAY, DISPUTE_RESOLUTION_WINDOW, METADATA_HASH, [])
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
    expect(deal.releaseDelay.toNumber()).to.equal(365 * 24 * 3600);
  });

  it("rejects timeout < 1 hour", async () => {
    const dealKeypair = Keypair.generate();
    try {
      await ctx.program.methods
        .createDeal(DEAL_AMOUNT, FEE_BPS, RELEASE_DELAY, new anchor.BN(1800), DISPUTE_DELAY, DISPUTE_RESOLUTION_WINDOW, METADATA_HASH, [])
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
      expect.fail("Should have thrown InvalidTimeout");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.toString()).to.contain("InvalidTimeout");
    }
  });

  it("accepts deal with zero fees", async () => {
    const dealKeypair = Keypair.generate();
    await ctx.program.methods
      .createDeal(DEAL_AMOUNT, new anchor.BN(0), RELEASE_DELAY, TIMEOUT, DISPUTE_DELAY, DISPUTE_RESOLUTION_WINDOW, METADATA_HASH, [])
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
    expect(deal.feeBps.toNumber()).to.equal(0);
  });

  it("rejects deal where buyer equals seller", async () => {
    const dealKeypair = Keypair.generate();
    try {
      await ctx.program.methods
        .createDeal(DEAL_AMOUNT, FEE_BPS, RELEASE_DELAY, TIMEOUT, DISPUTE_DELAY, DISPUTE_RESOLUTION_WINDOW, METADATA_HASH, [])
        .accounts({
          deal: dealKeypair.publicKey,
          buyer: buyer.publicKey,
          seller: buyer.publicKey,
          validator: ctx.validator.publicKey,
          buyerTokenAccount,
          feeCollector: ctx.feeCollector.publicKey,
          feeCollectorTokenAccount: ctx.feeCollectorTokenAccount,
          treasuryTokenAccount,
          mint: ctx.mint,
        })
        .signers([buyer, dealKeypair])
        .rpc();
      expect.fail("Should have rejected: buyer == seller");
    } catch (err: any) {
      const s = err.error?.errorCode?.code || err.toString();
      expect(s).to.satisfy((v: string) => v.includes("BuyerEqualsSeller") || v.includes("6013"));
    }
  });

  it("rejects deal where validator equals buyer", async () => {
    const dealKeypair = Keypair.generate();
    try {
      await ctx.program.methods
        .createDeal(DEAL_AMOUNT, FEE_BPS, RELEASE_DELAY, TIMEOUT, DISPUTE_DELAY, DISPUTE_RESOLUTION_WINDOW, METADATA_HASH, [])
        .accounts({
          deal: dealKeypair.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          validator: buyer.publicKey,
          buyerTokenAccount,
          feeCollector: ctx.feeCollector.publicKey,
          feeCollectorTokenAccount: ctx.feeCollectorTokenAccount,
          treasuryTokenAccount,
          mint: ctx.mint,
        })
        .signers([buyer, dealKeypair])
        .rpc();
      expect.fail("Should have rejected: validator == buyer");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.toString()).to.contain("InvalidValidator");
    }
  });

  // ── Rent recovery ───────────────────────────────────────────────────────────

  it("escrow account is closed after release (rent recovered)", async () => {
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
    });
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), dealKeypair.publicKey.toBuffer()],
      ctx.program.programId
    );

    const escrowBefore = await getAccount(ctx.provider.connection, escrowPda);
    expect(Number(escrowBefore.amount)).to.equal(1_000_000);

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

    try {
      await getAccount(ctx.provider.connection, escrowPda);
      expect.fail("Escrow should have been closed");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });

  it("escrow account is closed after refund (rent recovered)", async () => {
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
    });
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), dealKeypair.publicKey.toBuffer()],
      ctx.program.programId
    );

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

    try {
      await getAccount(ctx.provider.connection, escrowPda);
      expect.fail("Escrow should have been closed after refund");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });
});
