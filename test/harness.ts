/**
 * Off-chain harness that executes the *real* compiled SealedBid contract.
 *
 * Unlike a hand-written simulator, this drives the JavaScript emitted by the
 * Compact compiler via the Compact runtime, so every assertion, ledger
 * operation and commitment rule exercised here is the one that runs in a
 * transaction. Each "caller" is modelled by the coin public key handed to the
 * circuit context, which is exactly what `ownPublicKey()` resolves to in a
 * real transaction.
 */

import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import type { ChargedState, ContractAddress, StateValue } from '@midnight-ntwrk/compact-runtime';

import {
  AuctionStatus,
  Contract,
  ledger,
  pureCircuits,
  type Ledger,
} from '../contracts/managed/sealed-bid/contract/index.js';

export { AuctionStatus, pureCircuits };
export type { Ledger };

/** Private state for this contract is empty: the contract declares no witnesses. */
export type SealedBidPrivateState = Record<string, never>;

export const EMPTY_PRIVATE_STATE: SealedBidPrivateState = {};

export const BYTES_32 = 32;

/** Deterministic 32-byte fixture, e.g. `bytes(7)` -> 0x0707...07. */
export function bytes(fill: number): Uint8Array {
  return new Uint8Array(BYTES_32).fill(fill & 0xff);
}

/** Zero-padded 32-byte encoding of a short ASCII string. */
export function toBytes32(text: string): Uint8Array {
  const out = new Uint8Array(BYTES_32);
  const encoded = new TextEncoder().encode(text);
  if (encoded.length > BYTES_32) {
    throw new Error(`toBytes32: "${text}" is longer than ${BYTES_32} bytes`);
  }
  out.set(encoded);
  return out;
}

export interface AuctionOptions {
  /** Lot reference; defaults to a deterministic fixture. */
  lotRef?: Uint8Array;
  /** Reserve price in the auction's unit of account. Must be > 0. */
  reserve?: bigint;
  /** Unix seconds at which sealed bidding closes. */
  biddingEndsAt: bigint;
  /** Unix seconds at which the reveal window closes. */
  revealEndsAt: bigint;
  /** Coin public key of the deploying seller. */
  seller?: Uint8Array;
}

/**
 * One in-memory auction: the deployed contract state plus the contract address
 * and the Zswap identity used to run each call.
 */
export class AuctionHarness {
  readonly contract = new Contract(EMPTY_PRIVATE_STATE as never);
  readonly address: ContractAddress = sampleContractAddress();
  readonly seller: Uint8Array;

  private state: StateValue | ChargedState;

  constructor(opts: AuctionOptions) {
    this.seller = opts.seller ?? bytes(0xa1);
    // The runtime resolves `ownPublicKey()` from the context's Zswap local state,
    // which expects the encoded `{ bytes }` form of a coin public key.
    const constructorContext = createConstructorContext(EMPTY_PRIVATE_STATE, { bytes: this.seller });
    const initial = this.contract.initialState(
      constructorContext,
      opts.lotRef ?? toBytes32('lot:rusty-lantern'),
      opts.reserve ?? 100n,
      opts.biddingEndsAt,
      opts.revealEndsAt,
    );
    // `ContractState.data` is the ChargedState the generated `ledger()` accepts.
    this.state = initial.currentContractState.data;
  }

  /** Current public ledger state, decoded through the generated accessors. */
  get ledger(): Ledger {
    return ledger(this.state);
  }

  /** Current lifecycle status as the contract reports it. */
  get status(): AuctionStatus {
    return this.ledger.status;
  }

  /**
   * Run an exported circuit as `caller` at block time `at`.
   * Returns the raw runtime result so callers can inspect it or assert throws.
   */
  private run<T>(
    circuit: (context: ReturnType<typeof createCircuitContext>, ...args: any[]) => T,
    caller: Uint8Array,
    at: bigint,
    args: unknown[],
  ): T {
    const context = createCircuitContext(
      this.address,
      { bytes: caller },
      this.state,
      EMPTY_PRIVATE_STATE,
      undefined,
      undefined,
      Number(at),
    );
    const result = circuit(context, ...args);
    // Only commit the new state when the circuit succeeded.
    const next = (result as unknown as { context: { currentQueryContext: { state: StateValue | ChargedState } } })
      .context.currentQueryContext.state;
    this.state = next;
    return result;
  }

  /** Seal a bid. `commitment` is the output of {@link bidCommitment}. */
  commitBid(caller: Uint8Array, commitment: Uint8Array, at: bigint) {
    return this.run(this.contract.impureCircuits.commitBid, caller, at, [commitment]);
  }

  /** Open a previously sealed bid. */
  revealBid(caller: Uint8Array, amount: bigint, nonce: Uint8Array, at: bigint) {
    return this.run(this.contract.impureCircuits.revealBid, caller, at, [amount, nonce]);
  }

  /** Settle the auction. */
  settle(caller: Uint8Array, at: bigint) {
    return this.run(this.contract.impureCircuits.settle, caller, at, []);
  }

  /** Cancel the auction. */
  cancel(caller: Uint8Array, at: bigint) {
    return this.run(this.contract.impureCircuits.cancel, caller, at, []);
  }
}

/** Commitment for `(amount, nonce)`, computed by the contract's own pure circuit. */
export function bidCommitment(amount: bigint, nonce: Uint8Array): Uint8Array {
  return pureCircuits.bidCommitment(amount, nonce);
}
