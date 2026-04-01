// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Association Syndaxia (Governance)

import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

export const TREASURY_PROGRAM_ID = new PublicKey(
  "D8H3JetPqdFasLXGbAqjhrrArfoYmy8PwQtt8KehZLxd"
);
export const TREASURY_CONFIG_SEED = "treasury-config";

export const FEE_BPS = new anchor.BN(500);            // 5%
export const DEAL_AMOUNT = new anchor.BN(1_000_000);
export const RELEASE_DELAY = new anchor.BN(0);
export const TIMEOUT = new anchor.BN(30 * 24 * 3600); // 30 days
export const DISPUTE_DELAY = new anchor.BN(0);
export const METADATA_HASH = new Array(32).fill(0xab);
