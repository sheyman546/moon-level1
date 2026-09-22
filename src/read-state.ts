/**
 * Read-only access to a deployed auction's public state.
 *
 * Public state lives on-chain and is served by the indexer, so these helpers
 * need no wallet funds and no proof server.
 */

import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';

import type { NetworkConfig } from './network.js';
import { AuctionStatus, ledger, type Ledger } from './sealed-bid.js';

export interface AuctionSnapshot {
  status: AuctionStatus;
  statusLabel: string;
  lot: string;
  seller: string;
  reservePrice: bigint;
  biddingEndsAt: bigint;
  revealEndsAt: bigint;
  bidderCount: bigint;
  commitments: Array<{ bidder: string; commitment: string }>;
  openings: Array<{ bidder: string; amount: bigint }>;
  highestBid: bigint;
  highestBidder: string;
  winningBid: bigint;
  winner: string;
}

const STATUS_LABELS: Record<AuctionStatus, string> = {
  [AuctionStatus.ACTIVE]: 'ACTIVE',
  [AuctionStatus.SETTLED]: 'SETTLED',
  [AuctionStatus.CANCELLED]: 'CANCELLED',
};

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

function decode(raw: Ledger): AuctionSnapshot {
  return {
    status: raw.status,
    statusLabel: STATUS_LABELS[raw.status] ?? `UNKNOWN(${raw.status})`,
    lot: Buffer.from(raw.lot).toString('utf8').replace(/\0+$/, ''),
    seller: toHex(raw.seller),
    reservePrice: raw.reservePrice,
    biddingEndsAt: raw.biddingEndsAt,
    revealEndsAt: raw.revealEndsAt,
    bidderCount: raw.bidderCount,
    commitments: [...raw.commitments].map(([bidder, commitment]) => ({
      bidder: toHex(bidder),
      commitment: toHex(commitment),
    })),
    openings: [...raw.openings].map(([bidder, amount]) => ({ bidder: toHex(bidder), amount })),
    highestBid: raw.highestBid,
    highestBidder: toHex(raw.highestBidder),
    winningBid: raw.winningBid,
    winner: toHex(raw.winner),
  };
}

export async function fetchAuctionState(
  networkConfig: NetworkConfig,
  contractAddress: string,
): Promise<AuctionSnapshot | null> {
  const provider = indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS);
  const contractState = await provider.queryContractState(contractAddress);
  if (!contractState) return null;
  return decode(ledger(contractState.data));
}

export function formatAuction(snapshot: AuctionSnapshot): string {
  const lines: string[] = [];
  lines.push(`  status            ${snapshot.statusLabel}`);
  lines.push(`  lot               ${snapshot.lot}`);
  lines.push(`  seller            ${snapshot.seller}`);
  lines.push(`  reserve price     ${snapshot.reservePrice}`);
  lines.push(`  bidding closes    ${new Date(Number(snapshot.biddingEndsAt) * 1000).toISOString()}`);
  lines.push(`  reveal closes     ${new Date(Number(snapshot.revealEndsAt) * 1000).toISOString()}`);
  lines.push(`  sealed bids       ${snapshot.bidderCount}`);
  lines.push(`  revealed bids     ${snapshot.openings.length}`);
  lines.push(`  highest bid       ${snapshot.highestBid}`);
  lines.push(`  highest bidder    ${snapshot.highestBidder}`);
  if (snapshot.status === AuctionStatus.SETTLED) {
    lines.push(`  winner            ${snapshot.winner}`);
    lines.push(`  winning bid       ${snapshot.winningBid}`);
  }
  if (snapshot.commitments.length > 0) {
    lines.push('  commitments:');
    for (const { bidder, commitment } of snapshot.commitments) {
      lines.push(`    ${bidder} -> ${commitment}`);
    }
  }
  if (snapshot.openings.length > 0) {
    lines.push('  openings:');
    for (const { bidder, amount } of snapshot.openings) {
      lines.push(`    ${bidder} -> ${amount}`);
    }
  }
  return lines.join('\n');
}

export { AuctionStatus };
