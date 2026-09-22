/**
 * Security tests for SealedBid.
 *
 * These cases are written as attacks: each one tries to break a stated property
 * and asserts that the contract refuses. They run against the compiled circuits,
 * so a passing suite means the on-chain code enforces the property, not merely
 * that the TypeScript wrapper does.
 *
 * Properties under test:
 *   P1 bid secrecy        — amounts never reach the ledger before the reveal window
 *   P2 hiding commitments — the ledger cannot be searched for a bid amount
 *   P3 bid binding        — an amount cannot change after bidding closes
 *   P4 single bid         — one sealed bid per identity
 *   P5 single reveal      — one reveal per sealed bid
 *   P6 caller binding     — nobody can act for another bidder
 *   P7 seller authority   — only the seller may cancel
 *   P8 reserve protection — no settlement below the reserve
 *   P9 time gating        — phase transitions are deadline-driven and cannot be skipped
 *   P10 atomicity         — a rejected call never mutates the ledger
 *   P11 deterministic outcome — the winner does not depend on who settles
 */

import { describe, it, expect } from 'vitest';

import { AuctionHarness, AuctionStatus, bidCommitment, bytes, type Ledger } from './harness.js';

const RESERVE = 1_000n;
const BIDDING_ENDS_AT = 10_000n;
const REVEAL_ENDS_AT = 20_000n;
const DURING_BIDDING = 9_000n;
const AFTER_BIDDING_CLOSES = 15_000n;
const AFTER_REVEAL_CLOSES = 25_000n;

const SELLER = bytes(0x01);
const ALICE = bytes(0x11);
const BOB = bytes(0x22);
const MALLORY = bytes(0x44);

const ALICE_NONCE = bytes(0x21);
const BOB_NONCE = bytes(0x22);

function auction() {
  return new AuctionHarness({
    seller: SELLER,
    reserve: RESERVE,
    biddingEndsAt: BIDDING_ENDS_AT,
    revealEndsAt: REVEAL_ENDS_AT,
  });
}

function captureError(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the circuit call to be rejected, but it succeeded');
}

/** Snapshot everything an observer could learn from the public ledger. */
function snapshot(ledger: Ledger) {
  return {
    status: ledger.status,
    commitments: [...ledger.commitments].map(([key, value]) => [Buffer.from(key).toString('hex'), Buffer.from(value).toString('hex')]),
    openings: [...ledger.openings].map(([key, value]) => [Buffer.from(key).toString('hex'), value.toString()]),
    highestBid: ledger.highestBid.toString(),
    highestBidder: Buffer.from(ledger.highestBidder).toString('hex'),
    winningBid: ledger.winningBid.toString(),
    winner: Buffer.from(ledger.winner).toString('hex'),
    bidderCount: ledger.bidderCount.toString(),
  };
}

// ─── P1 / P2: bid secrecy and commitment hiding ───────────────────────────────

describe('P1/P2 — sealed bids stay secret', () => {
  it('never records an amount while bidding (sealed phase reveals nothing)', () => {
    const sim = auction();
    sim.commitBid(ALICE, bidCommitment(5_000n, ALICE_NONCE), DURING_BIDDING);
    sim.commitBid(BOB, bidCommitment(7_500n, BOB_NONCE), DURING_BIDDING);

    const ledger = sim.ledger;
    expect(ledger.openings.isEmpty()).toBe(true);
    expect(ledger.highestBid).toBe(0n);
    expect(ledger.highestBidder).toEqual(bytes(0));
    expect(ledger.winner).toEqual(bytes(0));
    expect(ledger.winningBid).toBe(0n);

    // The serialized public state must not contain either amount.
    const serialized = JSON.stringify(snapshot(ledger));
    expect(serialized).not.toContain('5000');
    expect(serialized).not.toContain('7500');
  });

  it('is not searchable: guessing amounts against a stored commitment fails', () => {
    const sim = auction();
    const secretNonce = bytes(0xab);
    sim.commitBid(ALICE, bidCommitment(5_000n, secretNonce), DURING_BIDDING);
    const stored = sim.ledger.commitments.lookup(ALICE);

    // An observer enumerating plausible amounts with an assumed nonce learns nothing.
    const guessedNonce = bytes(0xcd);
    for (let amount = 0n; amount <= 1_000n; amount += 1n) {
      expect(bidCommitment(amount, guessedNonce)).not.toEqual(stored);
    }
    // Even the true amount is invisible without the true nonce.
    expect(bidCommitment(5_000n, guessedNonce)).not.toEqual(stored);
  });

  it('makes equal bids indistinguishable from each other', () => {
    const sim = auction();
    sim.commitBid(ALICE, bidCommitment(5_000n, ALICE_NONCE), DURING_BIDDING);
    sim.commitBid(BOB, bidCommitment(5_000n, BOB_NONCE), DURING_BIDDING);

    expect(sim.ledger.commitments.lookup(ALICE)).not.toEqual(sim.ledger.commitments.lookup(BOB));
  });

  it('publishes the amount only during the reveal window', () => {
    const sim = auction();
    sim.commitBid(ALICE, bidCommitment(5_000n, ALICE_NONCE), DURING_BIDDING);
    expect(sim.ledger.openings.isEmpty()).toBe(true);

    sim.revealBid(ALICE, 5_000n, ALICE_NONCE, AFTER_BIDDING_CLOSES);
    expect(sim.ledger.openings.lookup(ALICE)).toBe(5_000n);
  });
});

