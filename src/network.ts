/**
 * Network configuration and local state.
 *
 * All network endpoints live here so scripts never hard-code them. Local state
 * (wallet credentials + the last deployment) is written to
 * `.midnight-state.json`, which is gitignored and created with owner-only
 * permissions because it holds wallet secrets.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Buffer } from 'node:buffer';

import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

export type NetworkId = 'undeployed' | 'preview' | 'preprod';

export const NETWORK_IDS: readonly NetworkId[] = ['undeployed', 'preview', 'preprod'] as const;

export interface NetworkConfig {
  networkId: NetworkId;
  indexer: string;
  indexerWS: string;
  node: string;
  proofServer: string;
  faucet: string | null;
  /** docker compose services required for this network. */
  composeServices: string[];
}

export interface DeploymentRecord {
  address: string;
  deployedAt: string;
  deployer: string;
}

export interface WalletRecord {
  seed: string;
  /** BIP-39 recovery phrase, when known. */
  mnemonic?: string;
  createdAt: string;
}

export interface NetworkState {
  version: 1;
  activeNetwork: NetworkId;
  wallets: Partial<Record<NetworkId, WalletRecord>>;
  deployments: Partial<Record<NetworkId, DeploymentRecord>>;
}

export const STATE_FILE_NAME = '.midnight-state.json';
export const STATE_VERSION = 1 as const;

export const NETWORK_CONFIGS: Record<NetworkId, NetworkConfig> = {
  undeployed: {
    networkId: 'undeployed',
    indexer: 'http://127.0.0.1:8088/api/v4/graphql',
    indexerWS: 'ws://127.0.0.1:8088/api/v4/graphql/ws',
    node: 'ws://127.0.0.1:9944',
    proofServer: 'http://127.0.0.1:6300',
    faucet: null,
    composeServices: ['node', 'indexer', 'proof-server'],
  },
  preview: {
    networkId: 'preview',
    indexer: 'https://indexer.preview.midnight.network/api/v4/graphql',
    indexerWS: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
    node: 'https://rpc.preview.midnight.network',
    proofServer: 'http://127.0.0.1:6300',
    faucet: 'https://midnight-tmnight-preview.nethermind.dev',
    composeServices: ['proof-server'],
  },
  preprod: {
    networkId: 'preprod',
    indexer: 'https://indexer.preprod.midnight.network/api/v4/graphql',
    indexerWS: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    node: 'https://rpc.preprod.midnight.network',
    proofServer: 'http://127.0.0.1:6300',
    faucet: 'https://midnight-tmnight-preprod.nethermind.dev',
    composeServices: ['proof-server'],
  },
};

export function isNetworkId(value: unknown): value is NetworkId {
  return typeof value === 'string' && (NETWORK_IDS as readonly string[]).includes(value);
}

export interface FsOptions {
  cwd?: string;
}

function statePath(opts: FsOptions = {}): string {
  return path.join(opts.cwd ?? process.cwd(), STATE_FILE_NAME);
}

export function loadState(opts: FsOptions = {}): NetworkState | null {
  const file = statePath(opts);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${file}: ${(err as Error).message}. Run \`npm run clean\` to reset.`);
  }
  const candidate = parsed as Partial<NetworkState>;
  if (!candidate || typeof candidate !== 'object' || candidate.version !== STATE_VERSION) {
    throw new Error(`Unsupported state-file version in ${file} (expected ${STATE_VERSION}). Run \`npm run clean\` to reset.`);
  }
  if (!isNetworkId(candidate.activeNetwork)) {
    throw new Error(`Invalid activeNetwork in ${file}. Run \`npm run clean\` to reset.`);
  }
  return candidate as NetworkState;
}

