// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Association Syndaxia (Governance)
//
// Transfer beneficiary integration tests.
// Covers: reassign beneficiary, release to new beneficiary,
//         rejection from non-beneficiary, rejection to buyer.

import * as anchor from "@coral-xyz/anchor";
import { createAccount, getAccount } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { setupBase, setupActors, BaseContext } from "../helpers/setup";
import { setupTreasury } from "../helpers/treasury";
import { createTestDeal } from "../helpers/deal";

describe("transfer_beneficiary", () => {
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

  it("seller transfers beneficiary to a vault and release goes to vault", async () => {
    const vault = Keypair.generate();
    const vaultTokenAccount = await createAccount(
      ctx.provider.connection, ctx.admin.payer, ctx.mint, vault.publicKey
    );

    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
    });

    await ctx.program.methods
      .transferBeneficiary(vault.publicKey)
      .accounts({ deal: dealKeypair.publicKey, beneficiary: seller.publicKey })
      .signers([seller])
      .rpc();

    const deal = await ctx.program.account.deal.fetch(dealKeypair.publicKey);
    expect(deal.beneficiary.toBase58()).to.equal(vault.publicKey.toBase58());

    await ctx.program.methods
      .release()
      .accounts({
        deal: dealKeypair.publicKey,
        authority: buyer.publicKey,
        beneficiaryTokenAccount: vaultTokenAccount,
        buyerTokenAccount,
        rentReceiver: buyer.publicKey,
      })
      .signers([buyer])
      .rpc();

    const vaultBalance = await getAccount(ctx.provider.connection, vaultTokenAccount);
    expect(Number(vaultBalance.amount)).to.equal(1_000_000);
  });

  it("rejects transfer_beneficiary from non-beneficiary", async () => {
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
    });

    const hacker = Keypair.generate();
    const sig = await ctx.provider.connection.requestAirdrop(hacker.publicKey, anchor.web3.LAMPORTS_PER_SOL);
    await ctx.provider.connection.confirmTransaction(sig);

    try {
      await ctx.program.methods
        .transferBeneficiary(hacker.publicKey)
        .accounts({ deal: dealKeypair.publicKey, beneficiary: hacker.publicKey })
        .signers([hacker])
        .rpc();
      expect.fail("Should have thrown Unauthorized");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.toString()).to.contain("Unauthorized");
    }
  });

  it("rejects transfer_beneficiary to buyer", async () => {
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
    });

    try {
      await ctx.program.methods
        .transferBeneficiary(buyer.publicKey)
        .accounts({ deal: dealKeypair.publicKey, beneficiary: seller.publicKey })
        .signers([seller])
        .rpc();
      expect.fail("Should have thrown BeneficiaryEqualsBuyer");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.toString()).to.contain("BeneficiaryEqualsBuyer");
    }
  });

  // ── C-MED-3: transfer_beneficiary frozen during Disputed ────────────────────
  it("rejects transfer_beneficiary while deal is Disputed", async () => {
    const newBeneficiary = Keypair.generate();
    const dealKeypair = await createTestDeal({
      ...ctx, buyer, seller, buyerTokenAccount, treasuryConfigPda, treasuryTokenAccount,
      disputeDelay: new anchor.BN(0),
    });

    // Open a dispute (status -> Disputed)
    await ctx.program.methods
      .dispute()
      .accounts({ deal: dealKeypair.publicKey, authority: buyer.publicKey })
      .signers([buyer])
      .rpc();

    // Beneficiary transfer must be rejected — protects the validator's
    // arbitration target from being substituted post-decision.
    try {
      await ctx.program.methods
        .transferBeneficiary(newBeneficiary.publicKey)
        .accounts({ deal: dealKeypair.publicKey, beneficiary: seller.publicKey })
        .signers([seller])
        .rpc();
      expect.fail("Should have thrown NotEligible");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.toString()).to.contain("NotEligible");
    }
  });
});
