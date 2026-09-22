/**
 * Behavioural tests for the SealedBid contract.
 *
 * Every case runs the circuit code produced by the Compact compiler through the
 * Compact runtime — not a re-implementation — so assertion order, ledger
 * operations and hashing rules are exactly what execute on-chain.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { AuctionHarness, AuctionStatus, bidCommitment, bytes, toBytes32, type AuctionOptions } from './harness.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const RESERVE = 100n;
const BIDDING_ENDS_AT = 1_000n;
const REVEAL_ENDS_AT = 2_000n;

const DURING_BIDDING = 900n;
const AFTER_BIDDING_CLOSES = 1_500n;
const AFTER_REVEAL_CLOSES = 2_500n;

const ALICE = bytes(0x11);
const BOB = bytes(0x22);
const CAROL = bytes(0x33);
const MALLORY = bytes(0x44);

const ALICE_NONCE = bytes(0x21);
const BOB_NONCE = bytes(0x22);
const CAROL_NONCE = bytes(0x23);

function auction(overrides: Partial<AuctionOptions> = {}) {
  return new AuctionHarness({
    reserve: RESERVE,
    biddingEndsAt: BIDDING_ENDS_AT,
    revealEndsAt: REVEAL_ENDS_AT,
    ...overrides,
  });
}

/** Seal a bid at a fixed time inside the bidding window. */
function seal(sim: AuctionHarness, bidder: Uint8Array, amount: bigint, nonce: Uint8Array, at = DURING_BIDDING) {
  sim.commitBid(bidder, bidCommitment(amount, nonce), at);
}

/** Seal a bid and open it, asserting both steps succeed. */
function sealAndReveal(
  sim: AuctionHarness,
  bidder: Uint8Array,
  amount: bigint,
  nonce: Uint8Array,
  revealAt = AFTER_BIDDING_CLOSES,
) {
  seal(sim, bidder, amount, nonce);
  sim.revealBid(bidder, amount, nonce, revealAt);
}

/** Capture the error thrown by a circuit call, failing the test if none is. */
function captureError(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the circuit call to be rejected, but it succeeded');
}

// ─── Constructor ──────────────────────────────────────────────────────────────

describe('constructor', () => {
  it('records the configuration supplied at deployment', () => {
    const sim = auction({ lotRef: toBytes32('lot:amber-vase') });

    expect(sim.ledger.lot).toEqual(toBytes32('lot:amber-vase'));
    expect(sim.ledger.reservePrice).toBe(RESERVE);
    expect(sim.ledger.biddingEndsAt).toBe(BIDDING_ENDS_AT);
    expect(sim.ledger.revealEndsAt).toBe(REVEAL_ENDS_AT);
  });

  it('binds the seller to the deploying key, so the contract cannot be opened on another party\u2019s behalf', () => {
    const sim = auction({ seller: MALLORY });
    expect(sim.ledger.seller).toEqual(MALLORY);
  });

  it('starts ACTIVE and empty', () => {
    const sim = auction();

    expect(sim.status).toBe(AuctionStatus.ACTIVE);
    expect(sim.ledger.bidderCount).toBe(0n);
    expect(sim.ledger.commitments.isEmpty()).toBe(true);
    expect(sim.ledger.openings.isEmpty()).toBe(true);
    expect(sim.ledger.highestBid).toBe(0n);
    expect(sim.ledger.highestBidder).toEqual(bytes(0));
    expect(sim.ledger.winningBid).toBe(0n);
    expect(sim.ledger.winner).toEqual(bytes(0));
  });

  it('rejects a zero reserve price', () => {
    expect(() => auction({ reserve: 0n })).toThrow(/reserve price must be greater than zero/);
  });

  it('rejects a reveal window that does not follow the bidding window', () => {
    expect(() => auction({ biddingEndsAt: 2_000n, revealEndsAt: 2_000n })).toThrow(
      /bidding must close before the reveal window closes/,
    );
    expect(() => auction({ biddingEndsAt: 2_000n, revealEndsAt: 1_000n })).toThrow(
      /bidding must close before the reveal window closes/,
    );
  });
});

