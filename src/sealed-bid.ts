/**
 * Compiled SealedBid contract, loaded once for every script.
 *
 * The generated artifacts under `contracts/managed/sealed-bid` are produced by
 * the Compact compiler (`npm run compile`). We import them statically so the
 * TypeScript types of the circuits, the constructor and the ledger accessors are
 * checked at build time.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';

import * as SealedBidContract from '../contracts/managed/sealed-bid/contract/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Directory holding the contract's `contract/`, `keys/` and `zkir/` assets. */
export const ZK_CONFIG_PATH = path.resolve(here, '..', 'contracts', 'managed', 'sealed-bid');

export const SealedBid = SealedBidContract;
// Re-export the generated API. These come from the generated module directly so
// that TypeScript keeps the value/type duality of `AuctionStatus` and friends.
export {
  AuctionStatus,
  Contract,
  ledger,
  pureCircuits,
  contractReferenceLocations,
} from '../contracts/managed/sealed-bid/contract/index.js';
export type {
  Circuits,
  ImpureCircuits,
  Ledger,
  ProvableCircuits,
  PureCircuits,
  Witnesses,
} from '../contracts/managed/sealed-bid/contract/index.js';

/** Identifier under which this contract's (empty) private state is stored. */
export const PRIVATE_STATE_ID = 'sealedBidPrivateState';

/** Assert the compiler output is present, with a fix-it hint when it is not. */
export function assertContractCompiled(): void {
  const entry = path.join(ZK_CONFIG_PATH, 'contract', 'index.js');
  if (!fs.existsSync(entry)) {
    throw new Error(`Compiled contract not found at ${entry}. Run: npm run compile`);
  }
}

/** Ready-to-deploy contract handle, with its circuit assets wired in. */
export const compiledSealedBidContract = CompiledContract.make('sealed-bid', SealedBidContract.Contract).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(ZK_CONFIG_PATH),
);

/** Encode a short string as a zero-padded 32-byte value. */
export function toBytes32(text: string): Uint8Array {
  const out = new Uint8Array(32);
  const encoded = new TextEncoder().encode(text);
  if (encoded.length > 32) throw new Error(`toBytes32: "${text}" exceeds 32 bytes`);
  out.set(encoded);
  return out;
}

/** Render a 32-byte lot reference as printable ASCII where possible. */
export function formatLotRef(bytes: Uint8Array): string {
  const text = Buffer.from(bytes).toString('utf8').replace(/\0+$/, '');
  return /^[\x20-\x7e]*$/.test(text) && text.length > 0
    ? text
    : `0x${Buffer.from(bytes).toString('hex')}`;
}
