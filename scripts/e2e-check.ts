/**
 * End-to-end verification of a deployed SealedBid auction.
 *
 * Read-only: it reconnects to the recorded deployment, fetches the contract's
 * public state from the indexer, and checks that the ledger decodes into a
 * coherent auction. Exits non-zero on any failure.
 *
 *   npm run test:e2e
 *   npm run test:e2e -- --network preprod
 */

import { resolveNetwork, getDeployment } from '../src/network.js';
import { fetchAuctionState, AuctionStatus } from '../src/read-state.js';

function fail(message: string): never {
  process.stderr.write(`\n❌ e2e-check failed: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { network, config } = resolveNetwork();
  process.stdout.write(`\n  Network: ${network}\n`);

  const deployment = getDeployment(network);
  if (!deployment) fail(`no deployment recorded for ${network}. Run: npm run deploy -- --network ${network}`);

  const { address } = deployment;
  if (!/^[0-9a-fA-F]+$/.test(address) || address.length < 32) {
    fail(`recorded contract address looks invalid: ${address}`);
  }
  process.stdout.write(`  Contract: ${address}\n\n`);

  // 1. The contract must be indexed and its public state queryable.
  const snapshot = await fetchAuctionState(config, address);
  if (!snapshot) fail(`queryContractState returned no state for ${address}`);

  // 2. The state must decode into a coherent auction bound to this deployment.
  if (!(snapshot.status in AuctionStatus)) fail(`unknown auction status: ${snapshot.status}`);
  if (snapshot.reservePrice <= 0n) fail(`reserve price is not positive: ${snapshot.reservePrice}`);
  if (snapshot.biddingEndsAt >= snapshot.revealEndsAt) {
    fail(`bidding window does not close before the reveal window (${snapshot.biddingEndsAt} >= ${snapshot.revealEndsAt})`);
  }
  if (snapshot.bidderCount !== BigInt(snapshot.commitments.length)) {
    fail(`bidder count ${snapshot.bidderCount} disagrees with ${snapshot.commitments.length} stored commitments`);
  }
  if (snapshot.openings.length > snapshot.commitments.length) {
    fail(`${snapshot.openings.length} openings for ${snapshot.commitments.length} commitments`);
  }
  if (snapshot.status === AuctionStatus.SETTLED && snapshot.winningBid < snapshot.reservePrice) {
    fail(`settled below reserve: ${snapshot.winningBid} < ${snapshot.reservePrice}`);
  }
  if (snapshot.status === AuctionStatus.ACTIVE && (snapshot.winner !== '00'.repeat(32) || snapshot.winningBid !== 0n)) {
    fail('active auction reports a winner');
  }

  process.stdout.write('  ✅ e2e-check passed\n');
  process.stdout.write(`     contract address: ${address}\n`);
  process.stdout.write(`     network:          ${network}\n`);
  process.stdout.write(`     status:           ${snapshot.statusLabel}\n`);
  process.stdout.write(`     sealed bids:      ${snapshot.bidderCount}\n`);
  process.stdout.write(`     revealed bids:    ${snapshot.openings.length}\n\n`);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`\n❌ e2e-check failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