// ─── bidCommitment ────────────────────────────────────────────────────────────

describe('bidCommitment (pure circuit)', () => {
  it('produces a 32-byte commitment', () => {
    const commitment = bidCommitment(500n, ALICE_NONCE);
    expect(commitment).toBeInstanceOf(Uint8Array);
    expect(commitment).toHaveLength(32);
  });

  it('is deterministic', () => {
    expect(bidCommitment(500n, ALICE_NONCE)).toEqual(bidCommitment(500n, ALICE_NONCE));
  });

  it('changes with the amount', () => {
    expect(bidCommitment(500n, ALICE_NONCE)).not.toEqual(bidCommitment(501n, ALICE_NONCE));
  });

  it('changes with the nonce, so identical amounts are indistinguishable on-chain', () => {
    const a = bidCommitment(500n, ALICE_NONCE);
    const b = bidCommitment(500n, BOB_NONCE);
    expect(a).not.toEqual(b);

    const sim = auction();
    seal(sim, ALICE, 500n, ALICE_NONCE);
    seal(sim, BOB, 500n, BOB_NONCE);
    // Two equal bids are stored as two unrelated-looking commitments.
    expect(sim.ledger.commitments.lookup(ALICE)).not.toEqual(sim.ledger.commitments.lookup(BOB));
  });

  it('does not equal the plaintext encoding of the amount', () => {
    const amountBytes = new Uint8Array(32);
    amountBytes[0] = 500;
    expect(bidCommitment(500n, ALICE_NONCE)).not.toEqual(amountBytes);
  });
});

// ─── commitBid ────────────────────────────────────────────────────────────────

describe('commitBid', () => {
  let sim: AuctionHarness;

  beforeEach(() => {
    sim = auction();
  });

  it('records a sealed commitment and counts the bidder', () => {
    const commitment = bidCommitment(500n, ALICE_NONCE);
    sim.commitBid(ALICE, commitment, DURING_BIDDING);

    expect(sim.ledger.commitments.member(ALICE)).toBe(true);
    expect(sim.ledger.commitments.lookup(ALICE)).toEqual(commitment);
    expect(sim.ledger.bidderCount).toBe(1n);
  });

  it('publishes no amount: only the commitment reaches the ledger', () => {
    seal(sim, ALICE, 500n, ALICE_NONCE);

    // The openings map stays empty until the reveal window.
    expect(sim.ledger.openings.isEmpty()).toBe(true);
    expect(sim.ledger.highestBid).toBe(0n);

    // No ledger entry encodes the bid amount.
    const amountBytes = new Uint8Array(32);
    amountBytes[0] = 500;
    for (const [, stored] of sim.ledger.commitments) {
      expect(stored).not.toEqual(amountBytes);
    }
  });

  it('accepts commitments from anyone (permissionless)', () => {
    seal(sim, ALICE, 500n, ALICE_NONCE);
    seal(sim, BOB, 900n, BOB_NONCE);
    seal(sim, MALLORY, 1n, bytes(0x99));

    expect(sim.ledger.bidderCount).toBe(3n);
    expect(sim.ledger.commitments.size()).toBe(3n);
  });

  it('allows a bidder to seal exactly one bid', () => {
    seal(sim, ALICE, 500n, ALICE_NONCE);

    const err = captureError(() => sim.commitBid(ALICE, bidCommitment(600n, bytes(0x55)), DURING_BIDDING));
    expect(err.message).toMatch(/caller has already sealed a bid/);
    // The original commitment is untouched.
    expect(sim.ledger.commitments.lookup(ALICE)).toEqual(bidCommitment(500n, ALICE_NONCE));
    expect(sim.ledger.bidderCount).toBe(1n);
  });

  it('rejects a bid sealed after the bidding window closes', () => {
    const err = captureError(() => sim.commitBid(ALICE, bidCommitment(500n, ALICE_NONCE), AFTER_BIDDING_CLOSES));
    expect(err.message).toMatch(/bidding window has closed/);
    expect(sim.ledger.commitments.isEmpty()).toBe(true);
  });

  it('rejects a bid submitted exactly at the closing instant (boundary)', () => {
    expect(() => sim.commitBid(ALICE, bidCommitment(500n, ALICE_NONCE), BIDDING_ENDS_AT)).toThrow(
      /bidding window has closed/,
    );
    // One second earlier is still allowed.
    expect(() => sim.commitBid(ALICE, bidCommitment(500n, ALICE_NONCE), BIDDING_ENDS_AT - 1n)).not.toThrow();
  });

  it('rejects bids once the auction has been cancelled', () => {
    sim.cancel(sim.seller, DURING_BIDDING);
    expect(() => sim.commitBid(ALICE, bidCommitment(500n, ALICE_NONCE), DURING_BIDDING)).toThrow(
      /auction is not active/,
    );
  });

  it('rejects bids once the auction has settled', () => {
    sealAndReveal(sim, ALICE, 500n, ALICE_NONCE);
    sim.settle(BOB, AFTER_REVEAL_CLOSES);

    expect(() => sim.commitBid(BOB, bidCommitment(900n, BOB_NONCE), AFTER_REVEAL_CLOSES + 1n)).toThrow(
      /auction is not active/,
    );
  });
});

