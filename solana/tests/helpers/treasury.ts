// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Association Syndaxia (Governance)
//
// Treasury helper — initialises the singleton TreasuryConfig PDA.
//
// The treasury program is deployed to the test validator via [[test.genesis]]
// in Anchor.toml (pointing to ../syndaxia-treasury/target/deploy/).
// This file purposely does NOT use anchor.workspace.SyndaxiaTreasury — it
// constructs the Program from the IDL JSON so there is no source-code
// dependency on the treasury workspace.

import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createAccount, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { TREASURY_PROGRAM_ID, TREASURY_CONFIG_SEED } from "./constants";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TreasuryIdl = require("../../target/idl/syndaxia_treasury.json");

// Sets up the TreasuryConfig PDA and creates a token account owned by the
// treasury fee_receiver.  Called once per test suite in before().
export async function setupTreasury(
  provider: anchor.AnchorProvider,
  mint: PublicKey
): Promise<{ treasuryConfigPda: PublicKey; treasuryTokenAccount: PublicKey }> {
  const treasuryProgram = new anchor.Program(TreasuryIdl, provider);

  const [treasuryConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(TREASURY_CONFIG_SEED)],
    TREASURY_PROGRAM_ID
  );

  let feeReceiver: PublicKey;
  try {
    // Treasury already initialised (e.g. previous test suite ran first).
    const config = (await (treasuryProgram.account as any).treasuryConfig.fetch(
      treasuryConfigPda
    )) as any;
    feeReceiver = config.feeReceiver;
  } catch {
    // First call — initialise the singleton TreasuryConfig.
    const multisig = Keypair.generate();
    const feeReceiverKp = Keypair.generate();

    for (const kp of [multisig, feeReceiverKp]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    await treasuryProgram.methods
      .initialize(feeReceiverKp.publicKey)
      .accounts({ config: treasuryConfigPda, multisig: multisig.publicKey })
      .signers([multisig])
      .rpc();

    feeReceiver = feeReceiverKp.publicKey;
  }

  // Token account owned by the treasury config PDA; the core program validates this.
  const treasuryAta = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    (provider.wallet as anchor.Wallet).payer,
    mint,
    treasuryConfigPda,
    true // allowOwnerOffCurve — PDA is off-curve
  );
  const treasuryTokenAccount = treasuryAta.address;

  return { treasuryConfigPda, treasuryTokenAccount };
}