export function saveState(state: NetworkState, opts: FsOptions = {}): void {
  const file = statePath(opts);
  // Atomic write + owner-only permissions: this file holds wallet secrets.
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function parseNetworkFlag(argv: string[]): NetworkId | null {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--network') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--network requires a value');
      if (!isNetworkId(value)) throw new Error(`Unknown network: ${value}. Supported: ${NETWORK_IDS.join(', ')}.`);
      return value;
    }
    if (arg.startsWith('--network=')) {
      const value = arg.slice('--network='.length);
      if (!isNetworkId(value)) throw new Error(`Unknown network: ${value}. Supported: ${NETWORK_IDS.join(', ')}.`);
      return value;
    }
  }
  return null;
}

const ENV_OVERRIDES: Array<[keyof NetworkConfig, string]> = [
  ['indexer', 'MIDNIGHT_INDEXER_URL'],
  ['indexerWS', 'MIDNIGHT_INDEXER_WS_URL'],
  ['node', 'MIDNIGHT_NODE_URL'],
  ['faucet', 'MIDNIGHT_FAUCET_URL'],
  ['proofServer', 'MIDNIGHT_PROOF_SERVER_URL'],
];

function applyEnvOverrides(base: NetworkConfig, env: NodeJS.ProcessEnv): NetworkConfig {
  const out: NetworkConfig = { ...base, composeServices: [...base.composeServices] };
  for (const [field, variable] of ENV_OVERRIDES) {
    const value = env[variable];
    if (value) (out as unknown as Record<string, unknown>)[field] = value;
  }
  return out;
}

export interface ResolveOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface ResolveResult {
  network: NetworkId;
  config: NetworkConfig;
  source: 'flag' | 'state' | 'default';
}

export function resolveNetwork(opts: ResolveOptions = {}): ResolveResult {
  const argv = opts.argv ?? process.argv;
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();

  const flag = parseNetworkFlag(argv);
  let network: NetworkId;
  let source: ResolveResult['source'];

  if (flag) {
    network = flag;
    source = 'flag';
  } else {
    const state = loadState({ cwd });
    network = state ? state.activeNetwork : 'undeployed';
    source = state ? 'state' : 'default';
  }

  return { network, config: applyEnvOverrides(NETWORK_CONFIGS[network], env), source };
}

// ─── Wallet identity ──────────────────────────────────────────────────────────

/** Genesis seed used by the local devnet preset. Not valid on public networks. */
export const GENESIS_SEED = '0000000000000000000000000000000000000000000000000000000000000001';

export function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().toLowerCase().split(/\s+/).join(' ');
}

/** Generate a fresh 24-word BIP-39 recovery phrase (256-bit entropy). */
export function generateMnemonicPhrase(): string {
  return generateMnemonic(wordlist, 256);
}

export function isValidMnemonic(mnemonic: string): boolean {
  return validateMnemonic(normalizeMnemonic(mnemonic), wordlist);
}

/** Standard BIP-39 seed (64 bytes) as 128 hex characters. Matches Lace wallet derivation. */
export function mnemonicToSeedHex(mnemonic: string): string {
  return Buffer.from(mnemonicToSeedSync(normalizeMnemonic(mnemonic))).toString('hex');
}

const SEED_HEX_RE = /^(?:[0-9a-fA-F]{2}){16,64}$/;

export interface WalletCredentials {
  seed: string;
  mnemonic: string | null;
  created: boolean;
}

export interface SeedOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/**
 * Resolve the wallet for a network, in priority order:
 *   1. `MIDNIGHT_WALLET_SEED`
 *   2. `MIDNIGHT_WALLET_MNEMONIC`
 *   3. a previously persisted wallet in `.midnight-state.json`
 *   4. a newly generated phrase, persisted to `.midnight-state.json`
 *
 * The local devnet always uses the pre-funded genesis seed.
 */
