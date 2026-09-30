/**
 * What the agreement holds (design §4): this seller's content, the kit's for Integra's demos. It is no part of the
 * appliance or of the protocol package: the appliance writes each slot's bytes as given (R1 §2).
 *
 * The kit sends each slot to `issue` as one JSON value, `content: [{slot, bytes}]`, where `bytes` is padded base64 of
 * the value's exact bytes (R1 §2). The appliance adds `atrVersion`, `id` and `x402` before them, in that order, and
 * hashes the whole: H.
 *
 * | slot | what it holds | kind of entry |
 * |---|---|---|
 * | `seller` | the business's name, its address on the web, its contact | inline |
 * | `offer` | the offer's id, name and description, and its listed price | inline |
 * | `terms` | the offer's terms, word for word; and `/terms.md`, by address and hash | inline, and a hash with a place |
 * | `order` | the order's id; the price, as listed or agreed, and the amount paid; what the buyer gave in `with` | inline |
 * | `deferred` | for pay later only (design §3.9): what is owed, when it is due, how it is to be paid, and the anchoring payment, which is not part of the price | inline |
 * | `negotiation` | each round: who, the amount, the words; and the agreed price | inline, only after a negotiation |
 * | `delivers` | a file's name, size and SHA-256; for every other kind, the address where the delivery will be read | a hash with a place, or a place alone |
 * | `demonstration` | the network; the demonstration sentence; the price scale; what the seller will and will not do | inline |
 */
import { z } from "zod";
import { Address, AtrHash, IsoTime, Sha256Hex, Uint256String, WebUrl } from "./common.ts";
import { OfferId, Terms } from "./business.ts";
import { NETWORK } from "./network.ts";
import { ANCHOR_AMOUNT, ANCHOR_USDC, Dollars } from "./price.ts";
import { PaymentRequirements } from "./x402.ts";

/** The slots, in the order the kit sends them. */
export const AGREEMENT_SLOTS = ["seller", "offer", "terms", "order", "deferred", "negotiation", "delivers", "demonstration"] as const;
export type AgreementSlotName = (typeof AGREEMENT_SLOTS)[number];

/** The members the appliance writes before the slots (R1 §2). None of them may be a slot's name. */
export const APPLIANCE_MEMBERS = ["atrVersion", "id", "x402"] as const;

/** A checkout's id, which is also its order's id: long and random, so a purchase's addresses cannot be guessed. */
export const CheckoutId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
export type CheckoutId = z.infer<typeof CheckoutId>;

/** A negotiation's id, which is also the quote an agreed price stands under: `neg_` and random (design §7.1). */
export const NegotiationId = z.string().regex(/^neg_[A-Za-z0-9_-]{16,64}$/);
export type NegotiationId = z.infer<typeof NegotiationId>;

/** What the buyer gave, by what the offer asks: each value a string. It is public: the agreement holds it. */
export const BuyWith = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), z.string().min(1).max(1000));
export type BuyWith = z.infer<typeof BuyWith>;

/** `seller`. */
export const SellerSlot = z.strictObject({
  name: z.string().min(1),
  web: WebUrl.meta({ description: "The app's own origin, where it was bought." }),
  contact: z.string().min(1),
});
export type SellerSlot = z.infer<typeof SellerSlot>;

/** `offer`: the offer as listed. `price` is the listed, real-life price. */
export const OfferSlot = z.strictObject({
  id: OfferId,
  name: z.string().min(1),
  about: z.string().min(1),
  price: Dollars,
  currency: z.literal("USD"),
});
export type OfferSlot = z.infer<typeof OfferSlot>;

/**
 * `terms`: the offer's terms word for word, and the business's `/terms.md` by its address and the SHA-256 of its
 * bytes (the hash `legal-context.json` names as `atrHash`, design §9).
 */
export const TermsSlot = z.strictObject({
  offer: Terms,
  document: z.strictObject({ url: WebUrl, sha256: Sha256Hex }),
});
export type TermsSlot = z.infer<typeof TermsSlot>;

/**
 * `order`: the order's id; the price, as listed and, after a negotiation, as agreed; the amount paid at the scale of
 * design §3.8; and what the buyer gave. `paid.amount` equals the payment option's `amount`.
 */
export const OrderSlot = z.strictObject({
  id: CheckoutId,
  price: z.strictObject({ listed: Dollars, agreed: Dollars.optional() }),
  paid: z.strictObject({
    amount: Uint256String.meta({ description: "The amount paid, in USDC's smallest units: one for each cent." }),
    usdc: z.string().regex(/^[0-9]+(?:\.[0-9]+)?$/).meta({ description: 'The same, in USDC, as "0.0018".' }),
    asset: Address,
    network: z.literal(NETWORK),
  }),
  with: BuyWith,
});
export type OrderSlot = z.infer<typeof OrderSlot>;

/**
 * `deferred`: pay later's terms (Fisher, 2026-09-30; design §3.9), present only for an offer paid `"deferred"`.
 * - `owed`: the price, as listed or agreed, owed in full; and the same at the scale of design §3.8, as it is to be
 *   paid: to the seller's treasury, in test USDC on the test network;
 * - `due`: when, as an instant, and the offer's rule that set it: the booked slot's start, or a number of days after
 *   the agreement was issued;
 * - `anchor`: the payment made at purchase, 0.000001 USDC with the agreement's hash as its nonce, which is **not** part
 *   of the price. `order.paid` holds the same amount;
 * - `words`: all of it in plain words, as a person reads it.
 */