// ─── revealBid ────────────────────────────────────────────────────────────────

describe('revealBid', () => {
  let sim: AuctionHarness;

  beforeEach(() => {
    sim = auction();
  });

  it('opens a sealed bid and publishes the amount', () => {
    sealAndReveal(sim, ALICE, 500n, ALICE_NONCE);

    expect(sim.ledger.openings.lookup(ALICE)).toBe(500n);
    expect(sim.ledger.highestBid).toBe(500n);
    expect(sim.ledger.highestBidder).toEqual(ALICE);
  });

  it('rejects a reveal before the bidding window closes', () => {
    seal(sim, ALICE, 500n, ALICE_NONCE);
    const err = captureError(() => sim.revealBid(ALICE, 500n, ALICE_NONCE, DURING_BIDDING));
    expect(err.message).toMatch(/bidding window has not closed yet/);
  });

  it('allows a reveal exactly at the moment bidding closes (boundary)', () => {
    seal(sim, ALICE, 500n, ALICE_NONCE);
    expect(() => sim.revealBid(ALICE, 500n, ALICE_NONCE, BIDDING_ENDS_AT)).not.toThrow();
    expect(sim.ledger.openings.lookup(ALICE)).toBe(500n);
  });

  it('rejects a reveal once the reveal window has closed', () => {
    seal(sim, ALICE, 500n, ALICE_NONCE);

    expect(() => sim.revealBid(ALICE, 500n, ALICE_NONCE, REVEAL_ENDS_AT)).toThrow(/reveal window has closed/);
    expect(() => sim.revealBid(ALICE, 500n, ALICE_NONCE, AFTER_REVEAL_CLOSES)).toThrow(/reveal window has closed/);
  });

  it('rejects an opening that changes the amount (bids are binding)', () => {
    seal(sim, ALICE, 500n, ALICE_NONCE);

    const err = captureError(() => sim.revealBid(ALICE, 501n, ALICE_NONCE, AFTER_BIDDING_CLOSES));
    expect(err.message).toMatch(/opening does not match the sealed commitment/);
    expect(sim.ledger.openings.isEmpty()).toBe(true);
    expect(sim.ledger.highestBid).toBe(0n);
  });

  it('rejects an opening with the wrong nonce', () => {
    seal(sim, ALICE, 500n, ALICE_NONCE);
    expect(() => sim.revealBid(ALICE, 500n, bytes(0x77), AFTER_BIDDING_CLOSES)).toThrow(
      /opening does not match the sealed commitment/,
    );
  });

  it('rejects a reveal from a caller who sealed no bid', () => {
    const err = captureError(() => sim.revealBid(MALLORY, 10_000n, bytes(0x99), AFTER_BIDDING_CLOSES));
    expect(err.message).toMatch(/caller has no sealed bid/);
  });

  it('rejects a bidder revealing on behalf of another', () => {
    seal(sim, ALICE, 500n, ALICE_NONCE);
    // Mallory knows Alice's commitment but not her nonce; and even with it, the
    // bidder key is the caller's own public key.
    const err = captureError(() => sim.revealBid(MALLORY, 500n, ALICE_NONCE, AFTER_BIDDING_CLOSES));
    expect(err.message).toMatch(/caller has no sealed bid/);
  });

  it('rejects a second reveal from the same bidder', () => {
    sealAndReveal(sim, ALICE, 500n, ALICE_NONCE);
    const err = captureError(() => sim.revealBid(ALICE, 500n, ALICE_NONCE, AFTER_BIDDING_CLOSES));
    expect(err.message).toMatch(/caller has already revealed/);
  });

  it('records a below-reserve reveal without making it the leading bid', () => {
    sealAndReveal(sim, ALICE, RESERVE - 1n, ALICE_NONCE);

    expect(sim.ledger.openings.lookup(ALICE)).toBe(RESERVE - 1n);
    expect(sim.ledger.highestBid).toBe(0n);
    expect(sim.ledger.highestBidder).toEqual(bytes(0));
  });

  it('accepts a bid exactly at the reserve price (boundary)', () => {
    sealAndReveal(sim, ALICE, RESERVE, ALICE_NONCE);
    expect(sim.ledger.highestBid).toBe(RESERVE);
    expect(sim.ledger.highestBidder).toEqual(ALICE);
  });

  it('keeps the highest qualifying bid as later bids arrive', () => {
    sealAndReveal(sim, ALICE, 500n, ALICE_NONCE, 1_100n);
    sealAndReveal(sim, BOB, 900n, BOB_NONCE, 1_200n);
    sealAndReveal(sim, CAROL, 200n, CAROL_NONCE, 1_300n);

    expect(sim.ledger.highestBid).toBe(900n);
    expect(sim.ledger.highestBidder).toEqual(BOB);
    // Every reveal is recorded, including the losing ones.
    expect(sim.ledger.openings.size()).toBe(3n);
  });

  it('does not displace the leader on a tie: the earliest reveal wins', () => {
    sealAndReveal(sim, ALICE, 700n, ALICE_NONCE, 1_100n);
    sealAndReveal(sim, BOB, 700n, BOB_NONCE, 1_200n);

    expect(sim.ledger.highestBid).toBe(700n);
    expect(sim.ledger.highestBidder).toEqual(ALICE);
  });

  it('rejects reveals once the auction is cancelled', () => {
    seal(sim, ALICE, 500n, ALICE_NONCE);
    sim.cancel(sim.seller, DURING_BIDDING);

    expect(() => sim.revealBid(ALICE, 500n, ALICE_NONCE, AFTER_BIDDING_CLOSES)).toThrow(/auction is not active/);
  });
});

