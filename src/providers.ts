/**
 * midnight-js provider wiring: wallet, indexer, proof server, private state.
 */

import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';

import type { NetworkConfig } from './network.js';
import type { WalletContext } from './wallet.js';
import { PRIVATE_STATE_ID, ZK_CONFIG_PATH } from './sealed-bid.js';

const PRIVATE_STATE_STORE_NAME = 'sealed-bid-state';

/**
 * The SDK requires at least 16 characters. This placeholder is fine for the
 * local devnet; set PRIVATE_STATE_PASSWORD before using a public network.
 */
function privateStatePassword(): string {
  return process.env.PRIVATE_STATE_PASSWORD?.trim() || 'Local-Devnet-Development-Placeholder-1';
}

/**
 * Build the provider bundle used by `deployContract`, `findDeployedContract`
 * and the read paths.
 */
export async function createProviders(
  walletCtx: WalletContext,
  networkConfig: NetworkConfig,
  // A proof server is only needed for writes; read-only callers can skip it.
  opts: { readOnly?: boolean } = {},
) {
  const walletProvider = {
    // Midnight.js 4.1.x returns key objects (CoinPublicKey / EncPublicKey)
    // rather than the hex strings earlier releases returned.
    getCoinPublicKey: () => walletCtx.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => walletCtx.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: any, ttl?: Date) {
      if (opts.readOnly) throw new Error('this provider bundle is read-only');
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: walletCtx.shieldedSecretKeys, dustSecretKey: walletCtx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      return walletCtx.wallet.finalizeRecipe(recipe);
    },
    submitTx(tx: any) {
      if (opts.readOnly) throw new Error('this provider bundle is read-only');
      return walletCtx.wallet.submitTransaction(tx) as any;
    },
  };

  const zkConfigProvider = new NodeZkConfigProvider(ZK_CONFIG_PATH);
  const accountId = walletCtx.unshieldedKeystore.getBech32Address().toString();

  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: PRIVATE_STATE_STORE_NAME,
      accountId,
      privateStoragePasswordProvider: privateStatePassword,
    }),
    publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };
}

/** Poll the proof server until it answers, or give up. */
export async function waitForProofServer(proofServer: string, maxAttempts = 60, delayMs = 2_000): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fetch(proofServer, { method: 'GET', signal: AbortSignal.timeout(3_000) });
      return true;
    } catch (err: any) {
      const code = err?.cause?.code || err?.code || '';
      // Any answer that is not a connection failure counts as "up".
      if (code !== 'ECONNREFUSED' && code !== 'UND_ERR_CONNECT_TIMEOUT' && code !== 'UND_ERR_SOCKET') return true;
    }
    if (attempt < maxAttempts) {
      process.stdout.write(`\r  Waiting for proof server at ${proofServer}... (${attempt}/${maxAttempts})   `);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

export { PRIVATE_STATE_ID };
