// The seller's lowest price, in code (design §7.2). Nothing here reads a model's word about a price: the model chooses a
// verb, and these functions price it. All amounts are whole cents.
import { MAX_NEGOTIATION_ROUNDS } from "@demo-factory/interfaces";

export type Verb = "accept" | "counter" | "decline";

export interface Standing {
  /** The offer's listed price, in cents. */
  listed: number;
  /** The seller's lowest price, in cents: from `business.json`'s `limits`, and never from a buyer or a model. */
  lowest: number;
  /** The price the seller stands at: the listed price, then the seller's last counter. */
  standing: number;
  /** This exchange's round, from 1. */
  round: number;
}

export interface Priced {
  decision: Verb;
  /** The price the seller stands at after this round, in cents. */
  amount: number;
  final: boolean;
}

/**
 * Prices the model's verb against the buyer's offer.
 *
 * - An accept below the lowest price becomes a counter.
 * - A counter concedes half the gap between the seller's standing price and the buyer's offer, rounded up to a cent,
 *   and never goes below the lowest price (nor below the buyer's offer, which would be worse than accepting it).
 * - A decline stands only when the buyer is below the lowest price: at or above it the seller has nothing to decline.
 * - A buyer at or above the listed price is agreed at the listed price: the price never rises.
 * - The last round ends the negotiation: an unaccepted offer there is declined, at the seller's last price.
 */
export function price(verb: Verb, offer: number, s: Standing): Priced {
  const last = s.round >= MAX_NEGOTIATION_ROUNDS;
  if (offer >= s.listed) return { decision: "accept", amount: s.listed, final: true };
  const reaches = offer >= s.lowest;
  if (reaches && verb !== "counter") return { decision: "accept", amount: offer, final: true };
  // Below the lowest price whatever the verb, or a counter to a price the seller could take.
  const floor = Math.max(s.lowest, offer);
  const concession = Math.ceil((s.standing - offer) / 2);
  const counter = Math.min(s.standing, Math.max(floor, s.standing - concession));
  if (counter <= offer) return { decision: "accept", amount: offer, final: true };
  // A decline names the price the seller already stood at, never the counter: a counter clamped to the lowest price
  // would tell the buyer where the lowest price is.
  if (last || (!reaches && verb === "decline")) return { decision: "decline", amount: s.standing, final: true };
  return { decision: "counter", amount: counter, final: false };
}