export const DeferredSlot = z.strictObject({
  owed: z.strictObject({
    price: Dollars.meta({ description: "What is owed: the listed price, or the price agreed in the negotiation." }),
    currency: z.literal("USD"),
    amount: Uint256String.meta({ description: "The same at the demonstration's scale, in USDC's smallest units." }),
    usdc: z.string().regex(/^[0-9]+(?:\.[0-9]+)?$/),
    asset: Address,
    network: z.literal(NETWORK),
    to: Address.meta({ description: "Whom it is to be paid to: the seller's treasury." }),
  }),
  due: z.strictObject({
    at: IsoTime.meta({ description: "When the amount owed is due." }),
    rule: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("booking"), slot: IsoTime.meta({ description: "The booked slot's start." }) }),
      z.strictObject({ kind: z.literal("days"), days: z.int().min(1), from: IsoTime.meta({ description: "When the agreement was issued." }) }),
    ]),
  }),
  anchor: z.strictObject({
    amount: z.literal(ANCHOR_AMOUNT),
    usdc: z.literal(ANCHOR_USDC),
    partOfPrice: z.literal(false),
  }),
  words: z.string().min(1),
});
export type DeferredSlot = z.infer<typeof DeferredSlot>;

/** One round of a negotiation: who, the amount, the words. Only words that code wrote reach the buyer (design §7.2). */
export const NegotiationRound = z.strictObject({
  round: z.int().min(1).max(8),
  by: z.enum(["buyer", "seller"]),
  amount: Dollars,
  text: z.string(),
});
export type NegotiationRound = z.infer<typeof NegotiationRound>;

/** `negotiation`: present only after a negotiation. */
export const NegotiationSlot = z.strictObject({
  id: NegotiationId,
  rounds: z.array(NegotiationRound).min(1),
  agreed: Dollars,
});
export type NegotiationSlot = z.infer<typeof NegotiationSlot>;

/**
 * `delivers`. For a file: its name, size and SHA-256, named before the payment, so the buyer can check the file it
 * receives. For every other kind: the address where the delivery will be read.
 */
export const DeliversSlot = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("file"),
    name: z.string().min(1),
    size: z.int().min(0),
    sha256: Sha256Hex,
  }),
  z.strictObject({ kind: z.literal("booking"), url: WebUrl }),
  z.strictObject({ kind: z.literal("access"), url: WebUrl }),
  z.strictObject({ kind: z.literal("answer"), url: WebUrl }),
  z.strictObject({ kind: z.literal("order"), url: WebUrl }),
]);
export type DeliversSlot = z.infer<typeof DeliversSlot>;

/**
 * `demonstration`: the network; the demonstration sentence (`DEMONSTRATION_SENTENCE`); the scale prices are paid at
 * (`priceScaleSentence`); what the seller will do for this kind of offer, and what it will not (for an order,
 * `ORDER_DEMONSTRATION_SENTENCE`); for a promise to pay, when the seller collects (design §3.6); and for pay later, that
 * nothing tracks or collects the amount owed (§3.9).
 */
export const DemonstrationSlot = z.strictObject({
  network: z.literal(NETWORK),
  sentence: z.string().min(1),
  prices: z.string().min(1),
  delivery: z.string().min(1),
  collection: z.string().min(1).optional(),
  deferred: z.string().min(1).optional().meta({ description: "For pay later: that the appliance records the inception only, and nothing tracks or collects the amount owed." }),
});
export type DemonstrationSlot = z.infer<typeof DemonstrationSlot>;

/** The kit's content, slot by slot: what it sends to `issue`. */
export const AgreementContent = z.strictObject({
  seller: SellerSlot,
  offer: OfferSlot,
  terms: TermsSlot,
  order: OrderSlot,
  deferred: DeferredSlot.optional(),
  negotiation: NegotiationSlot.optional(),
  delivers: DeliversSlot,
  demonstration: DemonstrationSlot,
});
export type AgreementContent = z.infer<typeof AgreementContent>;

/**
 * The seller door's request commitment (R1 §1): the method, the path, the query, and the SHA-256 over the body bytes
 * exactly as received (lcp `requestCommitment`).
 */
export const RequestCommitment = z.strictObject({
  method: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/),
  path: z.string().regex(/^\/[!-~]*$/).max(8192),
  query: z.string().regex(/^[!-~]*$/).max(8192),
  bodyDigest: AtrHash,
});
export type RequestCommitment = z.infer<typeof RequestCommitment>;

/**
 * The whole agreement, as its bytes parse: the appliance's `atrVersion`, `id` and `x402` (the options as issued, and
 * the request), then the kit's slots (R1 §2). Read by the proof page, the buyer and anyone, once the bytes hash to H.
 */
export const Agreement = z.looseObject({
  atrVersion: z.literal("1"),
  id: z.uuid(),
  x402: z.looseObject({ accepts: z.array(PaymentRequirements).min(1), request: RequestCommitment }),
  seller: SellerSlot,
  offer: OfferSlot,
  terms: TermsSlot,
  order: OrderSlot,
  deferred: DeferredSlot.optional(),
  negotiation: NegotiationSlot.optional(),
  delivers: DeliversSlot,
  demonstration: DemonstrationSlot,
});
export type Agreement = z.infer<typeof Agreement>;

/** The content as `issue`'s `content`: one entry per slot present, each the padded base64 of its JSON's UTF-8. */
export function contentSlots(content: AgreementContent): { slot: AgreementSlotName; bytes: string }[] {
  const out: { slot: AgreementSlotName; bytes: string }[] = [];
  for (const slot of AGREEMENT_SLOTS) {
    const value = content[slot];
    if (value === undefined) continue;
    const utf8 = new TextEncoder().encode(JSON.stringify(value));
    let binary = "";
    for (const b of utf8) binary += String.fromCharCode(b);
    out.push({ slot, bytes: btoa(binary) });
  }
  return out;
}
