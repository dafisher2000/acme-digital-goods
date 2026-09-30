// Negotiation (design §7): the exchange, the seller's agent, and the lowest price in code.
import {
  CHECKOUT_REFUSALS,
  MAX_NEGOTIATION_ROUNDS,
  NEGOTIATION_REFUSALS,
  NegotiateBody,
  QUOTE_HOLD_SECONDS,
  centsToDollars,
  dollarsToCents,
  type KitContext,
  type KitHandler,
  type KitNegotiation,
  type NegotiateAnswer,
  type NegotiateRequest,
  type NegotiationId,
  type NegotiationRow,
  type NewEvent,
  type Refusal,
} from "@demo-factory/interfaces";
import { choose, type Turn } from "./agent.ts";
import { price, type Verb } from "./rules.ts";

type Refused = { status: number; refusal: Refusal };

function refuse(code: keyof typeof NEGOTIATION_REFUSALS): Refused {
  const r = NEGOTIATION_REFUSALS[code];
  return { status: r.status, refusal: { code, sentence: r.sentence } };
}

function newId(): NegotiationId {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return `neg_${btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}` as NegotiationId;
}

/** The words the buyer receives. Code writes every one of them (design §7.2); no model's sentence reaches a buyer. */
function words(decision: Verb, amount: string): string {
  if (decision === "accept") {
    return `Agreed at $${amount}. This price stands for ${QUOTE_HOLD_SECONDS / 60} minutes, for one purchase: name this negotiation as the quote when you buy.`;
  }
  if (decision === "counter") return `I can do $${amount}.`;
  return `I cannot agree a price. My last price is $${amount}.`;
}

async function emit(ctx: KitContext, e: NewEvent): Promise<void> {
  await ctx.store.append(e);
}

export async function negotiate(request: NegotiateRequest, ctx: KitContext): Promise<NegotiateAnswer | Refused> {
  const offer = ctx.business.offers.find((o) => o.id === request.offer);
  if (!offer) return refuse("negotiate/offer-unknown");
  // The lowest price: read here, from business.json, and nowhere else. It goes into no prompt and no answer.
  const lowestPrice = offer.limits?.lowest;
  if (lowestPrice === undefined) return refuse("negotiate/not-negotiable");

  let row: NegotiationRow;
  if (request.negotiation) {
    const found = await ctx.store.negotiation(request.negotiation);
    if (!found || found.offer !== offer.id) return refuse("negotiate/unknown");
    if (found.final) return refuse("negotiate/over");
    row = found;
  } else {
    row = { id: newId(), offer: offer.id, rounds: [], final: false, reasons: [] };
  }

  const round = row.rounds.filter((r) => r.by === "buyer").length + 1;
  const listed = dollarsToCents(offer.price);
  const lowest = dollarsToCents(lowestPrice);
  const offerCents = dollarsToCents(request.amount);
  const lastSeller = [...row.rounds].reverse().find((r) => r.by === "seller");
  const standing = lastSeller ? dollarsToCents(lastSeller.amount) : listed;

  row.rounds.push({ round, by: "buyer", amount: request.amount, text: request.text });
  await emit(ctx, {
    side: "buyer",
    source: "reported",
    step: "negotiation/round",
    text: `The buyer proposed $${request.amount} in round ${round}.`,
    data: { negotiation: row.id, round, by: "buyer", amount: request.amount, text: request.text },
  });

  // The model chooses a verb. The plain rule stands in when there is no model or it fails.
  const state = { listed, lowest, standing, round };
  const rule: Verb = offerCents >= lowest ? "accept" : "counter";
  const history: Turn[] = row.rounds.map((r) => ({ round: r.round, by: r.by, amount: r.amount, text: r.text }));
  const choice = ctx.settings.sellerModel
    ? await choose(ctx.ai, ctx.settings.sellerModel, ctx.business, offer, history, round, offerCents, rule)
    : { verb: rule, reason: "no model is set: the plain rule chose", model: null };
  row.reasons.push(`round ${round}: ${choice.verb}: ${choice.reason}`);
  await emit(ctx, {
    side: "seller",
    source: "generated",
    step: "agent/decision",
    text: `The seller's agent chose "${choice.verb}" in round ${round}.`,
    data: { negotiation: row.id, role: "seller", model: choice.model, decision: choice.verb, reason: choice.reason },
  });

  // Code prices the verb. Whatever the model said, a price below the lowest is never agreed.
  const priced = price(choice.verb, offerCents, state);
  const amount = centsToDollars(priced.amount);
  const text = words(priced.decision, amount);
  row.rounds.push({ round, by: "seller", amount, text });
  row.final = priced.final;
  let expiresAt: number | undefined;
  if (priced.decision === "accept") {
    row.agreed = amount;
    expiresAt = Math.floor(Date.now() / 1000) + QUOTE_HOLD_SECONDS;
    row.expiresAt = expiresAt;
  }
  await ctx.store.putNegotiation(row);
  await emit(ctx, {
    side: "seller",
    source: "measured",
    step: "negotiation/round",
    text: `The seller ${priced.decision === "accept" ? "accepted" : priced.decision === "counter" ? "countered" : "declined"} at $${amount} in round ${round}.`,
    data: { negotiation: row.id, round, by: "seller", amount, text, decision: priced.decision },
  });
  if (priced.decision === "accept") {
    await emit(ctx, {
      side: "seller",
      source: "measured",
      step: "negotiation/agreed",
      text: amount === offer.price ? `A price of $${amount}, the listed price, was agreed.` : `A price of $${amount} was agreed, below the listed $${offer.price}.`,
      data: { negotiation: row.id, amount },
    });
  }

  const answer: NegotiateAnswer = {
    negotiation: row.id,
    round,
    decision: priced.decision,
    amount,
    text,
    final: priced.final,
  };
  if (expiresAt !== undefined) answer.expiresAt = new Date(expiresAt * 1000).toISOString();
  return answer;
}

/** An agreed price for the checkout (design §7.3): this offer's, unexpired and unused. It is marked used at the claim. */
export async function quote(offerId: string, id: NegotiationId, ctx: KitContext) {
  const bad = { refusal: { code: "checkout/quote-invalid", sentence: CHECKOUT_REFUSALS["checkout/quote-invalid"].sentence } };
  const row = await ctx.store.negotiation(id);
  if (!row || row.offer !== offerId || row.agreed === undefined || row.usedBy !== undefined) return bad;
  if (row.expiresAt === undefined || row.expiresAt <= Math.floor(Date.now() / 1000)) return bad;
  return { agreed: row.agreed, slot: { id: row.id, rounds: row.rounds, agreed: row.agreed } };
}

/** What the checkout and the agent door call. */
export const negotiation: KitNegotiation = { negotiate, quote };

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

/** `POST /negotiate/<offer>`: the exchange over HTTP. */
export const route: KitHandler = async (request, params, ctx) => {
  const offer = params.offer ?? "";
  if (request.method !== "POST") return json({ code: "negotiate/malformed", sentence: NEGOTIATION_REFUSALS["negotiate/malformed"].sentence }, 405);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ code: "negotiate/malformed", sentence: NEGOTIATION_REFUSALS["negotiate/malformed"].sentence }, 400);
  }
  const parsed = NegotiateBody.safeParse(body);
  if (!parsed.success) {
    return json({ code: "negotiate/malformed", sentence: NEGOTIATION_REFUSALS["negotiate/malformed"].sentence }, 400);
  }
  const out = await negotiate({ ...parsed.data, offer } as NegotiateRequest, ctx);
  if ("refusal" in out) return json(out.refusal, out.status);
  return json(out, 200);
};
