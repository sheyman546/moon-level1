/**
 * Report the project wallet's addresses and balances on the active network.
 *
 *   npm run check-balance
 *   npm run check-balance -- --network preprod
 */

import { WebSocket } from 'ws';
import * as Rx from 'rxjs';

import { resolveNetwork, getOrCreateWallet } from './network.js';
import { createWallet, persistWalletState, unshieldedToken } from './wallet.js';

// @ts-expect-error required for wallet sync in Node
globalThis.WebSocket = WebSocket;

async function main(): Promise<void> {
  const { network, config } = resolveNetwork();
  const { seed } = getOrCreateWallet(network);

  process.stdout.write(`\n  Network: ${network}\n`);
  process.stdout.write('  Building wallet and syncing...\n');
  process.stdout.write('  (this can take a few minutes on a public network the first time)\n\n');

  const walletCtx = await createWallet({ network, networkConfig: config, seed });
  const startedAt = Date.now();
  const ticker = setInterval(() => {
    process.stdout.write(`\r  ⏳ syncing... ${Math.round((Date.now() - startedAt) / 1000)}s`);
  }, 5_000);

  let state;
  try {
    state = await walletCtx.wallet.waitForSyncedState();
  } finally {
    clearInterval(ticker);
    process.stdout.write('\r  ✓ synced.                                   \n');
  }

  const address = walletCtx.unshieldedKeystore.getBech32Address().toString();
  const tNight = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
  const dust = state.dust.balance(new Date());

  process.stdout.write(`\n  Unshielded address: ${address}\n`);
  process.stdout.write(`  tNIGHT:             ${tNight.toLocaleString()}\n`);
  process.stdout.write(`  DUST:               ${dust.toLocaleString()}\n\n`);

  if (tNight === 0n) {
    if (network === 'undeployed') {
      process.stdout.write('  ⚠ No tNIGHT. Start the local devnet (npm run setup); the genesis seed is pre-funded.\n\n');
    } else {
      process.stdout.write(`  ⚠ No tNIGHT. Fund the address above from the faucet:\n     ${config.faucet}\n\n`);
    }
  } else {
    process.stdout.write('  ✓ Funded and ready to deploy.\n\n');
  }

  await persistWalletState(network, walletCtx);
  await walletCtx.wallet.stop();
}

main().catch((err) => {
  process.stderr.write(`\n❌ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
