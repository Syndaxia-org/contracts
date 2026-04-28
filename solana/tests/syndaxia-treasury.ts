// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Association Syndaxia (Governance)

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SyndaxiaTreasury } from "../target/types/syndaxia_treasury";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";

describe("syndaxia-treasury", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SyndaxiaTreasury as Program<SyndaxiaTreasury>;
  const admin = provider.wallet as anchor.Wallet;

  let mint: PublicKey;
  let multisig: Keypair;
  let feeReceiver: Keypair;
  let feeReceiverTokenAccount: PublicKey;
  let treasuryTokenAccount: PublicKey;
  let configPda: PublicKey;
  let configBump: number;

  before(async () => {
    multisig = Keypair.generate();
    feeReceiver = Keypair.generate();

    for (const kp of [multisig, feeReceiver]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    mint = await createMint(
      provider.connection,
      admin.payer,
      admin.publicKey,
      null,
      6
    );

    [configPda, configBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury-config")],
      program.programId
    );

    feeReceiverTokenAccount = await createAccount(
      provider.connection,
      admin.payer,
      mint,
      feeReceiver.publicKey
    );

    // Treasury token account - for tests, owned by admin during setup.
    // The program will verify during withdraw() that the correct account is provided.
    treasuryTokenAccount = await createAccount(
      provider.connection,
      admin.payer,
      mint,
      admin.publicKey
    );
  });

  // ─────────────────────────────────────────────────────────
  // 1. INITIALIZE
  // ─────────────────────────────────────────────────────────
  describe("initialize", () => {
    it("initializes the treasury config with 5 BPS", async () => {
      await program.methods
        .initialize(feeReceiver.publicKey)
        .accounts({
          multisig: multisig.publicKey,
        })
        .signers([multisig])
        .rpc();

      const config = await program.account.treasuryConfig.fetch(configPda);
      expect(config.multisig.toBase58()).to.equal(multisig.publicKey.toBase58());
      expect(config.feeReceiver.toBase58()).to.equal(feeReceiver.publicKey.toBase58());
      expect(config.protocolFeeBps.toNumber()).to.equal(5);
      expect(config.pendingFeeBps).to.be.null;
      expect(config.timelockUntil.toNumber()).to.equal(0);
    });

    it("rejects double initialization", async () => {
      try {
        await program.methods
          .initialize(feeReceiver.publicKey)
          .accounts({ multisig: multisig.publicKey })
          .signers([multisig])
          .rpc();
        expect.fail("should have thrown");
      } catch (e: any) {
        expect(e.message).to.include("already in use");
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // 2. PROPOSE FEE CHANGE
  // ─────────────────────────────────────────────────────────
  describe("propose_fee_change", () => {
    it("proposes a new fee of 10 BPS and sets timelock", async () => {
      await program.methods
        .proposeFeeChange(new anchor.BN(10))
        .accounts({ multisig: multisig.publicKey })
        .signers([multisig])
        .rpc();

      const config = await program.account.treasuryConfig.fetch(configPda);
      expect(config.pendingFeeBps).to.not.be.null;
      expect(config.pendingFeeBps!.toNumber()).to.equal(10);
      const now = Math.floor(Date.now() / 1000);
      // timelock_until should be ~7 days from now
      expect(config.timelockUntil.toNumber()).to.be.greaterThan(now + 6 * 24 * 3600);
      // active fee unchanged
      expect(config.protocolFeeBps.toNumber()).to.equal(5);
    });

    it("rejects fee > 20 BPS (hard cap)", async () => {
      try {
        await program.methods
          .proposeFeeChange(new anchor.BN(21))
          .accounts({ multisig: multisig.publicKey })
          .signers([multisig])
          .rpc();
        expect.fail("should have thrown");
      } catch (e: any) {
        expect(e.message).to.include("FeeTooHigh");
      }
    });

    it("rejects proposal from non-multisig", async () => {
      const rogue = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(rogue.publicKey, anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
      try {
        await program.methods
          .proposeFeeChange(new anchor.BN(5))
          .accounts({ multisig: rogue.publicKey })
          .signers([rogue])
          .rpc();
        expect.fail("should have thrown");
      } catch (e: any) {
        expect(e.message).to.include("Unauthorized");
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // 3. CANCEL FEE CHANGE
  // ─────────────────────────────────────────────────────────
  describe("cancel_fee_change", () => {
    it("cancels the pending proposal", async () => {
      await program.methods
        .cancelFeeChange()
        .accounts({ multisig: multisig.publicKey })
        .signers([multisig])
        .rpc();

      const config = await program.account.treasuryConfig.fetch(configPda);
      expect(config.pendingFeeBps).to.be.null;
      expect(config.timelockUntil.toNumber()).to.equal(0);
      // active rate still unchanged
      expect(config.protocolFeeBps.toNumber()).to.equal(5);
    });

    it("rejects cancel when no proposal is pending", async () => {
      try {
        await program.methods
          .cancelFeeChange()
          .accounts({ multisig: multisig.publicKey })
          .signers([multisig])
          .rpc();
        expect.fail("should have thrown");
      } catch (e: any) {
        expect(e.message).to.include("NoPendingProposal");
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // 4. APPLY FEE CHANGE (timelock)
  // ─────────────────────────────────────────────────────────
  describe("apply_fee_change", () => {
    it("rejects application before timelock has elapsed", async () => {
      // Propose a new rate
      await program.methods
        .proposeFeeChange(new anchor.BN(8))
        .accounts({ multisig: multisig.publicKey })
        .signers([multisig])
        .rpc();

      try {
        await program.methods
          .applyFeeChange()
          .accounts({})
          .rpc();
        expect.fail("should have thrown");
      } catch (e: any) {
        expect(e.message).to.include("TimelockNotElapsed");
      }
    });

    it("rejects application with no pending proposal", async () => {
      // Cancel first
      await program.methods
        .cancelFeeChange()
        .accounts({ multisig: multisig.publicKey })
        .signers([multisig])
        .rpc();

      try {
        await program.methods
          .applyFeeChange()
          .accounts({})
          .rpc();
        expect.fail("should have thrown");
      } catch (e: any) {
        expect(e.message).to.include("NoPendingProposal");
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // 5. UPDATE FEE RECEIVER (timelocked)
  // ─────────────────────────────────────────────────────────
  describe("propose_fee_receiver_change", () => {
    it("proposes a new fee receiver and sets timelock", async () => {
      const newReceiver = Keypair.generate();
      await program.methods
        .proposeFeeReceiverChange(newReceiver.publicKey)
        .accounts({ multisig: multisig.publicKey })
        .signers([multisig])
        .rpc();

      const config = await program.account.treasuryConfig.fetch(configPda);
      expect(config.pendingFeeReceiver).to.not.be.null;
      expect(config.pendingFeeReceiver!.toBase58()).to.equal(newReceiver.publicKey.toBase58());
      // active receiver unchanged
      expect(config.feeReceiver.toBase58()).to.equal(feeReceiver.publicKey.toBase58());

      // Cleanup for subsequent tests
      await program.methods
        .cancelFeeReceiverChange()
        .accounts({ multisig: multisig.publicKey })
        .signers([multisig])
        .rpc();
    });

    it("rejects proposal from non-multisig", async () => {
      const rogue = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(rogue.publicKey, anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
      try {
        await program.methods
          .proposeFeeReceiverChange(rogue.publicKey)
          .accounts({ multisig: rogue.publicKey })
          .signers([rogue])
          .rpc();
        expect.fail("should have thrown");
      } catch (e: any) {
        expect(e.message).to.include("Unauthorized");
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // 6. WITHDRAW
  // ─────────────────────────────────────────────────────────
  // NOTE: Withdraw integration tested in syndaxia-core tests where protocol fees flow.
  // Standalone withdraw tests skipped due to treasury_token_account ownership constraints
  // (requires PDA ownership which test setup doesn't support natively).
  describe.skip("withdraw", () => {
    it("placeholder", () => {
      // Skipped - tested via core
    });
  });

  // ─────────────────────────────────────────────────────────
  // 7. SECURITY PATCHES (Series B treasury hardening)
  // ─────────────────────────────────────────────────────────
  describe("security patches", () => {
    // ── T-MED-1: cannot overwrite a pending proposal ──────────────────────
    it("T-MED-1: rejects propose_fee_change while one is pending", async () => {
      await program.methods
        .proposeFeeChange(new anchor.BN(7))
        .accounts({ multisig: multisig.publicKey })
        .signers([multisig])
        .rpc();
      try {
        await program.methods
          .proposeFeeChange(new anchor.BN(9))
          .accounts({ multisig: multisig.publicKey })
          .signers([multisig])
          .rpc();
        expect.fail("should have thrown ProposalAlreadyPending");
      } catch (e: any) {
        expect(e.message).to.include("ProposalAlreadyPending");
      } finally {
        await program.methods
          .cancelFeeChange()
          .accounts({ multisig: multisig.publicKey })
          .signers([multisig])
          .rpc();
      }
    });

    it("T-MED-1: rejects propose_fee_receiver_change while one is pending", async () => {
      const r1 = Keypair.generate();
      const r2 = Keypair.generate();
      await program.methods
        .proposeFeeReceiverChange(r1.publicKey)
        .accounts({ multisig: multisig.publicKey })
        .signers([multisig])
        .rpc();
      try {
        await program.methods
          .proposeFeeReceiverChange(r2.publicKey)
          .accounts({ multisig: multisig.publicKey })
          .signers([multisig])
          .rpc();
        expect.fail("should have thrown ProposalAlreadyPending");
      } catch (e: any) {
        expect(e.message).to.include("ProposalAlreadyPending");
      } finally {
        await program.methods
          .cancelFeeReceiverChange()
          .accounts({ multisig: multisig.publicKey })
          .signers([multisig])
          .rpc();
      }
    });

    // ── T-MED-2: validate new fee receiver ─────────────────────────────────
    it("T-MED-2: rejects propose_fee_receiver_change with default pubkey", async () => {
      try {
        await program.methods
          .proposeFeeReceiverChange(PublicKey.default)
          .accounts({ multisig: multisig.publicKey })
          .signers([multisig])
          .rpc();
        expect.fail("should have thrown InvalidFeeReceiver");
      } catch (e: any) {
        expect(e.message).to.include("InvalidFeeReceiver");
      }
    });

    // ── T-MED-3: no-op proposals rejected ──────────────────────────────────
    it("T-MED-3: rejects propose_fee_change equal to current fee", async () => {
      const cfg = await program.account.treasuryConfig.fetch(configPda);
      try {
        await program.methods
          .proposeFeeChange(cfg.protocolFeeBps)
          .accounts({ multisig: multisig.publicKey })
          .signers([multisig])
          .rpc();
        expect.fail("should have thrown NoOpProposal");
      } catch (e: any) {
        expect(e.message).to.include("NoOpProposal");
      }
    });

    it("T-MED-3: rejects propose_fee_receiver_change equal to current receiver", async () => {
      const cfg = await program.account.treasuryConfig.fetch(configPda);
      try {
        await program.methods
          .proposeFeeReceiverChange(cfg.feeReceiver)
          .accounts({ multisig: multisig.publicKey })
          .signers([multisig])
          .rpc();
        expect.fail("should have thrown NoOpProposal");
      } catch (e: any) {
        expect(e.message).to.include("NoOpProposal");
      }
    });

    // ── T-HIGH-1: multisig rotation ────────────────────────────────────────
    it("T-HIGH-1: proposes a multisig rotation and sets timelock", async () => {
      const newMs = Keypair.generate();
      await program.methods
        .proposeMultisigChange(newMs.publicKey)
        .accounts({ multisig: multisig.publicKey })
        .signers([multisig])
        .rpc();

      const cfg = await program.account.treasuryConfig.fetch(configPda);
      expect(cfg.pendingMultisig).to.not.be.null;
      expect(cfg.pendingMultisig!.toBase58()).to.equal(newMs.publicKey.toBase58());
      const now = Math.floor(Date.now() / 1000);
      expect(cfg.multisigTimelockUntil.toNumber()).to.be.greaterThan(now + 6 * 24 * 3600);
      // active multisig unchanged
      expect(cfg.multisig.toBase58()).to.equal(multisig.publicKey.toBase58());
    });

    it("T-HIGH-1: rejects second multisig proposal while one is pending", async () => {
      const newMs = Keypair.generate();
      try {
        await program.methods
          .proposeMultisigChange(newMs.publicKey)
          .accounts({ multisig: multisig.publicKey })
          .signers([multisig])
          .rpc();
        expect.fail("should have thrown ProposalAlreadyPending");
      } catch (e: any) {
        expect(e.message).to.include("ProposalAlreadyPending");
      }
    });

    it("T-HIGH-1: cancels a pending multisig rotation", async () => {
      await program.methods
        .cancelMultisigChange()
        .accounts({ multisig: multisig.publicKey })
        .signers([multisig])
        .rpc();
      const cfg = await program.account.treasuryConfig.fetch(configPda);
      expect(cfg.pendingMultisig).to.be.null;
      expect(cfg.multisigTimelockUntil.toNumber()).to.equal(0);
    });

    it("T-HIGH-1: rejects propose_multisig_change with default pubkey", async () => {
      try {
        await program.methods
          .proposeMultisigChange(PublicKey.default)
          .accounts({ multisig: multisig.publicKey })
          .signers([multisig])
          .rpc();
        expect.fail("should have thrown InvalidMultisig");
      } catch (e: any) {
        expect(e.message).to.include("InvalidMultisig");
      }
    });

    it("T-HIGH-1: rejects propose_multisig_change equal to current multisig", async () => {
      try {
        await program.methods
          .proposeMultisigChange(multisig.publicKey)
          .accounts({ multisig: multisig.publicKey })
          .signers([multisig])
          .rpc();
        expect.fail("should have thrown NoOpProposal");
      } catch (e: any) {
        expect(e.message).to.include("NoOpProposal");
      }
    });

    it("T-HIGH-1: rejects propose_multisig_change from non-multisig", async () => {
      const rogue = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(rogue.publicKey, anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
      const target = Keypair.generate();
      try {
        await program.methods
          .proposeMultisigChange(target.publicKey)
          .accounts({ multisig: rogue.publicKey })
          .signers([rogue])
          .rpc();
        expect.fail("should have thrown Unauthorized");
      } catch (e: any) {
        expect(e.message).to.include("Unauthorized");
      }
    });

    // Apply paths require clock advancement (bankrun); tracked here for completeness.
    it.skip("T-HIGH-1: applies multisig rotation after timelock (requires bankrun)", async () => {
      // 1. Propose new multisig
      // 2. Warp clock to timelock_until + 1
      // 3. Call applyMultisigChange (permissionless)
      // 4. Assert config.multisig === new multisig
    });
  });
});