// ─── settle ───────────────────────────────────────────────────────────────────

describe('settle', () => {
  let sim: AuctionHarness;

  beforeEach(() => {
    sim = auction();
  });

  it('rejects settlement before the reveal window closes', () => {
    sealAndReveal(sim, ALICE, 500n, ALICE_NONCE);

    expect(() => sim.settle(BOB, AFTER_BIDDING_CLOSES)).toThrow(/reveal window has not closed yet/);
    expect(() => sim.settle(BOB, REVEAL_ENDS_AT - 1n)).toThrow(/reveal window has not closed yet/);
  });

  it('rejects settlement when nobody bid', () => {
    const err = captureError(() => sim.settle(BOB, AFTER_REVEAL_CLOSES));
    expect(err.message).toMatch(/reserve price was not met/);
    expect(sim.status).toBe(AuctionStatus.ACTIVE);
  });

  it('rejects settlement when no revealed bid met the reserve', () => {
    sealAndReveal(sim, ALICE, RESERVE - 1n, ALICE_NONCE);
    sealAndReveal(sim, BOB, RESERVE - 50n, BOB_NONCE);

    expect(() => sim.settle(BOB, AFTER_REVEAL_CLOSES)).toThrow(/reserve price was not met/);
    expect(sim.status).toBe(AuctionStatus.ACTIVE);
  });

  it('rejects settlement when sealed bids were never revealed', () => {
    seal(sim, ALICE, 10_000n, ALICE_NONCE);
    expect(() => sim.settle(BOB, AFTER_REVEAL_CLOSES)).toThrow(/reserve price was not met/);
  });

  it('records the winner and the winning amount', () => {
    sealAndReveal(sim, ALICE, 500n, ALICE_NONCE, 1_100n);
    sealAndReveal(sim, BOB, 900n, BOB_NONCE, 1_200n);
    sim.settle(CAROL, AFTER_REVEAL_CLOSES);

    expect(sim.status).toBe(AuctionStatus.SETTLED);
    expect(sim.ledger.winner).toEqual(BOB);
    expect(sim.ledger.winningBid).toBe(900n);
  });

  it('allows settlement exactly at the closing instant (boundary)', () => {
    sealAndReveal(sim, ALICE, 500n, ALICE_NONCE);
    expect(() => sim.settle(BOB, REVEAL_ENDS_AT)).not.toThrow();
    expect(sim.status).toBe(AuctionStatus.SETTLED);
  });

  it('is permissionless: any caller may crank it, with the same outcome', () => {
    sealAndReveal(sim, ALICE, 500n, ALICE_NONCE);
    sim.settle(MALLORY, AFTER_REVEAL_CLOSES);
    expect(sim.ledger.winner).toEqual(ALICE);
  });

  it('cannot be run twice', () => {
    sealAndReveal(sim, ALICE, 500n, ALICE_NONCE);
    sim.settle(BOB, AFTER_REVEAL_CLOSES);

    const err = captureError(() => sim.settle(BOB, AFTER_REVEAL_CLOSES + 1n));
    expect(err.message).toMatch(/auction is not active/);
  });

  it('settles at the reserve price exactly', () => {
    sealAndReveal(sim, ALICE, RESERVE, ALICE_NONCE);
    sim.settle(BOB, AFTER_REVEAL_CLOSES);
    expect(sim.ledger.winningBid).toBe(RESERVE);
    expect(sim.ledger.winner).toEqual(ALICE);
  });
});

