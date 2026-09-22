/**
 * Interactive CLI for a deployed SealedBid auction.
 *
 *   npm run cli                 # active network
 *   npm run cli -- --network preprod
 *
 * Reads use the indexer only. Writes (sealing, revealing, settling, cancelling)
 * go through the wallet, the proof server and the chain.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { WebSocket } from 'ws';
import * as Rx from 'rxjs';

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';

import { resolveNetwork, getOrCreateWallet, getDeployment } from './network.js';
import { createWallet, persistWalletState, unshieldedToken, type WalletContext } from './wallet.js';
import { createProviders } from './providers.js';
import { fetchAuctionState, formatAuction, fromHex } from './read-state.js';
import { compiledSealedBidContract, pureCircuits } from './sealed-bid.js';
import { bytesToHex, findOpening, listOpenings, randomNonce, saveOpening } from './openings.js';

// @ts-expect-error required for wallet sync in Node
globalThis.WebSocket = WebSocket;

async function syncWallet(walletCtx: WalletContext) {
  process.stdout.write('  Syncing wallet...\n');
  const startedAt = Date.now();
  const ticker = setInterval(() => {
    process.stdout.write(`\r  ⏳ syncing... ${Math.round((Date.now() - startedAt) / 1000)}s`);
  }, 5_000);
  try {
    return await walletCtx.wallet.waitForSyncedState();
  } finally {
    clearInterval(ticker);
    process.stdout.write('\r  ✓ synced.                                   \n');
  }
}

async function main(): Promise<void> {
  const { network, config } = resolveNetwork();
  const deployment = getDeployment(network);
  if (!deployment) {
    process.stderr.write(`\nNo deployment recorded for ${network}. Run: npm run deploy -- --network ${network}\n\n`);
    process.exit(1);
  }

  const contractAddress = deployment.address;
  const { seed } = getOrCreateWallet(network);

  process.stdout.write('\n════════════════════════════════════════════════════════════════\n');
  process.stdout.write(`  SealedBid CLI — ${network}\n`);
  process.stdout.write('════════════════════════════════════════════════════════════════\n\n');
  process.stdout.write(`  contract: ${contractAddress}\n\n`);

  const walletCtx = await createWallet({ network, networkConfig: config, seed });
  const state = await syncWallet(walletCtx);
  await persistWalletState(network, walletCtx);

  const address = walletCtx.unshieldedKeystore.getBech32Address().toString();
  const tNight = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
  const dust = state.dust.balance(new Date());
  process.stdout.write(`  wallet:   ${address}\n`);
  process.stdout.write(`  tNIGHT:   ${tNight.toLocaleString()}\n`);
  process.stdout.write(`  DUST:     ${dust.toLocaleString()}\n\n`);

  if (tNight === 0n && network !== 'undeployed' && config.faucet) {
    process.stdout.write(`  ⚠ No tNIGHT. Reads still work; writes need funds:\n     ${config.faucet}\n\n`);
  }

  const providers = await createProviders(walletCtx, config);
  const deployed: any = await findDeployedContract(providers as any, {
    compiledContract: compiledSealedBidContract as any,
    contractAddress,
    privateStateId: 'sealedBidPrivateState',
    initialPrivateState: {},
  });

  // The bidder identity the contract sees through `ownPublicKey()` is the
  // wallet's shielded coin public key.
  const bidderKey = state.shielded.coinPublicKey.toHexString().toLowerCase();

  async function showState(): Promise<void> {
    const snapshot = await fetchAuctionState(config, contractAddress);
    process.stdout.write('\n');
    if (!snapshot) {
      process.stdout.write('  No state found for this contract yet.\n\n');
      return;
    }
    process.stdout.write(`${formatAuction(snapshot)}\n\n`);
  }

  async function sealBid(rl: ReturnType<typeof createInterface>): Promise<void> {
    const amountRaw = await rl.question('  Bid amount (integer): ');
    const amount = BigInt(amountRaw.trim());

    const nonce = randomNonce();
    const commitment = pureCircuits.bidCommitment(amount, nonce);

    process.stdout.write('\n  Submitting sealed bid (proof generation takes ~30-60s)...\n');
    const tx = await deployed.callTx.commitBid(commitment);

    saveOpening({
      contractAddress,
      network,
      bidder: bidderKey,
      amount: amount.toString(),
      nonce: bytesToHex(nonce),
      commitment: bytesToHex(commitment),
      createdAt: new Date().toISOString(),
    });

    process.stdout.write(`\n  ✅ Sealed bid recorded\n`);
    process.stdout.write(`     commitment: ${bytesToHex(commitment)}\n`);
    process.stdout.write(`     tx:         ${tx.public.txId}\n`);
    process.stdout.write('     The nonce is saved locally in .sealedbid-openings.json (gitignored).\n');
    process.stdout.write('     Keep it — it is the only way to open this bid.\n\n');
  }

  async function revealBid(rl: ReturnType<typeof createInterface>): Promise<void> {
    const stored = findOpening(contractAddress, bidderKey);
    let amount: bigint;
    let nonce: Uint8Array;

    if (stored) {
      process.stdout.write(`  Found a stored opening for ${bidderKey}: amount ${stored.amount}\n`);
      const confirm = (await rl.question('  Use it? [Y/n]: ')).trim().toLowerCase();
      if (confirm === '' || confirm === 'y' || confirm === 'yes') {
        amount = BigInt(stored.amount);
        nonce = fromHex(stored.nonce);
      } else {
        amount = BigInt((await rl.question('  Bid amount (integer): ')).trim());
        nonce = fromHex((await rl.question('  Nonce (hex): ')).trim());
      }
    } else {
      amount = BigInt((await rl.question('  Bid amount (integer): ')).trim());
      nonce = fromHex((await rl.question('  Nonce (hex): ')).trim());
    }

    process.stdout.write('\n  Submitting reveal...\n');
    const tx = await deployed.callTx.revealBid(amount, nonce);
    process.stdout.write(`\n  ✅ Bid revealed: ${amount}\n     tx: ${tx.public.txId}\n\n`);
  }

  async function settle(): Promise<void> {
    process.stdout.write('\n  Settling auction...\n');
    const tx = await deployed.callTx.settle();
    process.stdout.write(`\n  ✅ Auction settled\n     tx: ${tx.public.txId}\n\n`);
  }

  async function cancel(): Promise<void> {
    process.stdout.write('\n  Cancelling auction...\n');
    const tx = await deployed.callTx.cancel();
    process.stdout.write(`\n  ✅ Auction cancelled\n     tx: ${tx.public.txId}\n\n`);
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    await showState();
    for (;;) {
      process.stdout.write('─── Menu ───────────────────────────────────────────────────────\n');
      process.stdout.write('  1. Show auction state\n');
      process.stdout.write('  2. Seal a bid\n');
      process.stdout.write('  3. Reveal a bid\n');
      process.stdout.write('  4. Settle the auction\n');
      process.stdout.write('  5. Cancel the auction (seller only)\n');
      process.stdout.write('  6. List locally stored openings\n');
      process.stdout.write('  7. Exit\n\n');

      const choice = (await rl.question('  Choice: ')).trim();
      try {
        switch (choice) {
          case '1':
            await showState();
            break;
          case '2':
            await sealBid(rl);
            break;
          case '3':
            await revealBid(rl);
            break;
          case '4':
            await settle();
            break;
          case '5':
            await cancel();
            break;
          case '6': {
            const all = listOpenings().filter((entry) => entry.contractAddress === contractAddress);
            process.stdout.write('\n');
            if (all.length === 0) process.stdout.write('  (none stored)\n');
            for (const entry of all) {
              process.stdout.write(`  ${entry.amount} @ ${entry.createdAt} nonce=${entry.nonce}\n`);
            }
            process.stdout.write('\n');
            break;
          }
          case '7':
            process.stdout.write('\n  Bye.\n\n');
            await persistWalletState(network, walletCtx);
            await walletCtx.wallet.stop();
            return;
          default:
            process.stdout.write('\n  Enter 1-7.\n\n');
        }
      } catch (err) {
        process.stdout.write(`\n  ❌ ${err instanceof Error ? err.message : String(err)}\n\n`);
      }
    }
  } finally {
    rl.close();
  }
}

main().catch(async (err) => {
  process.stderr.write(`\n❌ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