// ─── P3: bid binding ──────────────────────────────────────────────────────────

describe('P3 — bids are binding after the deadline', () => {
  it('rejects inflating the amount after bidding closes', () => {
    const sim = auction();
    sim.commitBid(ALICE, bidCommitment(1_500n, ALICE_NONCE), DURING_BIDDING);

    const err = captureError(() => sim.revealBid(ALICE, 999_999n, ALICE_NONCE, AFTER_BIDDING_CLOSES));
    expect(err.message).toMatch(/opening does not match the sealed commitment/);
    expect(sim.ledger.openings.isEmpty()).toBe(true);
    expect(sim.ledger.highestBid).toBe(0n);
  });

  it('rejects deflating the amount to sneak under a reserve', () => {
    const sim = auction();
    sim.commitBid(ALICE, bidCommitment(5_000n, ALICE_NONCE), DURING_BIDDING);

    expect(() => sim.revealBid(ALICE, 1n, ALICE_NONCE, AFTER_BIDDING_CLOSES)).toThrow(
      /opening does not match the sealed commitment/,
    );
  });

  it('rejects a valid amount paired with the wrong nonce', () => {
    const sim = auction();
    sim.commitBid(ALICE, bidCommitment(5_000n, ALICE_NONCE), DURING_BIDDING);
    expect(() => sim.revealBid(ALICE, 5_000n, BOB_NONCE, AFTER_BIDDING_CLOSES)).toThrow(
      /opening does not match the sealed commitment/,
    );
  });

  it('does not let a challenger reuse a leading commitment to tie the top bid', () => {
    const sim = auction();
    // Mallory seals Alice's commitment (publicly visible) hoping to reveal it too.
    sim.commitBid(ALICE, bidCommitment(5_000n, ALICE_NONCE), DURING_BIDDING);
    sim.commitBid(MALLORY, sim.ledger.commitments.lookup(ALICE), DURING_BIDDING);

    sim.revealBid(ALICE, 5_000n, ALICE_NONCE, AFTER_BIDDING_CLOSES);
    // Mallory has the commitment but not the nonce, and the reveal would fail even so.
    const err = captureError(() => sim.revealBid(MALLORY, 5_000n, bytes(0x00), AFTER_BIDDING_CLOSES));
    expect(err.message).toMatch(/opening does not match the sealed commitment/);
    expect(sim.ledger.highestBidder).toEqual(ALICE);
  });
});

// ─── P4 / P5: one bid, one reveal ─────────────────────────────────────────────

describe('P4/P5 — limits on bids and reveals', () => {
  it('rejects a second sealed bid from the same identity', () => {
    const sim = auction();
    sim.commitBid(ALICE, bidCommitment(1_500n, ALICE_NONCE), DURING_BIDDING);

    const err = captureError(() => sim.commitBid(ALICE, bidCommitment(9_999n, BOB_NONCE), DURING_BIDDING));
    expect(err.message).toMatch(/caller has already sealed a bid/);
    expect(sim.ledger.bidderCount).toBe(1n);
    expect(sim.ledger.commitments.lookup(ALICE)).toEqual(bidCommitment(1_500n, ALICE_NONCE));
  });

  it('rejects a second reveal even when the opening is correct', () => {
    const sim = auction();
    sim.commitBid(ALICE, bidCommitment(1_500n, ALICE_NONCE), DURING_BIDDING);
    sim.revealBid(ALICE, 1_500n, ALICE_NONCE, AFTER_BIDDING_CLOSES);

    const err = captureError(() => sim.revealBid(ALICE, 1_500n, ALICE_NONCE, AFTER_BIDDING_CLOSES));
    expect(err.message).toMatch(/caller has already revealed/);
    expect(sim.ledger.openings.size()).toBe(1n);
  });
});

// ─── P6: caller binding ───────────────────────────────────────────────────────