// ─── cancel ───────────────────────────────────────────────────────────────────

describe('cancel', () => {
  let sim: AuctionHarness;

  beforeEach(() => {
    sim = auction();
  });

  it('lets the seller cancel during bidding', () => {
    sim.cancel(sim.seller, DURING_BIDDING);
    expect(sim.status).toBe(AuctionStatus.CANCELLED);
  });

  it('lets the seller cancel during the reveal window', () => {
    seal(sim, ALICE, 500n, ALICE_NONCE);
    sim.cancel(sim.seller, AFTER_BIDDING_CLOSES);
    expect(sim.status).toBe(AuctionStatus.CANCELLED);
  });

  it('rejects cancellation by anyone other than the seller', () => {
    const err = captureError(() => sim.cancel(MALLORY, DURING_BIDDING));
    expect(err.message).toMatch(/only the seller may cancel/);
    expect(sim.status).toBe(AuctionStatus.ACTIVE);
  });

  it('rejects cancellation by a bidder', () => {
    seal(sim, ALICE, 500n, ALICE_NONCE);
    expect(() => sim.cancel(ALICE, DURING_BIDDING)).toThrow(/only the seller may cancel/);
  });

  it('rejects a second cancellation', () => {
    sim.cancel(sim.seller, DURING_BIDDING);
    expect(() => sim.cancel(sim.seller, DURING_BIDDING)).toThrow(/auction is not active/);
  });

  it('rejects cancellation after settlement', () => {
    sealAndReveal(sim, ALICE, 500n, ALICE_NONCE);
    sim.settle(BOB, AFTER_REVEAL_CLOSES);

    expect(() => sim.cancel(sim.seller, AFTER_REVEAL_CLOSES + 1n)).toThrow(/auction is not active/);
    expect(sim.ledger.winner).toEqual(ALICE);
  });

  it('blocks settlement after cancellation', () => {
    sealAndReveal(sim, ALICE, 500n, ALICE_NONCE);
    sim.cancel(sim.seller, AFTER_BIDDING_CLOSES);

    expect(() => sim.settle(BOB, AFTER_REVEAL_CLOSES)).toThrow(/auction is not active/);
  });
});

