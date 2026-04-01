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

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SyndaxiaCore } from "../target/types/syndaxia_core";
import { SyndaxiaTreasury } from "../target/types/syndaxia_treasury";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

describe("syndaxia-core (immutable)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SyndaxiaCore as Program<SyndaxiaCore>;
  const admin = provider.wallet as anchor.Wallet;

  let mint: PublicKey;
  let feeCollector: Keypair;
  let feeCollectorTokenAccount: PublicKey;
  let validator: Keypair;

  // Treasury accounts shared across all createDeal calls
  let treasuryProgram: Program<SyndaxiaTreasury>;
  let treasuryConfigPda: PublicKey;
  let treasuryTokenAccount: PublicKey;

  const FEE_BPS = new anchor.BN(500); // 5%
  const DEAL_AMOUNT = new anchor.BN(1_000_000);
  const RELEASE_DELAY = new anchor.BN(0);
  const TIMEOUT = new anchor.BN(30 * 24 * 3600); // 30 days
  const DISPUTE_DELAY = new anchor.BN(0);
  const METADATA_HASH = new Array(32).fill(0xAB);

  before(async () => {
    feeCollector = Keypair.generate();
    validator = Keypair.generate();

    const airdropSig = await provider.connection.requestAirdrop(
      admin.publicKey,
      10 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig);

    mint = await createMint(
      provider.connection,
      admin.payer,
      admin.publicKey,
      null,
      6
    );

    feeCollectorTokenAccount = await createAccount(
      provider.connection,
      admin.payer,
      mint,
      feeCollector.publicKey
    );

    // ── Treasury setup ────────────────────────────────────────────────────────
    // syndaxia-treasury.ts runs first (explicit ordering in Anchor.toml) and
    // initialises the singleton TreasuryConfig PDA.  If the core tests are ever
    // run in isolation the try-catch will initialise the treasury on the spot.
    const TREASURY_PROGRAM_ID = new PublicKey(
      "D8H3JetPqdFasLXGbAqjhrrArfoYmy8PwQtt8KehZLxd"
    );
    treasuryProgram = anchor.workspace.SyndaxiaTreasury as Program<SyndaxiaTreasury>;
    [treasuryConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury-config")],
      TREASURY_PROGRAM_ID
    );

    let treasuryFeeReceiver: PublicKey;
    try {
      const config = await treasuryProgram.account.treasuryConfig.fetch(
        treasuryConfigPda
      );
      treasuryFeeReceiver = config.feeReceiver;
    } catch (_) {
      // Treasury not yet initialised — happens when running core tests standalone.
      const tempMultisig = Keypair.generate();
      const tempFeeReceiver = Keypair.generate();
      for (const kp of [tempMultisig, tempFeeReceiver]) {
        const sig = await provider.connection.requestAirdrop(
          kp.publicKey,
          2 * anchor.web3.LAMPORTS_PER_SOL
        );
        await provider.connection.confirmTransaction(sig);
      }
      await treasuryProgram.methods
        .initialize(tempFeeReceiver.publicKey)
        .accounts({ multisig: tempMultisig.publicKey })
        .signers([tempMultisig])
        .rpc();
      treasuryFeeReceiver = tempFeeReceiver.publicKey;
    }

    // Token account with the deal mint, owned by treasury's fee_receiver.
    // The Core program validates: treasury_token_account.owner == config.fee_receiver.
    treasuryTokenAccount = await createAccount(
      provider.connection,
      admin.payer,
      mint,
      treasuryFeeReceiver
    );
  });

  // ============================================================
  // Helper: create a deal with default params
  // ============================================================
  async function createTestDeal(opts: {
    buyer: Keypair;
    seller: Keypair;
    buyerTokenAccount: PublicKey;
    sellerTokenAccount: PublicKey;
    releaseDelay?: anchor.BN;
    timeout?: anchor.BN;
    disputeDelay?: anchor.BN;
    feeBps?: anchor.BN;
    milestoneAmounts?: anchor.BN[];
  }): Promise<Keypair> {
    const dealKeypair = Keypair.generate();
    const milestones = opts.milestoneAmounts || [];

    await program.methods
      .createDeal(
        DEAL_AMOUNT,
        opts.feeBps || FEE_BPS,
        opts.releaseDelay || RELEASE_DELAY,
        opts.timeout || TIMEOUT,
        opts.disputeDelay ?? DISPUTE_DELAY,
        METADATA_HASH,
        milestones
      )
      .accounts({
        deal: dealKeypair.publicKey,
        buyer: opts.buyer.publicKey,
        seller: opts.seller.publicKey,
        validator: validator.publicKey,
        buyerTokenAccount: opts.buyerTokenAccount,
        feeCollector: feeCollector.publicKey,
        feeCollectorTokenAccount: feeCollectorTokenAccount,
        treasuryTokenAccount: treasuryTokenAccount,
        mint: mint,
      })
      .signers([opts.buyer, dealKeypair])
      .rpc();
    return dealKeypair;
  }

  // ============================================================
  // 1. DEAL LIFECYCLE (no milestones)
  // ============================================================
  describe("deal lifecycle", () => {
    let buyer: Keypair;
    let seller: Keypair;
    let buyerTokenAccount: PublicKey;
    let sellerTokenAccount: PublicKey;

    before(async () => {
      buyer = Keypair.generate();
      seller = Keypair.generate();

      for (const kp of [buyer, seller, validator]) {
        const sig = await provider.connection.requestAirdrop(
          kp.publicKey,
          5 * anchor.web3.LAMPORTS_PER_SOL
        );
        await provider.connection.confirmTransaction(sig);
      }

      buyerTokenAccount = await createAccount(
        provider.connection,
        admin.payer,
        mint,
        buyer.publicKey
      );
      sellerTokenAccount = await createAccount(
        provider.connection,
        admin.payer,
        mint,
        seller.publicKey
      );

      await mintTo(
        provider.connection,
        admin.payer,
        mint,
        buyerTokenAccount,
        admin.publicKey,
        50_000_000
      );
    });

    it("creates a deal and escrows funds", async () => {
      const dealKeypair = Keypair.generate();
      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), dealKeypair.publicKey.toBuffer()],
        program.programId
      );

      const buyerBefore = await getAccount(provider.connection, buyerTokenAccount);

      await program.methods
        .createDeal(
          DEAL_AMOUNT,
          FEE_BPS,
          RELEASE_DELAY,
          TIMEOUT,
          DISPUTE_DELAY,
          METADATA_HASH,
          []
        )
        .accounts({
          deal: dealKeypair.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          validator: validator.publicKey,
          buyerTokenAccount: buyerTokenAccount,
          feeCollector: feeCollector.publicKey,
          feeCollectorTokenAccount: feeCollectorTokenAccount,
          treasuryTokenAccount: treasuryTokenAccount,
          mint: mint,
        })
        .signers([buyer, dealKeypair])
        .rpc();

      // Verify deal state
      const deal = await program.account.deal.fetch(dealKeypair.publicKey);
      expect(deal.amount.toNumber()).to.equal(1_000_000);
      expect(deal.buyer.toBase58()).to.equal(buyer.publicKey.toBase58());
      expect(deal.seller.toBase58()).to.equal(seller.publicKey.toBase58());
      expect(deal.validator.toBase58()).to.equal(validator.publicKey.toBase58());
      expect(deal.beneficiary.toBase58()).to.equal(seller.publicKey.toBase58());
      expect(deal.feeBps.toNumber()).to.equal(500);
      expect(deal.milestoneCount).to.equal(0);
      expect(JSON.stringify(deal.status)).to.equal(JSON.stringify({ open: {} }));

      // Verify escrow balance
      const escrow = await getAccount(provider.connection, escrowPda);
      expect(Number(escrow.amount)).to.equal(1_000_000);

      // Verify fees collected (5% = 50,000)
      const feeAccount = await getAccount(provider.connection, feeCollectorTokenAccount);
      expect(Number(feeAccount.amount)).to.equal(50_000);

      // Verify buyer balance decreased by amount + fees + protocol fee
      // deal fee (5% of 1M = 50,000) + protocol fee (5 BPS of 1M = 500)
      const buyerAfter = await getAccount(provider.connection, buyerTokenAccount);
      expect(Number(buyerBefore.amount) - Number(buyerAfter.amount)).to.equal(1_050_500);
    });

    it("rejects deal with zero amount", async () => {
      const dealKeypair = Keypair.generate();

      try {
        await program.methods
          .createDeal(new anchor.BN(0), FEE_BPS, RELEASE_DELAY, TIMEOUT, DISPUTE_DELAY, METADATA_HASH, [])
          .accounts({
            deal: dealKeypair.publicKey,
            buyer: buyer.publicKey,
            seller: seller.publicKey,
            validator: validator.publicKey,
            buyerTokenAccount: buyerTokenAccount,
            feeCollector: feeCollector.publicKey,
            feeCollectorTokenAccount: feeCollectorTokenAccount,
            treasuryTokenAccount: treasuryTokenAccount,
            mint: mint,
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
        await program.methods
          .createDeal(DEAL_AMOUNT, new anchor.BN(1001), RELEASE_DELAY, TIMEOUT, DISPUTE_DELAY, METADATA_HASH, [])
          .accounts({
            deal: dealKeypair.publicKey,
            buyer: buyer.publicKey,
            seller: seller.publicKey,
            validator: validator.publicKey,
            buyerTokenAccount: buyerTokenAccount,
            feeCollector: feeCollector.publicKey,
            feeCollectorTokenAccount: feeCollectorTokenAccount,
            treasuryTokenAccount: treasuryTokenAccount,
            mint: mint,
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
        buyer,
        seller,
        buyerTokenAccount,
        sellerTokenAccount,
      });

      const sellerBefore = await getAccount(provider.connection, sellerTokenAccount);

      await program.methods
        .release()
        .accounts({
          deal: dealKeypair.publicKey,
          authority: buyer.publicKey,
          beneficiaryTokenAccount: sellerTokenAccount,
          buyerTokenAccount: buyerTokenAccount,
          rentReceiver: buyer.publicKey,
        })
        .signers([buyer])
        .rpc();

      const deal = await program.account.deal.fetch(dealKeypair.publicKey);
      expect(JSON.stringify(deal.status)).to.equal(JSON.stringify({ released: {} }));

      const sellerAfter = await getAccount(provider.connection, sellerTokenAccount);
      expect(Number(sellerAfter.amount) - Number(sellerBefore.amount)).to.equal(1_000_000);
    });

    it("seller refunds buyer on a new deal", async () => {
      const dealKeypair = await createTestDeal({
        buyer,
        seller,
        buyerTokenAccount,
        sellerTokenAccount,
      });

      const buyerBefore = await getAccount(provider.connection, buyerTokenAccount);

      await program.methods
        .refund()
        .accounts({
          deal: dealKeypair.publicKey,
          authority: seller.publicKey,
          beneficiaryTokenAccount: sellerTokenAccount,
          buyerTokenAccount: buyerTokenAccount,
          rentReceiver: buyer.publicKey,
        })
        .signers([seller])
        .rpc();

      const deal = await program.account.deal.fetch(dealKeypair.publicKey);
      expect(JSON.stringify(deal.status)).to.equal(JSON.stringify({ refunded: {} }));

      const buyerAfter = await getAccount(provider.connection, buyerTokenAccount);
      expect(Number(buyerAfter.amount) - Number(buyerBefore.amount)).to.equal(1_000_000);
    });

    it("buyer can dispute and validator releases", async () => {
      const dealKeypair = await createTestDeal({
        buyer,
        seller,
        buyerTokenAccount,
        sellerTokenAccount,
      });

      // Dispute
      await program.methods
        .dispute()
        .accounts({
          deal: dealKeypair.publicKey,
          authority: buyer.publicKey,
        })
        .signers([buyer])
        .rpc();

      const dealDisputed = await program.account.deal.fetch(dealKeypair.publicKey);
      expect(JSON.stringify(dealDisputed.status)).to.equal(JSON.stringify({ disputed: {} }));

      // Validator releases
      await program.methods
        .release()
        .accounts({
          deal: dealKeypair.publicKey,
          authority: validator.publicKey,
          beneficiaryTokenAccount: sellerTokenAccount,
          buyerTokenAccount: buyerTokenAccount,
          rentReceiver: buyer.publicKey,
        })
        .signers([validator])
        .rpc();

      const dealAfter = await program.account.deal.fetch(dealKeypair.publicKey);
      expect(JSON.stringify(dealAfter.status)).to.equal(JSON.stringify({ released: {} }));
    });

    it("rejects release from unauthorized party", async () => {
      const dealKeypair = await createTestDeal({
        buyer,
        seller,
        buyerTokenAccount,
        sellerTokenAccount,
      });

      const hacker = Keypair.generate();
      const airdropHacker = await provider.connection.requestAirdrop(
        hacker.publicKey,
        1 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropHacker);

      try {
        await program.methods
          .release()
          .accounts({
            deal: dealKeypair.publicKey,
            authority: hacker.publicKey,
            beneficiaryTokenAccount: sellerTokenAccount,
            buyerTokenAccount: buyerTokenAccount,
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

  // ============================================================
  // 2. MILESTONE DEALS
  // ============================================================
  describe("milestone deals", () => {
    let buyer: Keypair;
    let seller: Keypair;
    let buyerTokenAccount: PublicKey;
    let sellerTokenAccount: PublicKey;

    before(async () => {
      buyer = Keypair.generate();
      seller = Keypair.generate();

      for (const kp of [buyer, seller]) {
        const sig = await provider.connection.requestAirdrop(
          kp.publicKey,
          5 * anchor.web3.LAMPORTS_PER_SOL
        );
        await provider.connection.confirmTransaction(sig);
      }

      buyerTokenAccount = await createAccount(
        provider.connection,
        admin.payer,
        mint,
        buyer.publicKey
      );
      sellerTokenAccount = await createAccount(
        provider.connection,
        admin.payer,
        mint,
        seller.publicKey
      );

      await mintTo(
        provider.connection,
        admin.payer,
        mint,
        buyerTokenAccount,
        admin.publicKey,
        50_000_000
      );
    });

    it("creates a milestone deal with 3 milestones", async () => {
      const dealKeypair = Keypair.generate();
      const milestones = [
        new anchor.BN(400_000),
        new anchor.BN(300_000),
        new anchor.BN(300_000),
      ];

      await program.methods
        .createDeal(DEAL_AMOUNT, FEE_BPS, RELEASE_DELAY, TIMEOUT, DISPUTE_DELAY, METADATA_HASH, milestones)
        .accounts({
          deal: dealKeypair.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          validator: validator.publicKey,
          buyerTokenAccount: buyerTokenAccount,
          feeCollector: feeCollector.publicKey,
          feeCollectorTokenAccount: feeCollectorTokenAccount,
          treasuryTokenAccount: treasuryTokenAccount,
          mint: mint,
        })
        .signers([buyer, dealKeypair])
        .rpc();

      const deal = await program.account.deal.fetch(dealKeypair.publicKey);
      expect(deal.milestoneCount).to.equal(3);
      expect(deal.releasedMask).to.equal(0);
      expect(deal.milestoneAmounts[0].toNumber()).to.equal(400_000);
      expect(deal.milestoneAmounts[1].toNumber()).to.equal(300_000);
      expect(deal.milestoneAmounts[2].toNumber()).to.equal(300_000);
    });

    it("releases milestones one by one", async () => {
      const dealKeypair = Keypair.generate();
      const milestones = [
        new anchor.BN(600_000),
        new anchor.BN(400_000),
      ];

      await program.methods
        .createDeal(DEAL_AMOUNT, FEE_BPS, RELEASE_DELAY, TIMEOUT, DISPUTE_DELAY, METADATA_HASH, milestones)
        .accounts({
          deal: dealKeypair.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          validator: validator.publicKey,
          buyerTokenAccount: buyerTokenAccount,
          feeCollector: feeCollector.publicKey,
          feeCollectorTokenAccount: feeCollectorTokenAccount,
          treasuryTokenAccount: treasuryTokenAccount,
          mint: mint,
        })
        .signers([buyer, dealKeypair])
        .rpc();

      const sellerBefore = await getAccount(provider.connection, sellerTokenAccount);

      // Release milestone 0
      await program.methods
        .releaseMilestone(0)
        .accounts({
          deal: dealKeypair.publicKey,
          authority: buyer.publicKey,
          beneficiaryTokenAccount: sellerTokenAccount,
          buyerTokenAccount: buyerTokenAccount,
          rentReceiver: buyer.publicKey,
        })
        .signers([buyer])
        .rpc();

      let deal = await program.account.deal.fetch(dealKeypair.publicKey);
      expect(deal.releasedMask).to.equal(1); // bit 0
      expect(JSON.stringify(deal.status)).to.equal(JSON.stringify({ open: {} }));

      const sellerMid = await getAccount(provider.connection, sellerTokenAccount);
      expect(Number(sellerMid.amount) - Number(sellerBefore.amount)).to.equal(600_000);

      // Release milestone 1 (final)
      await program.methods
        .releaseMilestone(1)
        .accounts({
          deal: dealKeypair.publicKey,
          authority: buyer.publicKey,
          beneficiaryTokenAccount: sellerTokenAccount,
          buyerTokenAccount: buyerTokenAccount,
          rentReceiver: buyer.publicKey,
        })
        .signers([buyer])
        .rpc();

      deal = await program.account.deal.fetch(dealKeypair.publicKey);
      expect(deal.releasedMask).to.equal(3); // bits 0+1
      expect(JSON.stringify(deal.status)).to.equal(JSON.stringify({ released: {} }));

      const sellerAfter = await getAccount(provider.connection, sellerTokenAccount);
      expect(Number(sellerAfter.amount) - Number(sellerBefore.amount)).to.equal(1_000_000);
    });

    it("rejects release() on a milestone deal (must use release_milestone)", async () => {
      const dealKeypair = await createTestDeal({
        buyer,
        seller,
        buyerTokenAccount,
        sellerTokenAccount,
        milestoneAmounts: [new anchor.BN(500_000), new anchor.BN(500_000)],
      });

      try {
        await program.methods
          .release()
          .accounts({
            deal: dealKeypair.publicKey,
            authority: buyer.publicKey,
            beneficiaryTokenAccount: sellerTokenAccount,
            buyerTokenAccount: buyerTokenAccount,
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
        await program.methods
          .createDeal(
            DEAL_AMOUNT,
            FEE_BPS,
            RELEASE_DELAY,
            TIMEOUT,
            DISPUTE_DELAY,
            METADATA_HASH,
            [new anchor.BN(500_000), new anchor.BN(400_000)] // sum = 900k != 1M
          )
          .accounts({
            deal: dealKeypair.publicKey,
            buyer: buyer.publicKey,
            seller: seller.publicKey,
            validator: validator.publicKey,
            buyerTokenAccount: buyerTokenAccount,
            feeCollector: feeCollector.publicKey,
            feeCollectorTokenAccount: feeCollectorTokenAccount,
            treasuryTokenAccount: treasuryTokenAccount,
            mint: mint,
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
        buyer,
        seller,
        buyerTokenAccount,
        sellerTokenAccount,
        milestoneAmounts: [new anchor.BN(500_000), new anchor.BN(500_000)],
      });

      await program.methods
        .releaseMilestone(0)
        .accounts({
          deal: dealKeypair.publicKey,
          authority: buyer.publicKey,
          beneficiaryTokenAccount: sellerTokenAccount,
          buyerTokenAccount: buyerTokenAccount,
          rentReceiver: buyer.publicKey,
        })
        .signers([buyer])
        .rpc();

      try {
        await program.methods
          .releaseMilestone(0)
          .accounts({
            deal: dealKeypair.publicKey,
            authority: buyer.publicKey,
            beneficiaryTokenAccount: sellerTokenAccount,
            buyerTokenAccount: buyerTokenAccount,
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

  // ============================================================
  // 3. TRANSFER BENEFICIARY
  // ============================================================
  describe("transfer_beneficiary", () => {
    let buyer: Keypair;
    let seller: Keypair;
    let buyerTokenAccount: PublicKey;
    let sellerTokenAccount: PublicKey;

    before(async () => {
      buyer = Keypair.generate();
      seller = Keypair.generate();

      for (const kp of [buyer, seller]) {
        const sig = await provider.connection.requestAirdrop(
          kp.publicKey,
          5 * anchor.web3.LAMPORTS_PER_SOL
        );
        await provider.connection.confirmTransaction(sig);
      }

      buyerTokenAccount = await createAccount(
        provider.connection,
        admin.payer,
        mint,
        buyer.publicKey
      );
      sellerTokenAccount = await createAccount(
        provider.connection,
        admin.payer,
        mint,
        seller.publicKey
      );

      await mintTo(
        provider.connection,
        admin.payer,
        mint,
        buyerTokenAccount,
        admin.publicKey,
        50_000_000
      );
    });

    it("seller transfers beneficiary to a vault", async () => {
      const vault = Keypair.generate();
      const vaultTokenAccount = await createAccount(
        provider.connection,
        admin.payer,
        mint,
        vault.publicKey
      );

      const dealKeypair = await createTestDeal({
        buyer,
        seller,
        buyerTokenAccount,
        sellerTokenAccount,
      });

      // Transfer beneficiary from seller to vault
      await program.methods
        .transferBeneficiary(vault.publicKey)
        .accounts({
          deal: dealKeypair.publicKey,
          beneficiary: seller.publicKey,
        })
        .signers([seller])
        .rpc();

      const deal = await program.account.deal.fetch(dealKeypair.publicKey);
      expect(deal.beneficiary.toBase58()).to.equal(vault.publicKey.toBase58());

      // Now release goes to vault, not seller
      await program.methods
        .release()
        .accounts({
          deal: dealKeypair.publicKey,
          authority: buyer.publicKey,
          beneficiaryTokenAccount: vaultTokenAccount,
          buyerTokenAccount: buyerTokenAccount,
          rentReceiver: buyer.publicKey,
        })
        .signers([buyer])
        .rpc();

      const vaultBalance = await getAccount(provider.connection, vaultTokenAccount);
      expect(Number(vaultBalance.amount)).to.equal(1_000_000);
    });

    it("rejects transfer_beneficiary from non-beneficiary", async () => {
      const dealKeypair = await createTestDeal({
        buyer,
        seller,
        buyerTokenAccount,
        sellerTokenAccount,
      });

      const hacker = Keypair.generate();
      const airdropHacker = await provider.connection.requestAirdrop(
        hacker.publicKey,
        1 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropHacker);

      try {
        await program.methods
          .transferBeneficiary(hacker.publicKey)
          .accounts({
            deal: dealKeypair.publicKey,
            beneficiary: hacker.publicKey,
          })
          .signers([hacker])
          .rpc();
        expect.fail("Should have thrown Unauthorized");
      } catch (err: any) {
        expect(err.error?.errorCode?.code || err.toString()).to.contain("Unauthorized");
      }
    });

    it("rejects transfer_beneficiary to buyer", async () => {
      const dealKeypair = await createTestDeal({
        buyer,
        seller,
        buyerTokenAccount,
        sellerTokenAccount,
      });

      try {
        await program.methods
          .transferBeneficiary(buyer.publicKey)
          .accounts({
            deal: dealKeypair.publicKey,
            beneficiary: seller.publicKey,
          })
          .signers([seller])
          .rpc();
        expect.fail("Should have thrown BeneficiaryEqualsBuyer");
      } catch (err: any) {
        expect(err.error?.errorCode?.code || err.toString()).to.contain("BeneficiaryEqualsBuyer");
      }
    });
  });

  // ============================================================
  // 4. SECURITY TESTS
  // ============================================================
  describe("security", () => {
    let buyer: Keypair;
    let seller: Keypair;
    let buyerTokenAccount: PublicKey;
    let sellerTokenAccount: PublicKey;

    const RELEASE_DELAY_24H = new anchor.BN(86400);

    before(async () => {
      buyer = Keypair.generate();
      seller = Keypair.generate();

      for (const kp of [buyer, seller]) {
        const sig = await provider.connection.requestAirdrop(
          kp.publicKey,
          5 * anchor.web3.LAMPORTS_PER_SOL
        );
        await provider.connection.confirmTransaction(sig);
      }

      buyerTokenAccount = await createAccount(
        provider.connection,
        admin.payer,
        mint,
        buyer.publicKey
      );
      sellerTokenAccount = await createAccount(
        provider.connection,
        admin.payer,
        mint,
        seller.publicKey
      );

      await mintTo(
        provider.connection,
        admin.payer,
        mint,
        buyerTokenAccount,
        admin.publicKey,
        50_000_000
      );
    });

    it("rejects release to wrong beneficiary token account", async () => {
      const dealKeypair = await createTestDeal({
        buyer,
        seller,
        buyerTokenAccount,
        sellerTokenAccount,
      });

      const hacker = Keypair.generate();
      const hackerTokenAccount = await createAccount(
        provider.connection,
        admin.payer,
        mint,
        hacker.publicKey
      );

      try {
        await program.methods
          .release()
          .accounts({
            deal: dealKeypair.publicKey,
            authority: buyer.publicKey,
            beneficiaryTokenAccount: hackerTokenAccount,
            buyerTokenAccount: buyerTokenAccount,
            rentReceiver: buyer.publicKey,
          })
          .signers([buyer])
          .rpc();
        expect.fail("Should have rejected: wrong beneficiary token account");
      } catch (err: any) {
        const errStr = err.error?.errorCode?.code || err.toString();
        expect(errStr).to.satisfy((s: string) =>
          s.includes("InvalidBeneficiaryTokenAccount") || s.includes("ConstraintRaw") || s.includes("2003")
        );
      }
    });

    it("rejects deal with fake fee_collector token account", async () => {
      const dealKeypair = Keypair.generate();
      const hackerCollector = Keypair.generate();
      const hackerCollectorTokenAccount = await createAccount(
        provider.connection,
        admin.payer,
        mint,
        hackerCollector.publicKey
      );

      try {
        await program.methods
          .createDeal(DEAL_AMOUNT, FEE_BPS, RELEASE_DELAY, TIMEOUT, DISPUTE_DELAY, METADATA_HASH, [])
          .accounts({
            deal: dealKeypair.publicKey,
            buyer: buyer.publicKey,
            seller: seller.publicKey,
            validator: validator.publicKey,
            buyerTokenAccount: buyerTokenAccount,
            feeCollector: feeCollector.publicKey,
            feeCollectorTokenAccount: hackerCollectorTokenAccount,
            treasuryTokenAccount: treasuryTokenAccount,
            mint: mint,
          })
          .signers([buyer, dealKeypair])
          .rpc();
        expect.fail("Should have rejected: fake fee collector");
      } catch (err: any) {
        const errStr = err.error?.errorCode?.code || err.toString();
        expect(errStr).to.satisfy((s: string) =>
          s.includes("InvalidFeeCollector") || s.includes("ConstraintRaw") || s.includes("2003")
        );
      }
    });

    it("rejects release before release_delay has elapsed", async () => {
      const dealKeypair = await createTestDeal({
        buyer,
        seller,
        buyerTokenAccount,
        sellerTokenAccount,
        releaseDelay: RELEASE_DELAY_24H,
      });

      try {
        await program.methods
          .release()
          .accounts({
            deal: dealKeypair.publicKey,
            authority: buyer.publicKey,
            beneficiaryTokenAccount: sellerTokenAccount,
            buyerTokenAccount: buyerTokenAccount,
            rentReceiver: buyer.publicKey,
          })
          .signers([buyer])
          .rpc();
        expect.fail("Should have rejected: release too early");
      } catch (err: any) {
        const errStr = err.error?.errorCode?.code || err.toString();
        expect(errStr).to.satisfy((s: string) =>
          s.includes("ReleaseTooEarly") || s.includes("6006")
        );
      }
    });

    it("validator can release a disputed deal before delay", async () => {
      const dealKeypair = await createTestDeal({
        buyer,
        seller,
        buyerTokenAccount,
        sellerTokenAccount,
        releaseDelay: RELEASE_DELAY_24H,
      });

      await program.methods
        .dispute()
        .accounts({
          deal: dealKeypair.publicKey,
          authority: buyer.publicKey,
        })
        .signers([buyer])
        .rpc();

      await program.methods
        .release()
        .accounts({
          deal: dealKeypair.publicKey,
          authority: validator.publicKey,
          beneficiaryTokenAccount: sellerTokenAccount,
          buyerTokenAccount: buyerTokenAccount,
          rentReceiver: buyer.publicKey,
        })
        .signers([validator])
        .rpc();

      const deal = await program.account.deal.fetch(dealKeypair.publicKey);
      expect(JSON.stringify(deal.status)).to.equal(JSON.stringify({ released: {} }));
    });

    it("escrow is closed after release (rent recovered)", async () => {
      const dealKeypair = await createTestDeal({
        buyer,
        seller,
        buyerTokenAccount,
        sellerTokenAccount,
      });
      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), dealKeypair.publicKey.toBuffer()],
        program.programId
      );

      const escrowBefore = await getAccount(provider.connection, escrowPda);
      expect(Number(escrowBefore.amount)).to.equal(1_000_000);

      await program.methods
        .release()
        .accounts({
          deal: dealKeypair.publicKey,
          authority: buyer.publicKey,
          beneficiaryTokenAccount: sellerTokenAccount,
          buyerTokenAccount: buyerTokenAccount,
          rentReceiver: buyer.publicKey,
        })
        .signers([buyer])
        .rpc();

      try {
        await getAccount(provider.connection, escrowPda);
        expect.fail("Escrow should have been closed");
      } catch (err: any) {
        expect(err).to.exist;
      }
    });

    it("escrow is closed after refund (rent recovered)", async () => {
      const dealKeypair = await createTestDeal({
        buyer,
        seller,
        buyerTokenAccount,
        sellerTokenAccount,
      });
      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), dealKeypair.publicKey.toBuffer()],
        program.programId
      );

      await program.methods
        .refund()
        .accounts({
          deal: dealKeypair.publicKey,
          authority: seller.publicKey,
          beneficiaryTokenAccount: sellerTokenAccount,
          buyerTokenAccount: buyerTokenAccount,
          rentReceiver: buyer.publicKey,
        })
        .signers([seller])
        .rpc();

      try {
        await getAccount(provider.connection, escrowPda);
        expect.fail("Escrow should have been closed after refund");
      } catch (err: any) {
        expect(err).to.exist;
      }
    });

    it("rejects refund to wrong buyer token account", async () => {
      const dealKeypair = await createTestDeal({
        buyer,
        seller,
        buyerTokenAccount,
        sellerTokenAccount,
      });

      const hacker = Keypair.generate();
      const hackerTokenAccount = await createAccount(
        provider.connection,
        admin.payer,
        mint,
        hacker.publicKey
      );

      try {
        await program.methods
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
        const errStr = err.error?.errorCode?.code || err.toString();
        expect(errStr).to.satisfy((s: string) =>
          s.includes("InvalidBuyerTokenAccount") || s.includes("ConstraintRaw") || s.includes("2003")
        );
      }
    });

    it("rejects negative release_delay", async () => {
      const dealKeypair = Keypair.generate();

      try {
        await program.methods
          .createDeal(DEAL_AMOUNT, FEE_BPS, new anchor.BN(-1), TIMEOUT, DISPUTE_DELAY, METADATA_HASH, [])
          .accounts({
            deal: dealKeypair.publicKey,
            buyer: buyer.publicKey,
            seller: seller.publicKey,
            validator: validator.publicKey,
            buyerTokenAccount: buyerTokenAccount,
            feeCollector: feeCollector.publicKey,
            feeCollectorTokenAccount: feeCollectorTokenAccount,
            treasuryTokenAccount: treasuryTokenAccount,
            mint: mint,
          })
          .signers([buyer, dealKeypair])
          .rpc();
        expect.fail("Should have rejected: negative release_delay");
      } catch (err: any) {
        const errStr = err.error?.errorCode?.code || err.toString();
        expect(errStr).to.satisfy((s: string) =>
          s.includes("InvalidReleaseDelay") || s.includes("6012")
        );
      }
    });

    it("rejects release_delay > 365 days", async () => {
      const dealKeypair = Keypair.generate();
      const tooLong = new anchor.BN(366 * 24 * 3600);

      try {
        await program.methods
          .createDeal(DEAL_AMOUNT, FEE_BPS, tooLong, TIMEOUT, DISPUTE_DELAY, METADATA_HASH, [])
          .accounts({
            deal: dealKeypair.publicKey,
            buyer: buyer.publicKey,
            seller: seller.publicKey,
            validator: validator.publicKey,
            buyerTokenAccount: buyerTokenAccount,
            feeCollector: feeCollector.publicKey,
            feeCollectorTokenAccount: feeCollectorTokenAccount,
            treasuryTokenAccount: treasuryTokenAccount,
            mint: mint,
          })
          .signers([buyer, dealKeypair])
          .rpc();
        expect.fail("Should have rejected: release_delay too long");
      } catch (err: any) {
        const errStr = err.error?.errorCode?.code || err.toString();
        expect(errStr).to.satisfy((s: string) =>
          s.includes("InvalidReleaseDelay") || s.includes("6012")
        );
      }
    });

    it("rejects deal where buyer equals seller", async () => {
      const dealKeypair = Keypair.generate();

      try {
        await program.methods
          .createDeal(DEAL_AMOUNT, FEE_BPS, RELEASE_DELAY, TIMEOUT, DISPUTE_DELAY, METADATA_HASH, [])
          .accounts({
            deal: dealKeypair.publicKey,
            buyer: buyer.publicKey,
            seller: buyer.publicKey,
            validator: validator.publicKey,
            buyerTokenAccount: buyerTokenAccount,
            feeCollector: feeCollector.publicKey,
            feeCollectorTokenAccount: feeCollectorTokenAccount,
            treasuryTokenAccount: treasuryTokenAccount,
            mint: mint,
          })
          .signers([buyer, dealKeypair])
          .rpc();
        expect.fail("Should have rejected: buyer == seller");
      } catch (err: any) {
        const errStr = err.error?.errorCode?.code || err.toString();
        expect(errStr).to.satisfy((s: string) =>
          s.includes("BuyerEqualsSeller") || s.includes("6013")
        );
      }
    });

    it("rejects deal where validator equals buyer", async () => {
      const dealKeypair = Keypair.generate();

      try {
        await program.methods
          .createDeal(DEAL_AMOUNT, FEE_BPS, RELEASE_DELAY, TIMEOUT, DISPUTE_DELAY, METADATA_HASH, [])
          .accounts({
            deal: dealKeypair.publicKey,
            buyer: buyer.publicKey,
            seller: seller.publicKey,
            validator: buyer.publicKey,
            buyerTokenAccount: buyerTokenAccount,
            feeCollector: feeCollector.publicKey,
            feeCollectorTokenAccount: feeCollectorTokenAccount,
            treasuryTokenAccount: treasuryTokenAccount,
            mint: mint,
          })
          .signers([buyer, dealKeypair])
          .rpc();
        expect.fail("Should have rejected: validator == buyer");
      } catch (err: any) {
        const errStr = err.error?.errorCode?.code || err.toString();
        expect(errStr).to.contain("InvalidValidator");
      }
    });

    it("accepts release_delay at exactly 365 days (boundary)", async () => {
      const dealKeypair = Keypair.generate();
      const maxDelay = new anchor.BN(365 * 24 * 3600);

      await program.methods
        .createDeal(DEAL_AMOUNT, FEE_BPS, maxDelay, TIMEOUT, DISPUTE_DELAY, METADATA_HASH, [])
        .accounts({
          deal: dealKeypair.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          validator: validator.publicKey,
          buyerTokenAccount: buyerTokenAccount,
          feeCollector: feeCollector.publicKey,
          feeCollectorTokenAccount: feeCollectorTokenAccount,
          treasuryTokenAccount: treasuryTokenAccount,
          mint: mint,
        })
        .signers([buyer, dealKeypair])
        .rpc();

      const deal = await program.account.deal.fetch(dealKeypair.publicKey);
      expect(deal.releaseDelay.toNumber()).to.equal(365 * 24 * 3600);
    });

    it("rejects timeout < 1 hour", async () => {
      const dealKeypair = Keypair.generate();
      const tooShort = new anchor.BN(1800); // 30 minutes

      try {
        await program.methods
          .createDeal(DEAL_AMOUNT, FEE_BPS, RELEASE_DELAY, tooShort, DISPUTE_DELAY, METADATA_HASH, [])
          .accounts({
            deal: dealKeypair.publicKey,
            buyer: buyer.publicKey,
            seller: seller.publicKey,
            validator: validator.publicKey,
            buyerTokenAccount: buyerTokenAccount,
            feeCollector: feeCollector.publicKey,
            feeCollectorTokenAccount: feeCollectorTokenAccount,
            treasuryTokenAccount: treasuryTokenAccount,
            mint: mint,
          })
          .signers([buyer, dealKeypair])
          .rpc();
        expect.fail("Should have rejected: timeout too short");
      } catch (err: any) {
        expect(err.error?.errorCode?.code || err.toString()).to.contain("InvalidTimeout");
      }
    });

    it("accepts deal with zero fees", async () => {
      const dealKeypair = Keypair.generate();

      await program.methods
        .createDeal(DEAL_AMOUNT, new anchor.BN(0), RELEASE_DELAY, TIMEOUT, DISPUTE_DELAY, METADATA_HASH, [])
        .accounts({
          deal: dealKeypair.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          validator: validator.publicKey,
          buyerTokenAccount: buyerTokenAccount,
          feeCollector: feeCollector.publicKey,
          feeCollectorTokenAccount: feeCollectorTokenAccount,
          treasuryTokenAccount: treasuryTokenAccount,
          mint: mint,
        })
        .signers([buyer, dealKeypair])
        .rpc();

      const deal = await program.account.deal.fetch(dealKeypair.publicKey);
      expect(deal.feeBps.toNumber()).to.equal(0);
    });
  });

  // ============================================================
  // 5. DISPUTE MECHANICS & RESOLVE_DISPUTE (STRESS TESTS)
  // ============================================================
  describe("dispute mechanics & resolve_dispute", () => {
    let buyer: Keypair;
    let seller: Keypair;
    let buyerTokenAccount: PublicKey;
    let sellerTokenAccount: PublicKey;

    before(async () => {
      buyer = Keypair.generate();
      seller = Keypair.generate();

      for (const kp of [buyer, seller]) {
        const sig = await provider.connection.requestAirdrop(
          kp.publicKey,
          5 * anchor.web3.LAMPORTS_PER_SOL
        );
        await provider.connection.confirmTransaction(sig);
      }

      buyerTokenAccount = await createAccount(
        provider.connection,
        admin.payer,
        mint,
        buyer.publicKey
      );
      sellerTokenAccount = await createAccount(
        provider.connection,
        admin.payer,
        mint,
        seller.publicKey
      );

      await mintTo(
        provider.connection,
        admin.payer,
        mint,
        buyerTokenAccount,
        admin.publicKey,
        50_000_000
      );
    });

    // ── dispute_delay validation ──

    it("rejects negative dispute_delay", async () => {
      const dealKeypair = Keypair.generate();
      try {
        await program.methods
          .createDeal(DEAL_AMOUNT, FEE_BPS, RELEASE_DELAY, TIMEOUT, new anchor.BN(-1), METADATA_HASH, [])
          .accounts({
            deal: dealKeypair.publicKey,
            buyer: buyer.publicKey,
            seller: seller.publicKey,
            validator: validator.publicKey,
            buyerTokenAccount: buyerTokenAccount,
            feeCollector: feeCollector.publicKey,
            feeCollectorTokenAccount: feeCollectorTokenAccount,
            treasuryTokenAccount: treasuryTokenAccount,
            mint: mint,
          })
          .signers([buyer, dealKeypair])
          .rpc();
        expect.fail("Should have thrown InvalidDisputeDelay");
      } catch (err: any) {
        expect(err.error?.errorCode?.code || err.toString()).to.contain("InvalidDisputeDelay");
      }
    });

    it("rejects dispute_delay > 365 days", async () => {
      const dealKeypair = Keypair.generate();
      const tooLong = new anchor.BN(366 * 24 * 3600);
      try {
        await program.methods
          .createDeal(DEAL_AMOUNT, FEE_BPS, RELEASE_DELAY, TIMEOUT, tooLong, METADATA_HASH, [])
          .accounts({
            deal: dealKeypair.publicKey,
            buyer: buyer.publicKey,
            seller: seller.publicKey,
            validator: validator.publicKey,
            buyerTokenAccount: buyerTokenAccount,
            feeCollector: feeCollector.publicKey,
            feeCollectorTokenAccount: feeCollectorTokenAccount,
            treasuryTokenAccount: treasuryTokenAccount,
            mint: mint,
          })
          .signers([buyer, dealKeypair])
          .rpc();
        expect.fail("Should have thrown InvalidDisputeDelay");
      } catch (err: any) {
        expect(err.error?.errorCode?.code || err.toString()).to.contain("InvalidDisputeDelay");
      }
    });

    it("accepts dispute_delay at exactly 365 days (boundary)", async () => {
      const dealKeypair = Keypair.generate();
      const maxDelay = new anchor.BN(365 * 24 * 3600);
      await program.methods
        .createDeal(DEAL_AMOUNT, FEE_BPS, RELEASE_DELAY, TIMEOUT, maxDelay, METADATA_HASH, [])
        .accounts({
          deal: dealKeypair.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          validator: validator.publicKey,
          buyerTokenAccount: buyerTokenAccount,
          feeCollector: feeCollector.publicKey,
          feeCollectorTokenAccount: feeCollectorTokenAccount,
          treasuryTokenAccount: treasuryTokenAccount,
          mint: mint,
        })
        .signers([buyer, dealKeypair])
        .rpc();

      const deal = await program.account.deal.fetch(dealKeypair.publicKey);
      expect(deal.disputeDelay.toNumber()).to.equal(365 * 24 * 3600);
    });

    // ── dispute_delay enforcement ──

    it("dispute_delay = 0 allows instant dispute", async () => {
      const dealKeypair = await createTestDeal({
        buyer,
        seller,
        buyerTokenAccount,
        sellerTokenAccount,
        disputeDelay: new anchor.BN(0),
      });

      await program.methods
        .dispute()
        .accounts({
          deal: dealKeypair.publicKey,
          authority: buyer.publicKey,
        })
        .signers([buyer])
        .rpc();

      const deal = await program.account.deal.fetch(dealKeypair.publicKey);
      expect(JSON.stringify(deal.status)).to.equal(JSON.stringify({ disputed: {} }));
    });

    it("rejects dispute before cooling period has elapsed", async () => {
      const dealKeypair = await createTestDeal({
        buyer,
        seller,
        buyerTokenAccount,
        sellerTokenAccount,
        disputeDelay: new anchor.BN(999_999), // ~11.5 days
      });

      try {
        await program.methods
          .dispute()
          .accounts({
            deal: dealKeypair.publicKey,
            authority: buyer.publicKey,
          })
          .signers([buyer])
          .rpc();
        expect.fail("Should have thrown DisputeTooEarly");
      } catch (err: any) {
        expect(err.error?.errorCode?.code || err.toString()).to.contain("DisputeTooEarly");
      }
    });

    // ── seller can dispute ──

    it("seller (beneficiary) can open dispute", async () => {
      const dealKeypair = await createTestDeal({
        buyer,
        seller,
        buyerTokenAccount,
        sellerTokenAccount,
        disputeDelay: new anchor.BN(0),
      });

      await program.methods
        .dispute()
        .accounts({
          deal: dealKeypair.publicKey,
          authority: seller.publicKey,
        })
        .signers([seller])
        .rpc();

      const deal = await program.account.deal.fetch(dealKeypair.publicKey);
      expect(JSON.stringify(deal.status)).to.equal(JSON.stringify({ disputed: {} }));
    });

    it("unauthorized party cannot open dispute", async () => {
      const dealKeypair = await createTestDeal({
        buyer,
        seller,
        buyerTokenAccount,
        sellerTokenAccount,
        disputeDelay: new anchor.BN(0),
      });

      const hacker = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(
        hacker.publicKey,
        1 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      try {
        await program.methods
          .dispute()
          .accounts({
            deal: dealKeypair.publicKey,
            authority: hacker.publicKey,
          })
          .signers([hacker])
          .rpc();
        expect.fail("Should have thrown Unauthorized");
      } catch (err: any) {
        expect(err.error?.errorCode?.code || err.toString()).to.contain("Unauthorized");
      }
    });

    // ── resolve_dispute ──

    it("validator resolves dispute with 60/40 split", async () => {
      const dealKeypair = await createTestDeal({
        buyer,
        seller,
        buyerTokenAccount,
        sellerTokenAccount,
        disputeDelay: new anchor.BN(0),
      });

      await program.methods
        .dispute()
        .accounts({
          deal: dealKeypair.publicKey,
          authority: buyer.publicKey,
        })
        .signers([buyer])
        .rpc();

      const sellerBefore = await getAccount(provider.connection, sellerTokenAccount);
      const buyerBefore = await getAccount(provider.connection, buyerTokenAccount);

      await program.methods
        .resolveDispute(new anchor.BN(400_000), new anchor.BN(600_000))
        .accounts({
          deal: dealKeypair.publicKey,
          authority: validator.publicKey,
          beneficiaryTokenAccount: sellerTokenAccount,
          buyerTokenAccount: buyerTokenAccount,
          rentReceiver: buyer.publicKey,
        })
        .signers([validator])
        .rpc();

      const deal = await program.account.deal.fetch(dealKeypair.publicKey);
      expect(JSON.stringify(deal.status)).to.equal(JSON.stringify({ released: {} }));

      const sellerAfter = await getAccount(provider.connection, sellerTokenAccount);
      const buyerAfter = await getAccount(provider.connection, buyerTokenAccount);
      expect(Number(sellerAfter.amount) - Number(sellerBefore.amount)).to.equal(600_000);
      expect(Number(buyerAfter.amount) - Number(buyerBefore.amount)).to.equal(400_000);
    });

    it("validator resolves dispute 100% to buyer (full refund)", async () => {
      const dealKeypair = await createTestDeal({
        buyer,
        seller,
        buyerTokenAccount,
        sellerTokenAccount,
        disputeDelay: new anchor.BN(0),
      });

      await program.methods
        .dispute()
        .accounts({
          deal: dealKeypair.publicKey,
          authority: buyer.publicKey,
        })
        .signers([buyer])
        .rpc();

      const buyerBefore = await getAccount(provider.connection, buyerTokenAccount);

      await program.methods
        .resolveDispute(DEAL_AMOUNT, new anchor.BN(0))
        .accounts({
          deal: dealKeypair.publicKey,
          authority: validator.publicKey,
          beneficiaryTokenAccount: sellerTokenAccount,
          buyerTokenAccount: buyerTokenAccount,
          rentReceiver: buyer.publicKey,
        })
        .signers([validator])
        .rpc();

      const buyerAfter = await getAccount(provider.connection, buyerTokenAccount);
      expect(Number(buyerAfter.amount) - Number(buyerBefore.amount)).to.equal(1_000_000);
    });

    it("validator resolves dispute 100% to seller", async () => {
      const dealKeypair = await createTestDeal({
        buyer,
        seller,
        buyerTokenAccount,
        sellerTokenAccount,
        disputeDelay: new anchor.BN(0),
      });

      await program.methods
        .dispute()
        .accounts({
          deal: dealKeypair.publicKey,
          authority: buyer.publicKey,
        })
        .signers([buyer])
        .rpc();

      const sellerBefore = await getAccount(provider.connection, sellerTokenAccount);

      await program.methods
        .resolveDispute(new anchor.BN(0), DEAL_AMOUNT)
        .accounts({
          deal: dealKeypair.publicKey,
          authority: validator.publicKey,
          beneficiaryTokenAccount: sellerTokenAccount,
          buyerTokenAccount: buyerTokenAccount,
          rentReceiver: buyer.publicKey,
        })
        .signers([validator])
        .rpc();

      const sellerAfter = await getAccount(provider.connection, sellerTokenAccount);
      expect(Number(sellerAfter.amount) - Number(sellerBefore.amount)).to.equal(1_000_000);
    });

    it("rejects resolve_dispute with invalid split (sum != amount)", async () => {
      const dealKeypair = await createTestDeal({
        buyer,
        seller,
        buyerTokenAccount,
        sellerTokenAccount,
        disputeDelay: new anchor.BN(0),
      });

      await program.methods
        .dispute()
        .accounts({
          deal: dealKeypair.publicKey,
          authority: buyer.publicKey,
        })
        .signers([buyer])
        .rpc();

      try {
        await program.methods
          .resolveDispute(new anchor.BN(500_000), new anchor.BN(600_000))
          .accounts({
            deal: dealKeypair.publicKey,
            authority: validator.publicKey,
            beneficiaryTokenAccount: sellerTokenAccount,
            buyerTokenAccount: buyerTokenAccount,
            rentReceiver: buyer.publicKey,
          })
          .signers([validator])
          .rpc();
        expect.fail("Should have thrown InvalidSplit");
      } catch (err: any) {
        expect(err.error?.errorCode?.code || err.toString()).to.contain("InvalidSplit");
      }
    });

    it("non-validator cannot resolve dispute", async () => {
      const dealKeypair = await createTestDeal({
        buyer,
        seller,
        buyerTokenAccount,
        sellerTokenAccount,
        disputeDelay: new anchor.BN(0),
      });

      await program.methods
        .dispute()
        .accounts({
          deal: dealKeypair.publicKey,
          authority: buyer.publicKey,
        })
        .signers([buyer])
        .rpc();

      try {
        await program.methods
          .resolveDispute(new anchor.BN(500_000), new anchor.BN(500_000))
          .accounts({
            deal: dealKeypair.publicKey,
            authority: buyer.publicKey,
            beneficiaryTokenAccount: sellerTokenAccount,
            buyerTokenAccount: buyerTokenAccount,
            rentReceiver: buyer.publicKey,
          })
          .signers([buyer])
          .rpc();
        expect.fail("Should have thrown Unauthorized");
      } catch (err: any) {
        expect(err.error?.errorCode?.code || err.toString()).to.contain("Unauthorized");
      }
    });

    it("cannot resolve a non-disputed deal (Open state)", async () => {
      const dealKeypair = await createTestDeal({
        buyer,
        seller,
        buyerTokenAccount,
        sellerTokenAccount,
      });

      try {
        await program.methods
          .resolveDispute(new anchor.BN(500_000), new anchor.BN(500_000))
          .accounts({
            deal: dealKeypair.publicKey,
            authority: validator.publicKey,
            beneficiaryTokenAccount: sellerTokenAccount,
            buyerTokenAccount: buyerTokenAccount,
            rentReceiver: buyer.publicKey,
          })
          .signers([validator])
          .rpc();
        expect.fail("Should have thrown NotDisputed");
      } catch (err: any) {
        expect(err.error?.errorCode?.code || err.toString()).to.contain("NotDisputed");
      }
    });

    // ── expire_deal vs disputed deals ──

    it("expire_deal rejects disputed deals (must go through validator)", async () => {
      const dealKeypair = await createTestDeal({
        buyer,
        seller,
        buyerTokenAccount,
        sellerTokenAccount,
        disputeDelay: new anchor.BN(0),
      });

      await program.methods
        .dispute()
        .accounts({
          deal: dealKeypair.publicKey,
          authority: buyer.publicKey,
        })
        .signers([buyer])
        .rpc();

      try {
        await program.methods
          .expireDeal()
          .accounts({
            deal: dealKeypair.publicKey,
            authority: buyer.publicKey,
            beneficiaryTokenAccount: sellerTokenAccount,
            buyerTokenAccount: buyerTokenAccount,
            rentReceiver: buyer.publicKey,
          })
          .signers([buyer])
          .rpc();
        expect.fail("Should have rejected: disputed deals cannot expire");
      } catch (err: any) {
        const errStr = err.error?.errorCode?.code || err.toString();
        expect(errStr).to.satisfy((s: string) =>
          s.includes("NotEligible") || s.includes("DealNotExpired")
        );
      }
    });

    // ── timeout floor (1 hour) ──

    it("accepts timeout at exactly 1 hour (boundary)", async () => {
      const dealKeypair = Keypair.generate();
      const oneHour = new anchor.BN(3600);
      await program.methods
        .createDeal(DEAL_AMOUNT, FEE_BPS, RELEASE_DELAY, oneHour, DISPUTE_DELAY, METADATA_HASH, [])
        .accounts({
          deal: dealKeypair.publicKey,
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          validator: validator.publicKey,
          buyerTokenAccount: buyerTokenAccount,
          feeCollector: feeCollector.publicKey,
          feeCollectorTokenAccount: feeCollectorTokenAccount,
          treasuryTokenAccount: treasuryTokenAccount,
          mint: mint,
        })
        .signers([buyer, dealKeypair])
        .rpc();

      const deal = await program.account.deal.fetch(dealKeypair.publicKey);
      expect(deal.timeout.toNumber()).to.equal(3600);
    });

    it("rejects timeout < 1 hour", async () => {
      const dealKeypair = Keypair.generate();
      const tooShort = new anchor.BN(1800); // 30 minutes
      try {
        await program.methods
          .createDeal(DEAL_AMOUNT, FEE_BPS, RELEASE_DELAY, tooShort, DISPUTE_DELAY, METADATA_HASH, [])
          .accounts({
            deal: dealKeypair.publicKey,
            buyer: buyer.publicKey,
            seller: seller.publicKey,
            validator: validator.publicKey,
            buyerTokenAccount: buyerTokenAccount,
            feeCollector: feeCollector.publicKey,
            feeCollectorTokenAccount: feeCollectorTokenAccount,
            treasuryTokenAccount: treasuryTokenAccount,
            mint: mint,
          })
          .signers([buyer, dealKeypair])
          .rpc();
        expect.fail("Should have thrown InvalidTimeout");
      } catch (err: any) {
        expect(err.error?.errorCode?.code || err.toString()).to.contain("InvalidTimeout");
      }
    });
  });
});
