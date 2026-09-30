/**
 * One envelope for every event (design §8.2), v3's carried (R4 Q1), in the app's stream and in the buyer service's:
 *
 * ```
 * { seq, t, side, source, step, text, data }
 *    side:   "buyer" | "seller" | "appliance" | "chain"
 *    source: "measured" | "reported" | "generated"
 * ```
 *
 * - `side` is the party that said it: a proof page draws each fact under that party (design §8.3). Every answer of
 *   `issue`, `claim`, `report` and `status` is `appliance`, `reported`. The facilitator's answers are the rail's word,
 *   `chain`, `reported`; a stream's own read of the chain is `chain`, `measured`.
 * - `source`: `measured` is what the stream's owner observed itself; `reported` is another party's word, as it was
 *   given; `generated` is a model's.
 * - `text` is one plain sentence, and never states a value `data` lacks.
 *
 * **The steps.** v3 named its steps as a closed list and kept `x/*` open (R4 Q1). The design names no list for v4, so
 * this module names one: each step of design §3–§7 and §10.3, with the side and source it is emitted with. A step not
 * in the list is written `x/<name>`.
 *
 * **Joining the two streams** (design §10.2). A demo's page follows a run in two streams and joins them on what both
 * sides saw: first the negotiation's id, then the hash the challenge advertised. So an event that concerns a purchase
 * carries, in `data`, whichever of these it knows: `negotiation` (`neg_…`), `advertised` (the hash the challenge
 * carried, which is H everywhere but at the test checkout), and `atrHash` (H). The app's events also carry
 * `checkout`, and the buyer's `run`.
 */
import { z } from "zod";
import { IsoTime, JsonObject } from "./common.ts";

export const Side = z.enum(["buyer", "seller", "appliance", "chain"]);
export type Side = z.infer<typeof Side>;

export const Source = z.enum(["measured", "reported", "generated"]);
export type Source = z.infer<typeof Source>;

/** Each named step, with the side and source it is emitted with, and what its `data` holds. */
export const STEPS = {
  // --- both streams -----------------------------------------------------------------------------------------------
  "agent/decision": { side: "buyer|seller", source: "generated", data: "{role, model, decision, reason}: a model's choice, with its reason" },
  "negotiation/round": { side: "buyer|seller", source: "measured|reported|generated", data: "{negotiation, round, by, amount, text}" },
  "negotiation/agreed": { side: "seller", source: "measured|reported", data: "{negotiation, amount}: the agreed price, in dollars" },
  refusal: { side: "buyer|seller", source: "measured|reported", data: "{code, sentence, status?}" },
  "chain/read": { side: "chain", source: "measured", data: "{what: 'payment'|'capture', transaction, state, block?, value?, salt?}: the stream's own read of the chain" },

  // --- the app's stream (design §3, §5, §6) ----------------------------------------------------------------------
  "checkout/opened": { side: "seller", source: "measured", data: "{checkout, offer, door, price, amount, negotiation?}" },
  issue: { side: "appliance", source: "reported", data: "{checkout, atrHash, link, expiresAt, mintRequestId}: issue's answer" },
  challenge: { side: "seller", source: "measured", data: "{checkout, atrHash, advertised, door, required}: the 402 as sent" },
  "payment/arrived": { side: "seller", source: "measured", data: "{checkout?, advertised?, carried, door}: a payment reached the door, and the hash it carried" },
  "checkout/state": { side: "seller", source: "measured", data: "{checkout, atrHash, state, was}: a change of the checkout's state" },
  verify: { side: "chain", source: "reported", data: "{checkout, atrHash, response}: the facilitator's /verify answer" },
  claim: { side: "appliance", source: "reported", data: "{checkout, atrHash, state, proves} or the refusal: claim's answer" },
  settle: { side: "chain", source: "reported", data: "{checkout, atrHash, response}: the facilitator's /settle answer" },
  report: { side: "appliance", source: "reported", data: "{checkout, atrHash, record}: report's answer" },
  status: { side: "appliance", source: "reported", data: "{checkout, atrHash, record, takenAt}: status's answer, the copy the app keeps" },
  delivery: { side: "seller", source: "measured", data: "{checkout, atrHash, kind, size, sha256, url?}: what was delivered" },
  capture: { side: "chain", source: "reported", data: "{checkout, atrHash, response}: the facilitator's /capture answer" },
  "test/outcome": { side: "seller", source: "measured", data: "{checkout, atrHash, advertised, outcome, carried?}: design §6's four outcomes" },

  // --- the buyer service's stream (design §10.3) ------------------------------------------------------------------
  "run/started": { side: "buyer", source: "measured", data: "{run, seller, goal, budget, offer?, door, test}" },
  read: { side: "buyer", source: "measured", data: "{run, ucp, legalContext, catalogue}: what the demo publishes" },
  "challenge/read": { side: "buyer", source: "measured", data: "{run, advertised, link, door, required}: the challenge as received" },
  "atr/fetched": { side: "buyer", source: "measured", data: "{run, advertised, link, size, sha256}: the agreement's bytes, kept" },
  "atr/compared": { side: "buyer", source: "measured", data: "{run, advertised, computed, equal}" },
  "atr/deferred": {
    side: "buyer",
    source: "measured",
    data: "{run, owed, owedAmount, due, rule, anchor, amount, budget, within}: pay later's terms, as the buyer read them in the agreement it checked, and its bound held against what is owed",
  },
  "signer/called": { side: "buyer", source: "measured", data: "{run, advertised, count}: every signature, counted" },
  "payment/sent": { side: "buyer", source: "measured", data: "{run, advertised, door, carries}" },
  answer: { side: "seller", source: "reported", data: "{run, advertised, status, receipt?}: the seller's answer to the paid request" },
  "delivery/received": { side: "buyer", source: "measured", data: "{run, advertised, kind, size, sha256}: what was received, hashed" },
  "judge/verdict": { side: "buyer", source: "generated", data: "{run, scenario, proves, reasons}" },
  "run/finished": { side: "buyer", source: "measured", data: "{run, outcome}" },
} as const;
export type KnownStep = keyof typeof STEPS;

const knownSteps = Object.keys(STEPS) as [KnownStep, ...KnownStep[]];

/** A step: one of `STEPS`, or `x/<name>` for any other. */
export const Step = z.union([z.enum(knownSteps), z.string().regex(/^x\/[a-z0-9]+(?:[/-][a-z0-9]+)*$/)]);
export type Step = KnownStep | `x/${string}`;

/** The keys that join the app's stream and the buyer's (design §10.2), as `data` carries them. */
export const JOIN_KEYS = ["negotiation", "advertised"] as const;

/** One event. */
export const EventEnvelope = z.strictObject({
  seq: z.int().min(1).meta({ description: "From 1 in each stream, with no gaps." }),
  t: IsoTime.meta({ description: "From the stream owner's clock." }),
  side: Side,
  source: Source,
  step: Step,
  text: z.string().min(1).meta({ description: "One plain sentence, which never states a value data lacks." }),
  data: JsonObject,
});
export type EventEnvelope = Omit<z.infer<typeof EventEnvelope>, "step"> & { step: Step };

/**
 * An event as one server-sent event: `id` is `seq`, so a client takes up again from `Last-Event-ID`; `data` is the
 * envelope's JSON on one line. There is no `event` field, so `onmessage` receives every event.
 */
export function sseFrame(event: EventEnvelope): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
}