// ─── Full lifecycle ───────────────────────────────────────────────────────────

describe('auction lifecycle', () => {
  it('runs a contested auction end to end', () => {
    const sim = auction({ reserve: 1_000n, lotRef: toBytes32('lot:brass-compass') });

    // Sealed phase: four commitments, no amounts on-chain.
    seal(sim, ALICE, 1_500n, ALICE_NONCE, 100n);
    seal(sim, BOB, 2_200n, BOB_NONCE, 200n);
    seal(sim, CAROL, 900n, CAROL_NONCE, 300n);
    seal(sim, MALLORY, 1n, bytes(0x99), 400n);

    expect(sim.ledger.bidderCount).toBe(4n);
    expect(sim.ledger.openings.isEmpty()).toBe(true);
    expect(sim.status).toBe(AuctionStatus.ACTIVE);

    // Reveal phase: everyone opens.
    sim.revealBid(ALICE, 1_500n, ALICE_NONCE, 1_100n);
    sim.revealBid(BOB, 2_200n, BOB_NONCE, 1_200n);
    sim.revealBid(CAROL, 900n, CAROL_NONCE, 1_300n);
    sim.revealBid(MALLORY, 1n, bytes(0x99), 1_400n);

    expect(sim.ledger.openings.size()).toBe(4n);
    expect(sim.ledger.highestBid).toBe(2_200n);
    expect(sim.ledger.highestBidder).toEqual(BOB);

    // Settlement: BOB wins, CAROL's and MALLORY's below-reserve bids are excluded.
    sim.settle(ALICE, 2_500n);

    expect(sim.status).toBe(AuctionStatus.SETTLED);
    expect(sim.ledger.winner).toEqual(BOB);
    expect(sim.ledger.winningBid).toBe(2_200n);
    expect(sim.ledger.lot).toEqual(toBytes32('lot:brass-compass'));
  });

  it('leaves non-revealing bidders out of the result', () => {
    const sim = auction({ reserve: 100n });

    seal(sim, ALICE, 5_000n, ALICE_NONCE);
    seal(sim, BOB, 300n, BOB_NONCE);
    // Alice never reveals; only Bob does.
    sim.revealBid(BOB, 300n, BOB_NONCE, AFTER_BIDDING_CLOSES);
    sim.settle(ALICE, AFTER_REVEAL_CLOSES);

    expect(sim.ledger.winner).toEqual(BOB);
    expect(sim.ledger.winningBid).toBe(300n);
  });

  it('cannot settle an auction whose only bid stayed sealed', () => {
    const sim = auction({ reserve: 100n });
    seal(sim, ALICE, 5_000n, ALICE_NONCE);

    expect(() => sim.settle(BOB, AFTER_REVEAL_CLOSES)).toThrow(/reserve price was not met/);
  });
});