export function getOrCreateWallet(network: NetworkId, opts: SeedOptions = {}): WalletCredentials {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();

  if (network === 'undeployed') return { seed: GENESIS_SEED, mnemonic: null, created: false };

  const envSeed = env.MIDNIGHT_WALLET_SEED;
  const envMnemonic = env.MIDNIGHT_WALLET_MNEMONIC;
  if (envSeed && envMnemonic) {
    throw new Error('Both MIDNIGHT_WALLET_SEED and MIDNIGHT_WALLET_MNEMONIC are set — unset one.');
  }
  if (envSeed) {
    const trimmed = envSeed.trim();
    const hex = trimmed.startsWith('0x') || trimmed.startsWith('0X') ? trimmed.slice(2) : trimmed;
    if (!SEED_HEX_RE.test(hex)) {
      throw new Error(
        'MIDNIGHT_WALLET_SEED must be 32-128 hex characters (16-64 whole bytes); a BIP-39 seed is 128 hex characters.',
      );
    }
    return { seed: hex, mnemonic: null, created: false };
  }
  if (envMnemonic) {
    if (!isValidMnemonic(envMnemonic)) {
      throw new Error('MIDNIGHT_WALLET_MNEMONIC is not a valid BIP-39 recovery phrase.');
    }
    return { seed: mnemonicToSeedHex(envMnemonic), mnemonic: normalizeMnemonic(envMnemonic), created: false };
  }

  const existing = loadState({ cwd });
  const persisted = existing?.wallets?.[network];
  if (persisted?.seed) {
    return { seed: persisted.seed, mnemonic: persisted.mnemonic ?? null, created: false };
  }

  const mnemonic = generateMnemonicPhrase();
  const seed = mnemonicToSeedHex(mnemonic);
  const next: NetworkState = existing ?? {
    version: STATE_VERSION,
    activeNetwork: network,
    wallets: {},
    deployments: {},
  };
  next.activeNetwork = network;
  next.wallets = { ...next.wallets, [network]: { seed, mnemonic, createdAt: new Date().toISOString() } };
  saveState(next, { cwd });
  return { seed, mnemonic, created: true };
}

// ─── Deployments ──────────────────────────────────────────────────────────────

export function getDeployment(network: NetworkId, opts: FsOptions = {}): DeploymentRecord | null {
  return loadState(opts)?.deployments?.[network] ?? null;
}

export function recordDeployment(
  network: NetworkId,
  address: string,
  deployer: string,
  opts: FsOptions = {},
): void {
  const cwd = opts.cwd ?? process.cwd();
  const existing = loadState({ cwd });
  const next: NetworkState = existing ?? {
    version: STATE_VERSION,
    activeNetwork: network,
    wallets: {},
    deployments: {},
  };
  next.deployments = { ...next.deployments, [network]: { address, deployer, deployedAt: new Date().toISOString() } };
  saveState(next, { cwd });
}

export function setActiveNetwork(network: NetworkId, opts: FsOptions = {}): void {
  const cwd = opts.cwd ?? process.cwd();
  const existing = loadState({ cwd });
  if (existing && existing.activeNetwork === network) return;
  const next: NetworkState = existing ?? {
    version: STATE_VERSION,
    activeNetwork: network,
    wallets: {},
    deployments: {},
  };
  next.activeNetwork = network;
  saveState(next, { cwd });
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function cliMain(argv: string[]): number {
  const args = argv.slice(2);
  if (args.length === 0) {
    const resolved = resolveNetwork({ argv });
    const deployment = getDeployment(resolved.network);
    process.stdout.write(`Active network: ${resolved.network}${resolved.source === 'default' ? ' (default)' : ''}\n`);
    if (deployment) process.stdout.write(`Last deploy: ${deployment.address}\n`);
    return 0;
  }
  const candidate = args[0];
  if (!isNetworkId(candidate)) {
    process.stderr.write(`Unknown network: ${candidate}. Supported: ${NETWORK_IDS.join(', ')}.\n`);
    return 1;
  }
  setActiveNetwork(candidate);
  process.stdout.write(`Active network is now: ${candidate}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(cliMain(process.argv));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }
}
