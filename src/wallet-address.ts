/**
 * Print the funding addresses for the project wallet.
 *
 * This is deliberately sync-free: the unshielded address used to request
 * testnet tokens is derived directly from the seed, so it can be produced in
 * milliseconds — before (or during) a multi-minute chain sync.
 *
 * Usage:
 *   npm run wallet:address                 # active network from .midnight-state.json
 *   npm run wallet:address -- --network preprod
 */

import { Buffer } from 'buffer';

import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { HDWallet, Roles, createKeystore } from '@midnight-ntwrk/wallet-sdk';

import { resolveNetwork, getOrCreateWallet, type NetworkId } from './network.js';

function cliMain(): number {
  const { network, config } = resolveNetwork();
  const credentials = getOrCreateWallet(network);

  setNetworkId(config.networkId);
  const networkId = getNetworkId();

  const hdWallet = HDWallet.fromSeed(Buffer.from(credentials.seed, 'hex'));
  if (hdWallet.type !== 'seedOk') throw new Error('Invalid wallet seed');
  const derived = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (derived.type !== 'keysDerived') throw new Error('Key derivation failed');
  hdWallet.hdWallet.clear();

  const keystore = createKeystore(derived.keys[Roles.NightExternal], networkId);
  const unshieldedAddress = keystore.getBech32Address().toString();

  process.stdout.write(`\n  Network:            ${network}\n`);
  process.stdout.write(`  Unshielded address: ${unshieldedAddress}\n`);
  if (config.faucet) {
    process.stdout.write(`  Faucet:             ${config.faucet}\n`);
    process.stdout.write(`\n  Request tNIGHT for the unshielded address above, then run:\n`);
    process.stdout.write(`    npm run check-balance -- --network ${network}\n\n`);
  } else {
    process.stdout.write(`  (local devnet — the genesis seed is pre-funded)\n\n`);
  }

  if (credentials.created) {
    process.stdout.write(
      `  A new wallet was generated and saved to .midnight-state.json (gitignored, owner-only).\n` +
        `  Back up its recovery phrase with: npm run wallet:address -- --show-mnemonic\n\n`,
    );
  }
  return 0;
}

function showMnemonic(network: NetworkId): number {
  const credentials = getOrCreateWallet(network);
  if (!credentials.mnemonic) {
    process.stdout.write(`No recovery phrase on file for ${network} (seed was supplied via env or is the genesis seed).\n`);
    return 1;
  }
  process.stdout.write(`\n  ${network} recovery phrase (keep this secret):\n\n    ${credentials.mnemonic}\n\n`);
  return 0;
}

try {
  const argv = process.argv;
  if (argv.includes('--show-mnemonic')) {
    const { network } = resolveNetwork();
    process.exit(showMnemonic(network));
  }
  process.exit(cliMain());
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
}