describe('P6 — every write is bound to the caller', () => {
  it('does not let a stranger reveal a sealed bid', () => {
    const sim = auction();
    sim.commitBid(ALICE, bidCommitment(1_500n, ALICE_NONCE), DURING_BIDDING);

    // Mallory knows the amount and nonce but is not the bidder.
    const err = captureError(() => sim.revealBid(MALLORY, 1_500n, ALICE_NONCE, AFTER_BIDDING_CLOSES));
    expect(err.message).toMatch(/caller has no sealed bid/);
    expect(sim.ledger.openings.isEmpty()).toBe(true);
  });

  it('keeps each bidder\u2019s commitment separate when they seal in the same block', () => {
    const sim = auction();
    sim.commitBid(ALICE, bidCommitment(1_500n, ALICE_NONCE), DURING_BIDDING);
    sim.commitBid(BOB, bidCommitment(1_600n, BOB_NONCE), DURING_BIDDING);

    expect(sim.ledger.commitments.lookup(ALICE)).toEqual(bidCommitment(1_500n, ALICE_NONCE));
    expect(sim.ledger.commitments.lookup(BOB)).toEqual(bidCommitment(1_600n, BOB_NONCE));
  });
});

// ─── P7: seller authority ─────────────────────────────────────────────────────

describe('P7 — seller-only cancellation', () => {
  it('refuses cancellation from a bidder or a stranger', () => {
    const sim = auction();
    sim.commitBid(ALICE, bidCommitment(1_500n, ALICE_NONCE), DURING_BIDDING);

    for (const caller of [ALICE, BOB, MALLORY, bytes(0x00)]) {
      const err = captureError(() => sim.cancel(caller, DURING_BIDDING));
      expect(err.message).toMatch(/only the seller may cancel/);
    }
    expect(sim.status).toBe(AuctionStatus.ACTIVE);
  });

  it('accepts cancellation only from the exact deploying key', () => {
    const sim = auction();
    // A key that differs in its final byte must not be accepted.
    const almostSeller = new Uint8Array(SELLER);
    almostSeller[31] ^= 0xff;

    expect(() => sim.cancel(almostSeller, DURING_BIDDING)).toThrow(/only the seller may cancel/);
    expect(() => sim.cancel(SELLER, DURING_BIDDING)).not.toThrow();
    expect(sim.status).toBe(AuctionStatus.CANCELLED);
  });
});

// ─── P8: reserve protection ───────────────────────────────────────────────────

describe('P8 — the reserve cannot be bypassed', () => {
  it('refuses to settle when every revealed bid is below the reserve', () => {
    const sim = auction();
    sim.commitBid(ALICE, bidCommitment(RESERVE - 1n, ALICE_NONCE), DURING_BIDDING);
    sim.commitBid(BOB, bidCommitment(1n, BOB_NONCE), DURING_BIDDING);
    sim.revealBid(ALICE, RESERVE - 1n, ALICE_NONCE, AFTER_BIDDING_CLOSES);
    sim.revealBid(BOB, 1n, BOB_NONCE, AFTER_BIDDING_CLOSES);

    const err = captureError(() => sim.settle(MALLORY, AFTER_REVEAL_CLOSES));
    expect(err.message).toMatch(/reserve price was not met/);
    expect(sim.status).toBe(AuctionStatus.ACTIVE);
    expect(sim.ledger.winner).toEqual(bytes(0));
  });

  it('does not let a below-reserve bid become the leading bid', () => {
    const sim = auction();
    sim.commitBid(ALICE, bidCommitment(999n, ALICE_NONCE), DURING_BIDDING);
    sim.revealBid(ALICE, 999n, ALICE_NONCE, AFTER_BIDDING_CLOSES);

    expect(sim.ledger.highestBid).toBe(0n);
    expect(sim.ledger.highestBidder).toEqual(bytes(0));
  });
});

// ─── P9: time gating ──────────────────────────────────────────────────────────

describe('P9 — phase transitions cannot be skipped', () => {
  it('refuses to seal after the deadline, from any caller', () => {
    const sim = auction();
    for (const caller of [ALICE, BOB, MALLORY, SELLER]) {
      expect(() => sim.commitBid(caller, bidCommitment(1_500n, ALICE_NONCE), AFTER_BIDDING_CLOSES)).toThrow(
        /bidding window has closed/,
      );
    }
  });

  it('refuses to reveal before the deadline, then accepts it at the deadline', () => {
    const sim = auction();
    sim.commitBid(ALICE, bidCommitment(1_500n, ALICE_NONCE), DURING_BIDDING);

    expect(() => sim.revealBid(ALICE, 1_500n, ALICE_NONCE, BIDDING_ENDS_AT - 1n)).toThrow(
      /bidding window has not closed yet/,
    );
    expect(() => sim.revealBid(ALICE, 1_500n, ALICE_NONCE, BIDDING_ENDS_AT)).not.toThrow();
  });

  it('refuses to settle before the reveal window closes even with a qualifying bid', () => {
    const sim = auction();
    sim.commitBid(ALICE, bidCommitment(5_000n, ALICE_NONCE), DURING_BIDDING);
    sim.revealBid(ALICE, 5_000n, ALICE_NONCE, AFTER_BIDDING_CLOSES);

    expect(() => sim.settle(BOB, REVEAL_ENDS_AT - 1n)).toThrow(/reveal window has not closed yet/);
    expect(() => sim.settle(BOB, REVEAL_ENDS_AT)).not.toThrow();
  });

  it('refuses any reveal at or after the reveal deadline', () => {
    const sim = auction();
    sim.commitBid(ALICE, bidCommitment(5_000n, ALICE_NONCE), DURING_BIDDING);

    expect(() => sim.revealBid(ALICE, 5_000n, ALICE_NONCE, REVEAL_ENDS_AT)).toThrow(/reveal window has closed/);
  });
});

