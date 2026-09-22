/**
 * Deploy SealedBid to a Midnight network.
 *
 * The auction parameters are reproducible: this script creates an auction whose
 * bidding window opens at the deployment timestamp and whose positive-integer
 * reserve and window lengths come from the environment, so the same command
 * yields the same auction shape every time.
 *
 *   npm run deploy                                   # local devnet
 *   npm run deploy -- --network preprod
 *   npm run deploy -- --network preview
 *
 * Configuration (all optional):
 *   SEALEDBID_LOT_REF          lot reference string, max 32 bytes
 *   SEALEDBID_RESERVE          integer reserve price, > 0        (default 100)
 *   SEALEDBID_BIDDING_MINUTES  sealed-bidding window length      (default 10)
 *   SEALEDBID_REVEAL_MINUTES   reveal window length              (default 10)
 *   MIDNIGHT_FAUCET_TIMEOUT_MS how long to wait for the faucet   (default 600000)
 */

import { WebSocket } from 'ws';
import * as Rx from 'rxjs';

import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';

import { resolveNetwork, getOrCreateWallet, recordDeployment } from './network.js';
import { createWallet, persistWalletState, unshieldedToken, type WalletContext } from './wallet.js';
import { createProviders, waitForProofServer } from './providers.js';
import { compiledSealedBidContract, toBytes32 } from './sealed-bid.js';

// Wallet sync opens GraphQL subscriptions over WebSocket.
// @ts-expect-error required for wallet sync in Node
globalThis.WebSocket = WebSocket;

/** Upper bound on waiting for DUST; beyond this something else is wrong. */
const DUST_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

// ─── Auction parameters ───────────────────────────────────────────────────────

