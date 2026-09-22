import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export enum AuctionStatus { ACTIVE = 0, SETTLED = 1, CANCELLED = 2 }

export type Witnesses<PS> = {
}

export type ImpureCircuits<PS> = {
  commitBid(context: __compactRuntime.CircuitContext<PS>,
            commitment_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  revealBid(context: __compactRuntime.CircuitContext<PS>,
            amount_0: bigint,
            nonce_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  settle(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
  cancel(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
}

export type ProvableCircuits<PS> = {
  commitBid(context: __compactRuntime.CircuitContext<PS>,
            commitment_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  revealBid(context: __compactRuntime.CircuitContext<PS>,
            amount_0: bigint,
            nonce_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  settle(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
  cancel(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
}

export type PureCircuits = {
  bidCommitment(amount_0: bigint, nonce_0: Uint8Array): Uint8Array;
}

export type Circuits<PS> = {
  commitBid(context: __compactRuntime.CircuitContext<PS>,
            commitment_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  revealBid(context: __compactRuntime.CircuitContext<PS>,
            amount_0: bigint,
            nonce_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  settle(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
  cancel(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
  bidCommitment(context: __compactRuntime.CircuitContext<PS>,
                amount_0: bigint,
                nonce_0: Uint8Array): __compactRuntime.CircuitResults<PS, Uint8Array>;
}

export type Ledger = {
  readonly seller: Uint8Array;
  readonly lot: Uint8Array;
  readonly reservePrice: bigint;
  readonly biddingEndsAt: bigint;
  readonly revealEndsAt: bigint;
  readonly status: AuctionStatus;
  commitments: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): Uint8Array;
    [Symbol.iterator](): Iterator<[Uint8Array, Uint8Array]>
  };
  readonly bidderCount: bigint;
  openings: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): bigint;
    [Symbol.iterator](): Iterator<[Uint8Array, bigint]>
  };
  readonly highestBid: bigint;
  readonly highestBidder: Uint8Array;
  readonly winningBid: bigint;
  readonly winner: Uint8Array;
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>,
               lotRef_0: Uint8Array,
               reserve_0: bigint,
               biddingEnd_0: bigint,
               revealEnd_0: bigint): __compactRuntime.ConstructorResult<PS>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