// ─── P10: atomicity ───────────────────────────────────────────────────────────

describe('P10 — rejected calls leave the ledger untouched', () => {
  it('restores the previous state after each rejected operation', () => {
    const sim = auction();
    sim.commitBid(ALICE, bidCommitment(1_500n, ALICE_NONCE), DURING_BIDDING);
    const afterSeal = snapshot(sim.ledger);

    // Every one of these must fail without side effects.
    expect(() => sim.commitBid(ALICE, bidCommitment(9_999n, BOB_NONCE), DURING_BIDDING)).toThrow();
    expect(snapshot(sim.ledger)).toEqual(afterSeal);

    expect(() => sim.revealBid(ALICE, 1_501n, ALICE_NONCE, AFTER_BIDDING_CLOSES)).toThrow();
    expect(snapshot(sim.ledger)).toEqual(afterSeal);

    expect(() => sim.settle(BOB, AFTER_REVEAL_CLOSES)).toThrow();
    expect(snapshot(sim.ledger)).toEqual(afterSeal);

    expect(() => sim.cancel(MALLORY, DURING_BIDDING)).toThrow();
    expect(snapshot(sim.ledger)).toEqual(afterSeal);
  });

  it('does not leak a rejected opening into the openings map', () => {
    const sim = auction();
    sim.commitBid(ALICE, bidCommitment(1_500n, ALICE_NONCE), DURING_BIDDING);

    expect(() => sim.revealBid(ALICE, 1_501n, ALICE_NONCE, AFTER_BIDDING_CLOSES)).toThrow();
    expect(sim.ledger.openings.isEmpty()).toBe(true);
    expect(sim.ledger.highestBid).toBe(0n);
  });
});

// ─── P11: deterministic outcome ───────────────────────────────────────────────

describe('P11 — the outcome does not depend on who settles', () => {
  it('produces identical winners whichever account cranks settlement', () => {
    function run(settler: Uint8Array) {
      const sim = auction();
      sim.commitBid(ALICE, bidCommitment(4_000n, ALICE_NONCE), DURING_BIDDING);
      sim.commitBid(BOB, bidCommitment(6_000n, BOB_NONCE), DURING_BIDDING);
      sim.revealBid(ALICE, 4_000n, ALICE_NONCE, AFTER_BIDDING_CLOSES);
      sim.revealBid(BOB, 6_000n, BOB_NONCE, AFTER_BIDDING_CLOSES);
      sim.settle(settler, AFTER_REVEAL_CLOSES);
      return { winner: Buffer.from(sim.ledger.winner).toString('hex'), bid: sim.ledger.winningBid };
    }

    const bySeller = run(SELLER);
    const byAlice = run(ALICE);
    const byMallory = run(MALLORY);

    expect(byAlice).toEqual(bySeller);
    expect(byMallory).toEqual(bySeller);
    expect(bySeller.winner).toBe(Buffer.from(BOB).toString('hex'));
    expect(bySeller.bid).toBe(6_000n);
  });

  it('cannot be settled twice to rewrite the winner', () => {
    const sim = auction();
    sim.commitBid(ALICE, bidCommitment(4_000n, ALICE_NONCE), DURING_BIDDING);
    sim.commitBid(BOB, bidCommitment(6_000n, BOB_NONCE), DURING_BIDDING);
    sim.revealBid(ALICE, 4_000n, ALICE_NONCE, AFTER_BIDDING_CLOSES);
    sim.revealBid(BOB, 6_000n, BOB_NONCE, AFTER_BIDDING_CLOSES);

    sim.settle(SELLER, AFTER_REVEAL_CLOSES);
    expect(() => sim.settle(ALICE, AFTER_REVEAL_CLOSES)).toThrow(/auction is not active/);

    expect(Buffer.from(sim.ledger.winner).toString('hex')).toBe(Buffer.from(BOB).toString('hex'));
    expect(sim.ledger.winningBid).toBe(6_000n);
  });
});