const LOT_REF = process.env.SEALEDBID_LOT_REF?.trim() || 'lot:rusty-lantern';

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer (received: ${raw})`);
  }
  return value;
}

const RESERVE = BigInt(positiveInt('SEALEDBID_RESERVE', 100));
const BIDDING_MINUTES = positiveInt('SEALEDBID_BIDDING_MINUTES', 10);
const REVEAL_MINUTES = positiveInt('SEALEDBID_REVEAL_MINUTES', 10);

const { network, config: networkConfig } = resolveNetwork();
const WALLET = getOrCreateWallet(network);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function banner(title: string): void {
  process.stdout.write('\n════════════════════════════════════════════════════════════════\n');
  process.stdout.write(`  ${title}\n`);
  process.stdout.write('════════════════════════════════════════════════════════════════\n\n');
}

async function waitForSync(walletCtx: WalletContext) {
  process.stdout.write('  Syncing with network (this can take several minutes; RPC reconnects are normal)...\n');
  const startedAt = Date.now();
  const ticker = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    process.stdout.write(`\r  ⏳ syncing... ${elapsed}s`);
  }, 5_000);
  try {
    return await walletCtx.wallet.waitForSyncedState();
  } finally {
    clearInterval(ticker);
    process.stdout.write('\r  ✓ synced with network.                                        \n');
  }
}

/** Wait for the faucet to fund the wallet on a public network. */
async function waitForFunding(walletCtx: WalletContext, address: string): Promise<void> {
  const state = await Rx.firstValueFrom(walletCtx.wallet.state().pipe(Rx.filter((s) => s.isSynced)));
  if ((state.unshielded.balances[unshieldedToken().raw] ?? 0n) > 0n) return;

  process.stdout.write('\n─── Fund the wallet ────────────────────────────────────────────\n\n');
  process.stdout.write(`  Unshielded address: ${address}\n`);
  process.stdout.write(`  Faucet:             ${networkConfig.faucet}\n\n`);
  process.stdout.write('  Waiting for tNIGHT to arrive (polling every 10s)...\n');

  const rawTimeout = Number(process.env.MIDNIGHT_FAUCET_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 600_000;
  const startedAt = Date.now();

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    const current = await Rx.firstValueFrom(walletCtx.wallet.state().pipe(Rx.filter((s) => s.isSynced)));
    const balance = current.unshielded.balances[unshieldedToken().raw] ?? 0n;
    if (balance > 0n) {
      process.stdout.write(`\n  ✓ funded: ${balance.toLocaleString()} tNIGHT\n\n`);
      return;
    }
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `no tNIGHT received within ${Math.round(timeoutMs / 60_000)} min.\n` +
          `  Address: ${address}\n  Faucet:  ${networkConfig.faucet}\n` +
          '  Your wallet is saved — re-run `npm run deploy` after funding.',
      );
    }
    process.stdout.write(`\r  ...still waiting (${elapsed}s)`);
  }
}

/** Register NIGHT UTXOs for DUST generation and wait until DUST exists. */
async function ensureDust(walletCtx: WalletContext): Promise<void> {
  process.stdout.write('─── DUST setup ─────────────────────────────────────────────────\n\n');
  const state = await Rx.firstValueFrom(walletCtx.wallet.state().pipe(Rx.filter((s) => s.isSynced)));

  const unregistered = state.unshielded.availableCoins.filter((coin: any) => !coin.meta?.registeredForDustGeneration);
  if (unregistered.length > 0) {
    process.stdout.write(`  Registering ${unregistered.length} NIGHT UTXO(s) for DUST generation...\n`);
    // The sign callback already produces a signature per input; signing again
    // would produce a length mismatch the chain rejects.
    const recipe = await walletCtx.wallet.registerNightUtxosForDustGeneration(
      unregistered,
      walletCtx.unshieldedKeystore.getPublicKey(),
      (payload) => walletCtx.unshieldedKeystore.signData(payload),
    );
    const finalized = await walletCtx.wallet.finalizeRecipe(recipe);
    await walletCtx.wallet.submitTransaction(finalized);
  }

  if (state.dust.balance(new Date()) > 0n) {
    process.stdout.write('  ✓ DUST available\n\n');
    return;
  }

  process.stdout.write('  Waiting for DUST to generate...\n');
  try {
    await Rx.firstValueFrom(
      walletCtx.wallet.state().pipe(
        Rx.throttleTime(5_000),
        Rx.filter((s) => s.isSynced),
        Rx.filter((s) => s.dust.balance(new Date()) > 0n),
        Rx.timeout({ first: DUST_WAIT_TIMEOUT_MS }),
      ),
    );
  } catch {
    throw new Error(
      `no DUST generated within ${Math.round(DUST_WAIT_TIMEOUT_MS / 60_000)} min.\n` +
        '  DUST pays transaction fees and is generated by registered NIGHT.\n' +
        (network === 'undeployed'
          ? '  Check the devnet is producing blocks: docker compose ps'
          : `  Check the ${network} faucet funded this wallet: npm run check-balance`),
    );
  }
  process.stdout.write('  ✓ DUST available\n\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  banner(`Deploy SealedBid to ${network}`);

  const lotRef = toBytes32(LOT_REF);
  const biddingEndsAt = BigInt(Math.floor(Date.now() / 1000) + BIDDING_MINUTES * 60);
  const revealEndsAt = biddingEndsAt + BigInt(REVEAL_MINUTES * 60);

  process.stdout.write('  Auction parameters\n');
  process.stdout.write(`    lot reference : ${LOT_REF}\n`);
  process.stdout.write(`    reserve price : ${RESERVE}\n`);
  process.stdout.write(`    bidding closes: ${new Date(Number(biddingEndsAt) * 1000).toISOString()}\n`);
  process.stdout.write(`    reveal closes : ${new Date(Number(revealEndsAt) * 1000).toISOString()}\n\n`);

  const walletCtx = await createWallet({ network, networkConfig, seed: WALLET.seed });
  const restored = Object.values(walletCtx.restored).filter(Boolean).length;
  if (restored > 0) process.stdout.write(`  Restored ${restored}/3 child wallets from cached sync state.\n`);

  await waitForSync(walletCtx);
  // Persist immediately so a later failure does not throw the sync work away.
  await persistWalletState(network, walletCtx);

  const address = walletCtx.unshieldedKeystore.getBech32Address().toString();
  const state = await Rx.firstValueFrom(walletCtx.wallet.state().pipe(Rx.filter((s) => s.isSynced)));
  process.stdout.write(`  Wallet:  ${address}\n`);
  process.stdout.write(`  tNIGHT:  ${(state.unshielded.balances[unshieldedToken().raw] ?? 0n).toLocaleString()}\n\n`);

  if (network !== 'undeployed') await waitForFunding(walletCtx, address);
  await ensureDust(walletCtx);

  process.stdout.write('  Checking proof server...\n');
  if (!(await waitForProofServer(networkConfig.proofServer))) {
    throw new Error(`proof server not reachable at ${networkConfig.proofServer}. Start it with: npm run proof-server:start`);
  }
  process.stdout.write('  ✓ proof server ready\n\n');

  const providers = await createProviders(walletCtx, networkConfig);

  // DUST is a time projection: the tx builder can only spend what the next
  // block's timestamp accounts for, so give it a moment to catch up.
  await new Promise((resolve) => setTimeout(resolve, 6_000));

  process.stdout.write('  Deploying contract...\n');
  const MAX_ATTEMPTS = 20;
  const RETRY_DELAY_MS = 5_000;
  let deployed: Awaited<ReturnType<typeof deployContract>> | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      deployed = await deployContract(providers as any, {
        compiledContract: compiledSealedBidContract as any,
        args: [lotRef, RESERVE, biddingEndsAt, revealEndsAt],
        privateStateId: 'sealedBidPrivateState',
        initialPrivateState: {},
      } as any);
      break;
    } catch (err: any) {
      const message = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`;
      const dustShortage =
        message.includes('Not enough Dust') ||
        message.includes('Insufficient Funds') ||
        message.includes('could not balance dust');

      if (!dustShortage) throw err;

      if (attempt === 1) {
        process.stdout.write(`  Still generating DUST, retrying in ${RETRY_DELAY_MS / 1000}s...\n`);
      } else if (attempt >= MAX_ATTEMPTS) {
        throw new Error(`not enough DUST after ${MAX_ATTEMPTS} attempts`);
      } else {
        const current = await walletCtx.wallet.waitForSyncedState();
        process.stdout.write(
          `  ⏳ DUST: ${current.dust.balance(new Date()).toLocaleString()} (attempt ${attempt}/${MAX_ATTEMPTS})\n`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }

  if (!deployed) throw new Error('deployment failed after all retries');

  const contractAddress = deployed.deployTxData.public.contractAddress;
  recordDeployment(network, contractAddress, address);

  process.stdout.write('\n  ✅ Contract deployed\n\n');
  process.stdout.write(`    contract address: ${contractAddress}\n`);
  process.stdout.write(`    network:          ${network}\n`);
  process.stdout.write(`    deployer:         ${address}\n`);
  process.stdout.write(`    recorded in:      .midnight-state.json (gitignored)\n\n`);

  await persistWalletState(network, walletCtx);
  await walletCtx.wallet.stop();
  process.stdout.write(`  Inspect it with: npm run cli -- --network ${network}\n\n`);
}

main().catch((err) => {
  process.stderr.write(`\n❌ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
