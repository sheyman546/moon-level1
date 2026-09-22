/**
 * Local storage for sealed-bid openings.
 *
 * A sealed bid is only openable by whoever holds `(amount, nonce)`. The nonce
 * must therefore survive between the `commitBid` and `revealBid` transactions,
 * but it must never touch the chain. This module keeps it in a gitignored file
 * on the bidder's own machine.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { NetworkId } from './network.js';

export const OPENINGS_FILE_NAME = '.sealedbid-openings.json';

export interface Opening {
  contractAddress: string;
  network: NetworkId;
  bidder: string;
  amount: string;
  nonce: string;
  commitment: string;
  createdAt: string;
}

interface OpeningsFile {
  version: 1;
  openings: Opening[];
}

function filePath(cwd = process.cwd()): string {
  return path.join(cwd, OPENINGS_FILE_NAME);
}

function read(cwd?: string): OpeningsFile {
  const file = filePath(cwd);
  if (!fs.existsSync(file)) return { version: 1, openings: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as OpeningsFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.openings)) return { version: 1, openings: [] };
    return parsed;
  } catch {
    return { version: 1, openings: [] };
  }
}

function write(data: OpeningsFile, cwd?: string): void {
  const file = filePath(cwd);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** A fresh 32-byte nonce. */
export function randomNonce(): Uint8Array {
  return new Uint8Array(crypto.randomBytes(32));
}

export function saveOpening(opening: Opening, cwd?: string): void {
  const data = read(cwd);
  data.openings = data.openings.filter(
    (entry) =>
      !(
        entry.contractAddress === opening.contractAddress &&
        entry.bidder === opening.bidder
      ),
  );
  data.openings.push(opening);
  write(data, cwd);
}

export function findOpening(
  contractAddress: string,
  bidder: string,
  opts: { cwd?: string } = {},
): Opening | undefined {
  return read(opts.cwd).openings.find(
    (entry) => entry.contractAddress === contractAddress && entry.bidder === bidder,
  );
}

export function listOpenings(opts: { cwd?: string } = {}): Opening[] {
  return read(opts.cwd).openings;
}

export function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}
