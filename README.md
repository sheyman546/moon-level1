# SealedBid

**Privacy-preserving sealed-bid auctions on the [Midnight Network](https://midnight.network).**

Sellers list a lot with a reserve price; bidders commit to their bids without revealing them. During the entire bidding window the public ledger holds only a cryptographic *commitment* to each bid — nobody, including the seller, can see the amounts. When bidding closes, bidders open their commitments; the circuit proves each opening matches the sealed commitment, so a bid can never be changed after the deadline. The highest bid at or above the reserve wins.

This is the confidentiality problem public blockchains cannot solve: on a transparent chain, a sealed-bid auction is impossible, because every bid is visible the moment it is submitted. SealedBid uses Midnight's selective-disclosure model to keep bids private while keeping the *rules* and the *outcome* publicly verifiable.

---

## Table of contents

- [What it demonstrates](#what-it-demonstrates)
- [How it works](#how-it-works)
- [Contract reference](#contract-reference)
- [Repository layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Compilation](#compilation)
- [Testing](#testing)
- [Artifact generation and verification](#artifact-generation-and-verification)
- [Deployment](#deployment)
- [Deployed contract](#deployed-contract)
- [Operating an auction](#operating-an-auction)
- [Secrets and key hygiene](#secrets-and-key-hygiene)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## What it demonstrates

| Concept | Where it appears |
|---|---|
| Commitment schemes for confidentiality | `sealed-bid.compact` — `bidCommitment`, `persistentCommit` |
| Explicit disclosure (`disclose`) | Every ledger write; the compiler rejects anything else |
| Time-gated phases | `blockTimeLt` / `blockTimeGte` split bidding, reveal and settlement |
| Caller authentication | `ownPublicKey()` binds every write to the submitting wallet |
| Reserve-price enforcement | `settle` refuses unless a revealed bid met the reserve |
| Records with two keys | `commitments` (bidder → commitment) and `openings` (bidder → amount) |
| Testable, real circuits | `test/` runs the compiler's own output through the Compact runtime |

## How it works

```
        bidding window                    reveal window
  ├───────────────────────────┤├───────────────────────────┤├──────────►
  0                          10                            20       30  (minutes)

  commitBid(commitment)         revealBid(amount, nonce)     settle()
  ─────────────────────         ────────────────────────     ────────
  ledger stores ONLY            circuit recomputes the       winner and
  H(amount, nonce, domain)      commitment and compares     winningBid are
                                it with the sealed value    written publicly
```

1. **Seal.** A bidder picks an amount and a random 32-byte nonce, computes
   `commitment = persistentCommit({ amount, nonce }, "sealedbid:commitment:v1")`
   and calls `commitBid`. The ledger stores the commitment keyed by the bidder's
   coin public key. The amount never touches the chain.
2. **Reveal.** After the bidding deadline and before the reveal deadline, the
   bidder calls `revealBid(amount, nonce)`. The circuit recomputes the commitment
   and asserts it equals the sealed one — so the amount is *binding*. The amount
   is then published and, if it meets the reserve and beats the current leader,
   becomes the leading bid.
3. **Settle.** Once the reveal window closes, anyone may call `settle`. It
   succeeds only if a revealed bid met the reserve, and it writes the winner and
   the winning amount.

Ties go to whoever revealed first, because the leading bid is only replaced by a
*strictly greater* amount. A settled or cancelled auction is terminal.

## Contract reference

Source: [`contracts/sealed-bid.compact`](./contracts/sealed-bid.compact) — Compact language `0.23`, toolchain `0.31.1`, runtime `0.16.0`.

### Public ledger state

| Field | Type | Meaning |
|---|---|---|
| `seller` | `Bytes<32>` (sealed) | The deploying wallet's public key |
| `lot` | `Bytes<32>` (sealed) | Opaque lot reference |
| `reservePrice` | `Uint<64>` (sealed) | Minimum acceptable amount; must be > 0 |
| `biddingEndsAt` | `Uint<64>` (sealed) | Unix seconds when sealed bidding closes |
| `revealEndsAt` | `Uint<64>` (sealed) | Unix seconds when revealing closes |
| `status` | `AuctionStatus` | `ACTIVE`, `SETTLED` or `CANCELLED` |
| `commitments` | `Map<Bytes<32>, Bytes<32>>` | bidder → sealed commitment |
| `bidderCount` | `Counter` | Number of sealed bids |
| `openings` | `Map<Bytes<32>, Uint<64>>` | bidder → revealed amount |
| `highestBid` | `Uint<64>` | Leading amount at or above the reserve |
| `highestBidder` | `Bytes<32>` | Holder of `highestBid` |
| `winningBid` | `Uint<64>` | Set only by `settle` |
| `winner` | `Bytes<32>` | Set only by `settle` |

### Circuits

| Circuit | Type | Behaviour |
|---|---|---|
| `commitBid(commitment)` | impure, proved | Seals a bid. Rejects: not active, bidding closed, caller already sealed. |
| `revealBid(amount, nonce)` | impure, proved | Opens a bid. Rejects: not active, bidding open, reveal closed, no sealed bid, opening mismatch, already revealed. |
| `settle()` | impure, proved | Permissionless. Rejects: not active, reveal window open, reserve not met. |
| `cancel()` | impure, proved | Seller only, while active. |
| `bidCommitment(amount, nonce)` | **pure** | Returns the commitment for an opening — the exact value `commitBid` expects. |

## Repository layout

```
.
├── contracts/
│   ├── sealed-bid.compact          # the contract
│   └── managed/sealed-bid/         # compiler output (committed)
│       ├── contract/               #   TypeScript/JS bindings
│       ├── compiler/               #   contract-info.json
│       ├── keys/                   #   *.prover, *.verifier
│       └── zkir/                   #   *.zkir, *.bzkir
├── src/
│   ├── network.ts                  # endpoints, network selection, local state
│   ├── wallet.ts                   # wallet facade + sync-state caching
│   ├── wallet-state.ts             # on-disk sync-state format
│   ├── providers.ts                # midnight-js provider wiring
│   ├── sealed-bid.ts               # compiled contract handle
│   ├── read-state.ts               # indexer-backed auction reads
│   ├── openings.ts                 # local (off-chain) bid openings
│   ├── deploy.ts                   # deployment
│   ├── setup.ts                    # services + compile + deploy
│   ├── cli.ts                      # interactive auction client
│   ├── check-balance.ts            # wallet/balance report
│   └── wallet-address.ts           # funding address, no sync required
├── test/
│   ├── harness.ts                  # runs real circuits via the Compact runtime
│   ├── sealed-bid.test.ts          # behaviour, boundaries, failure modes
│   └── security.test.ts            # adversarial properties P1–P11
├── scripts/
│   ├── e2e-check.ts                # post-deployment verification
│   ├── verify-artifacts.mjs        # reproducibility check for managed/
│   └── clean.mjs                   # remove local state
├── docker-compose.yml              # proof server (+ local devnet)
└── .compact-version                # pinned toolchain: 0.31.1
```

## Prerequisites

| Requirement | Why | Check |
|---|---|---|
| **Node.js ≥ 22** | Runtime for every script | `node --version` |
| **Compact devtools + toolchain 0.31.1** | Compiles the contract | `compact compile --version` |
| **Docker + Compose v2** | Runs the proof server (and the optional local devnet) | `docker compose version` |
| **~2 GB free disk** | Proof server image + proving keys | — |

Install the Compact toolchain (the compiler itself is downloaded and pinned by
the devtools):

```bash
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh

# The installer places the binary outside the project; add it to PATH.
export PATH="$HOME/.local:$PATH"          # add this to ~/.bashrc to persist

# Install the toolchain this project pins (see .compact-version)
compact update 0.31.1
compact compile --version                 # -> 0.31.1
```

## Installation

```bash
git clone <this-repo> sealedbid
cd sealedbid
npm install
```

The committed `contracts/managed/` artifacts mean you can **build, typecheck and
test without the Compact compiler installed**. You only need the compiler to
regenerate them or to change the contract.

## Compilation

```bash
npm run compile
# > compact compile contracts/sealed-bid.compact contracts/managed/sealed-bid
# Compiling 4 circuits:
```

Expected output — real artifacts, written to `contracts/managed/sealed-bid/`:

```
contract/index.js          contract/index.d.ts      compiler/contract-info.json
keys/{commitBid,revealBid,settle,cancel}.prover
keys/{commitBid,revealBid,settle,cancel}.verifier
zkir/{commitBid,revealBid,settle,cancel}.{zkir,bzkir}
```

## Testing

```bash
npm test
```

```
 ✓ test/sealed-bid.test.ts (51 tests)
 ✓ test/security.test.ts (24 tests)
   Tests  75 passed (75)
```

The suite is **not** a re-implementation of the contract. `test/harness.ts`
loads the compiler's emitted JavaScript through `@midnight-ntwrk/compact-runtime`
and drives the real circuits, so every assertion, ledger operation and hashing
rule under test is the one that executes in a transaction. Each "caller" is
modelled by the coin public key handed to the circuit context — exactly what
`ownPublicKey()` resolves to on-chain.

Coverage:

- **Constructor** — configuration capture, seller binding, and rejection of a
  zero reserve and of an inverted reveal window.
- **`bidCommitment`** — 32-byte output, determinism, sensitivity to amount and
  nonce, and non-equality with the plaintext amount.
- **`commitBid`** — success, secrecy of the amount, permissionless access, one
  bid per identity, deadline boundaries, and rejection after cancel/settle.
- **`revealBid`** — success, both deadline boundaries, binding failures (changed
  amount, wrong nonce), unknown bidder, double reveal, below-reserve handling,
  reserve boundary, tie-breaking, and cancellation.
- **`settle` / `cancel`** — window gating, reserve enforcement, permissionless
  settlement, terminality, and seller-only cancellation.
- **Lifecycle** — contested multi-bidder auctions, non-revealing bidders, and
  unrevealed-only auctions.
- **Security (P1–P11)** — bid secrecy, commitment hiding and unsearchability,
  binding after the deadline, commitment reuse, caller binding, privilege
  escalation, reserve bypass, phase skipping, atomicity of rejected calls, and
  outcome determinism.

Run one file or one case:

```bash
npx vitest run test/security.test.ts
npx vitest run -t "reserve cannot be bypassed"
```

## Artifact generation and verification

`contracts/managed/` is generated by the official compiler and **committed**, so
the project is reproducible without a toolchain. `scripts/verify-artifacts.mjs`
proves the committed artifacts are genuine and current: it recompiles into a
scratch directory and compares every generated file with what is in the repo.

```bash
npm run verify:artifacts
#   ✅ 20 artifacts match a fresh compile
#      toolchain: 0.31.1
```

Bindings, circuit IR and proving/verifier keys are compared byte-for-byte. The
one normalisation is the `sourceRoot` field of `contract/index.js.map`, which the
compiler derives from the output directory's depth rather than from the program.

Run every check at once:

```bash
npm run verify     # compile + typecheck + tests + artifact reproducibility
```

## Deployment

Deployment is driven by `npm run deploy`, which is idempotent and reproducible:
it derives the auction shape from the environment, syncs the wallet, waits for
faucet funds and DUST on public networks, then submits the deployment.

### Local devnet (no funds needed)

```bash
npm run setup      # docker compose up + compile + deploy
```

### Preview or Preprod

#### Step 1 — Get your wallet address

The funding address is derived from your wallet and printed with a dedicated
command (no sync, no funds, no proof server needed):

```bash
npm run wallet:address -- --network preprod
```

```
  Network:            preprod
  Unshielded address: mn_addr_preprod1…
  Faucet:             https://midnight-tmnight-preprod.nethermind.dev
```

Copy the `mn_addr_preprod1…` line — that is the address you fund.

Where it lives in the project:

| What | Where |
|---|---|
| Command that prints the address | `src/wallet-address.ts` (`npm run wallet:address`) |
| Wallet seed + recovery phrase | `.midnight-state.json` → `wallets.preprod` (gitignored, mode `0600`) |
| Generation / persistence logic | `src/network.ts` → `getOrCreateWallet()` |

The first run generates a 24-word phrase, derives the address from it and
persists both in `.midnight-state.json`. Every later run re-derives the **same**
address. Back the phrase up with `npm run wallet:address -- --show-mnemonic`.

#### Step 2 — Request test tokens (tNIGHT)

1. Open the faucet for your network:
   - Preprod: <https://midnight-tmnight-preprod.nethermind.dev>
   - Preview: <https://midnight-tmnight-preview.nethermind.dev>
2. Paste the `mn_addr_preprod1…` address into the faucet's recipient field.
3. Submit the request (a captcha may be shown). tNIGHT is the testnet token —
   it has no value and only pays transaction fees.
4. Tokens usually arrive within a minute or two. Check with:

```bash
npm run check-balance -- --network preprod
```

#### Step 3 — Deploy

```bash
# Start the proof server (required on every network)
npm run proof-server:start

# Deploy. It waits for tNIGHT, registers NIGHT for DUST, then submits.
npm run deploy -- --network preprod

# Verify the deployment end to end
npm run test:e2e -- --network preprod
```

Switching networks:

```bash
npm run network preprod      # remember the active network
npm run network preview
npm run network              # print the active network and last deployment
```

Auction parameters (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `SEALEDBID_LOT_REF` | `lot:rusty-lantern` | Lot reference, max 32 bytes |
| `SEALEDBID_RESERVE` | `100` | Reserve price, must be > 0 |
| `SEALEDBID_BIDDING_MINUTES` | `10` | Sealed-bidding window length |
| `SEALEDBID_REVEAL_MINUTES` | `10` | Reveal window length |
| `MIDNIGHT_FAUCET_TIMEOUT_MS` | `600000` | How long to wait for the faucet |

The deployment address and deployer are written to `.midnight-state.json`
(gitignored) and surfaced by `npm run test:e2e`.

## Deployed contract

| | |
|---|---|
| **Network** | Midnight Preprod |
| **Funding address (unshielded)** | `mn_addr_preprod19q06h059k4c2j96m39005thgekpryeqag30vsfjzdc4zjtdjylzsg7wcv2` |
| **Preview funding address (unshielded)** | `mn_addr_preview1dke5v8z7uaxfu6sp2v0pwqpn0qa8m6lqqjqrhk3ptkn8pfe3nh3sklljdz` |
| **Contract address** | *recorded after the deployment below* |
| **Deployer (unshielded)** | *recorded after the deployment below* |
| **Verification** | `npm run test:e2e -- --network preprod` (see below) |

The address above is written by the deployment itself and independently
re-checked by `npm run test:e2e`, which reconnects to the contract through the
indexer, decodes its public ledger state, and asserts the decoded auction is
self-consistent (reserve positive, windows ordered, bidder count matching the
stored commitments, no winner on an active auction, no settlement below the
reserve).

## Operating an auction

```bash
npm run cli -- --network preprod
```

```
  1. Show auction state          # reads the indexer; no wallet funds needed
  2. Seal a bid                  # generates a nonce, stores the opening locally
  3. Reveal a bid                # uses the stored opening, or asks for one
  4. Settle the auction          # permissionless after the reveal window
  5. Cancel the auction          # seller only
  6. List locally stored openings
  7. Exit
```

Sealing stores `(amount, nonce)` in `.sealedbid-openings.json` (gitignored,
mode `0600`). That file is the only way to open the bid — back it up, and never
share it before the reveal.

Read-only inspection works without funds and without a proof server:

```bash
npm run check-balance -- --network preprod
```

## Secrets and key hygiene

Nothing secret is committed. Excluded by `.gitignore`:

| Path | Contains |
|---|---|
| `.env` | any credentials you set |
| `.midnight-state.json` | wallet seed and 24-word recovery phrase, deployment records |
| `.midnight-wallet-state/` | cached wallet sync state |
| `.sealedbid-openings.json` | sealed bid amounts and nonces |

Generated secret files are written with owner-only permissions (`0600`) and
atomically. To supply your own wallet instead of generating one, set
`MIDNIGHT_WALLET_MNEMONIC` (a BIP-39 phrase) or `MIDNIGHT_WALLET_SEED` (hex); the
scripts prefer those and never persist them beyond your shell.

Guardrails:

- No private key, seed or mnemonic appears anywhere in the repository, in a
  commit, or in any deployment script's source.
- `contracts/managed/` contains only public proving/verifier keys and circuit IR.
- `.env.example` documents every variable with placeholder values only.

To report a security issue rather than opening a public issue, contact the
maintainers directly.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `compact: command not found` | devtools not on PATH | `export PATH="$HOME/.local:$PATH"` |
| `language version ... mismatch` | wrong toolchain | `compact update 0.31.1` (see `.compact-version`) |
| `Compiled contract not found` | artifacts missing | `npm run compile` |
| `Artifact mismatch against a fresh compile` | contract changed without recompiling | `npm run compile` |
| `ECONNREFUSED 127.0.0.1:6300` | proof server not running | `npm run proof-server:start` |
| Deployment waits forever on funding | faucet not used yet | `npm run wallet:address -- --network preprod`, then fund it |
| `reserve price was not met` | no revealed bid reached the reserve | reveal a qualifying bid, or start a new auction |
| `bidding window has closed` | past `biddingEndsAt` | the next sealed bid needs a new auction |
| `opening does not match the sealed commitment` | wrong amount or nonce | use the entry in `.sealedbid-openings.json` |
| `caller has already sealed a bid` | one sealed bid per wallet | deploy a fresh auction, or bid from another wallet |
| `not enough DUST after 20 attempts` | NIGHT not registered / not funded | `npm run check-balance -- --network preprod` |
| Wallet shows 0 after funding | sync still in progress | re-run `npm run check-balance`; it resumes from cached state |
| Tests fail with `Cannot find module` | artifacts missing | `npm run compile` |
| Want to start over | stale local state | `npm run clean` (add `--all` to drop `contracts/managed/`) |

## License

[MIT](./LICENSE) — built on the [Midnight Network](https://midnight.network).
