# Syndaxia Protocol

Syndaxia is a decentralized escrow protocol implemented for Solana. It provides a trustless, immutable infrastructure for peer-to-peer and business-to-business commerce without intermediaries. The protocol features permissionless market creation, oracle-agnostic validation, and a suite of settlement mechanisms including manual release, refunds, dispute resolution, and expiration-based recovery. Syndaxia is designed as a simple, immutable, and governance-minimized base layer enabling secure transactions with minimal operational overhead.

## Key Features

- **Decentralized & Non-Custodial**: Funds are held in autonomous escrow contracts, never under control of a central authority.
- **Immutable Deal Architecture**: Each deal is autonomous and immutable; all parameters are set at creation and cannot be changed.
- **Flexible Settlement**: Support for single-tranche releases, multi-milestone deals, and permissionless dispute resolution.
- **Sustainable Fee Structure**: Dual-rail model with marketplace fees and governance-managed protocol fees (capped at 0.2%) that fund Association operations.
- **Stateless Design**: No global configuration or shared state; each deal operates independently.
- **Extensible Integration**: Simple on-chain interface allowing marketplaces, stablecoins, and validation oracles to compose freely.

## Dual-Rail Fee Model

Syndaxia employs a dual-fee structure that separates marketplace economics from protocol sustainability:

### Marketplace Fees (`fee_bps`)
- **Set by**: Each marketplace at deal creation
- **Maximum**: 10% (1,000 basis points)
- **Recipient**: Marketplace's `fee_collector` account
- **Charged to**: Buyer, on top of the deal amount
- **Purpose**: Marketplace revenue model (optional; can be set to 0%)

### Protocol Fees (`protocol_fee_bps`)
- **Set by**: Syndaxia Association governance via `syndaxia-treasury`
- **Maximum**: 20 basis points (0.2% hard-capped in the core program)
- **Recipient**: Syndaxia Treasury PDA, managed by the Association
- **Charged to**: Buyer, cumulative with marketplace fees
- **Current Rate**: 5 basis points (0.05%) at launch
- **Governance**: 7-day timelock before any fee rate change takes effect

## Whitepaper

The protocol is described in detail in the [Syndaxia Protocol Documentation](./docs/CONTRACT.md). Additional architectural and strategic notes can be found in the [docs](./docs) directory.

## Repository Structure

- [`solana/programs/syndaxia-core/`](./solana/programs/syndaxia-core) — Core Solana Anchor program: escrow lifecycle, milestones, dispute resolution.

- [`solana/programs/syndaxia-treasury/`](./solana/programs/syndaxia-treasury) — Treasury governance program: protocol fee rate and recipient with 7-day timelock.

- [`solana/tests/`](./solana/tests) — Integration tests written in TypeScript/Mocha.

- [`docs/`](./docs) — Technical documentation: [protocol reference](./docs/protocol.md), [security audit](./docs/SECURITY_AUDIT.md), [architecture guide](./docs/architecture.md), [whitepaper](./docs/whitepaper.md).

## Developers

### Building

Requirements:
- [Anchor](https://www.anchor-lang.com/) >= 0.32.0
- [Rust](https://www.rust-lang.org/) >= 1.70
- [Node.js](https://nodejs.org/) >= 18

Building the program:

```bash
anchor build
```

### Testing

Run the full test suite:

```bash
anchor test
```

The test suite includes integration scenarios for deal creation, settlement, disputes, and expiration. Tests run against a local Solana validator and use the treasury program as a supporting dependency.

### Code Quality

Format code with Prettier:

```bash
npm run lint:fix
```

Check formatting:

```bash
npm run lint
```

## Program Details

| Program | Program ID (mainnet) |
|---------|---------------------|
| `syndaxia-core` | `ACFJxibNyTnVJVNTaYgBSi5YoFK3qy3xPqvmVmKynAC1` |
| `syndaxia-treasury` | `DvoZj1cKMi8DEvTxBgNEnj9Fhxx9PRAsVTEWEZ2e6YHx` |

**Framework**: Anchor 0.32.0  
**Network**: Solana (localnet / devnet / mainnet)

## Governance & Licensing

Syndaxia is governed by the **Syndaxia Association** (a French non-profit organization) with commercial rights held by **Satflows SAS**.

- **Intellectual Property**: Held by Syndaxia Association; protocol is open-source.
- **Governance Token**: $SDX (issued by the Association) governs protocol parameters and oracle selection.
- **Tokenomics**: Utility via fee reduction, voting rights, and user rewards.

## Audits

Security audits and formal reviews are stored in the [`docs/SECURITY_AUDIT.md`](./docs/SECURITY_AUDIT.md) file.

## License

Files in this repository are publicly available under the `BUSL-1.1` license, with commercial rights reserved to **Satflows SAS** for proprietary implementations. See the [`LICENSE`](./LICENSE) file for full terms.

The protocol itself (as defined in the smart contracts) is governed by the Syndaxia Association and may transition to an open-source license following the DAO's governance vote.

## Additional Resources

- [Protocol Reference](./docs/protocol.md)
- [Architecture Guide](./docs/architecture.md)
- [Whitepaper](./docs/whitepaper.md)
- [Security Audit](./docs/SECURITY_AUDIT.md)
- [Syndaxia Association Website](https://syndaxia.org)
- [Support & Integration](https://satflows.fr)

## Contributing

Contributions are welcome. Please follow the formatting guidelines (Prettier) and submit pull requests against the main branch. Major changes should be discussed with the core team and Syndaxia Association.

---

**Syndaxia Protocol** © 2026 Syndaxia Association & Satflows SAS. All rights reserved.
