/**
 * Negotiation (design §7). No published standard exists for it (R3 §6), so the exchange is the app's own, carried by
 * a published means: the MCP tool `negotiate`, and the same over HTTP at `POST /negotiate/<offer>`. v3's is carried
 * (R4 Q7):
 *
 * ```
 * negotiate { offer, amount, text, negotiation? }
 *    →      { negotiation, round, decision: "accept" | "counter" | "decline", amount, text, final }
 * ```
 *
 * - Amounts are dollars and cents (design §3.8): negotiation is in cents, so an agreed price is paid exactly.
 * - At most `MAX_NEGOTIATION_ROUNDS` rounds. A price that stands is held for `QUOTE_HOLD_SECONDS`, under the
 *   negotiation's id, `neg_…`, which the buyer names as `quote` in its buy request. A quote pays once (design §7.4).
 * - The seller's lowest price is in code, never in the model's prompt: an accept below it becomes a counter, and a
 *   counter concedes half the gap, rounded up to a cent, never below it. The buyer receives only sentences code wrote.
 */
import { z } from "zod";
import { NegotiationId } from "./agreement.ts";
import { OfferId } from "./business.ts";
import { Dollars } from "./price.ts";

export const MAX_NEGOTIATION_ROUNDS = 4 as const;
export const QUOTE_HOLD_SECONDS = 600 as const;

export const Decision = z.enum(["accept", "counter", "decline"]);
export type Decision = z.infer<typeof Decision>;

/** The buyer's move: the price it proposes, its words, and, after the first round, the negotiation it continues. */
export const NegotiateRequest = z.strictObject({
  offer: OfferId,
  amount: Dollars.meta({ description: "The price the buyer proposes, in dollars and cents." }),
  text: z.string().max(1000).meta({ description: "The buyer's words." }),
  negotiation: NegotiationId.optional().meta({ description: "The negotiation to continue; absent on the first round." }),
});
export type NegotiateRequest = z.infer<typeof NegotiateRequest>;

/** `POST /negotiate/<offer>`'s body: the same, with the offer in the path. */
export const NegotiateBody = NegotiateRequest.omit({ offer: true });
export type NegotiateBody = z.infer<typeof NegotiateBody>;

/**
 * The seller's answer. `amount` is the price the seller stands at: the buyer's on `accept`, the seller's counter on
 * `counter`, its last price on `decline`. `final` is true when the negotiation is over: after an accept, a decline, or
 * the last round. After an accept, `negotiation` is the quote, good for `QUOTE_HOLD_SECONDS`, for one purchase.
 */
export const NegotiateAnswer = z.strictObject({
  negotiation: NegotiationId,
  round: z.int().min(1).max(MAX_NEGOTIATION_ROUNDS),
  decision: Decision,
  amount: Dollars,
  text: z.string(),
  final: z.boolean(),
  expiresAt: z.iso.datetime().optional().meta({ description: "When an accepted price stops standing." }),
});
export type NegotiateAnswer = z.infer<typeof NegotiateAnswer>;

/** The negotiation's refusals, each with its HTTP status. Over MCP each is an `isError` result with the same body. */
export const NEGOTIATION_REFUSALS = {
  "negotiate/offer-unknown": { status: 404, sentence: "No offer has this id." },
  "negotiate/malformed": { status: 400, sentence: "The request is not { amount, text, negotiation? } with a price in dollars and cents." },
  "negotiate/not-negotiable": { status: 409, sentence: "This offer's price is not open to negotiation." },
  "negotiate/unknown": { status: 404, sentence: "No open negotiation has this id for this offer." },
  "negotiate/over": { status: 409, sentence: "This negotiation is over." },
} as const satisfies Record<string, { status: number; sentence: string }>;
export type NegotiationRefusalCode = keyof typeof NEGOTIATION_REFUSALS;
