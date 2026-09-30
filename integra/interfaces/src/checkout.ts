/**
 * The checkout (design §3): one checkout, two doors. The HTTP door hands it a request; the MCP door turns a tool call
 * into that request, and the answer back into a tool result (§3.1). The test checkout (§6) is the same shape at
 * `/test/buy/<offer>` and `test_buy`.
 *
 * **Over HTTP** (x402 v2, `transports-v2/http.md`):
 * - `POST /buy/<offer>` with `BuyRequest` as JSON; `GET /buy/<offer>` for an offer that asks for nothing.
 * - Unpaid: `402`, `PAYMENT-REQUIRED` = base64 of the challenge, and the challenge as the JSON body too.
 * - Paid, with `PAYMENT-SIGNATURE` = base64 of the payment, repeating the unpaid request exactly (method, path, query,
 *   body), because the request commitment covers them (R1 §4):
 *   - settled: `200`, `PAYMENT-RESPONSE` = base64 of the facilitator's settle answer, and `BuyPaid` as the body;
 *   - sent, not yet confirmed: `202`, `PAYMENT-RESPONSE` with `settlement_pending` and the transaction, and the
 *     `Purchase` as the body (v3's convention, the design's choice, §3.5);
 *   - a payment `/verify` refuses: `402`, the same challenge with its `error` set to the reason (§3.4, step 4);
 *   - any other refusal: its status, and a `Refusal` as the body (`CHECKOUT_REFUSALS`).
 *
 * **Over MCP** (x402 v2, `transports-v2/mcp.md`; design §3.5): the tool `buy {offer, quote?, with?}` stands for
 * `POST /buy/<offer>`, whose body is the RFC 8785 form of `{quote, with}`.
 * - Unpaid: `McpPaymentRequiredResult`, with `resource.url` `mcp://tool/buy`: the only way it differs from HTTP's.
 * - Paid: the payment in `params._meta["x402/payment"]`; the result's `structuredContent` is `BuyPaid`, and
 *   `_meta["x402/payment-response"]` is the settle answer.
 * - Pending: a result that is **not** an error, whose text says the payment was sent and is not yet confirmed, whose
 *   `structuredContent` is the `Purchase`, and whose receipt carries `settlement_pending` and the transaction.
 * - A refusal: `isError: true`, with the `Refusal` as `structuredContent` and as JSON in `content[0].text`.
 * - Every result carries `resultType: "complete"`; the paid tools declare no `outputSchema`.
 *
 * A payment is presented at the door that challenged it (§3.2).
 */
import { z } from "zod";
import { BuyWith, CheckoutId, NegotiationId } from "./agreement.ts";
import { Address, AtrHash, IsoTime, Refusal, Sha256Hex, TransactionHash, Uint256String, WebUrl } from "./common.ts";
import { OfferId, PAYMENTS } from "./business.ts";
import { DEMONSTRATION_SENTENCE } from "./demonstration.ts";
import { AUTH_CAPTURE_ESCROW, NETWORK, USDC } from "./network.ts";
import { Dollars } from "./price.ts";
import { mcpToolResourceUrl, type ResourceInfo } from "./x402.ts";

// ---------------------------------------------------------------------------------------------------------------------
// Lifetimes (design §3.3, §3.6, §6)
// ---------------------------------------------------------------------------------------------------------------------

/** How long a checkout can be claimed: `lifetimeSeconds` on `issue`. */
export const CHECKOUT_LIFETIME_SECONDS = 900 as const;
/** How long the test checkout's agreement lives. */
export const TEST_CHECKOUT_LIFETIME_SECONDS = 120 as const;
/** How long a signature stays good: every option's `maxTimeoutSeconds`. The buyer's clock starts when it checks. */
export const MAX_TIMEOUT_SECONDS = 300 as const;
/** A promise to pay's capture deadline, after the checkout is issued: a day (design §3.6). */
export const CAPTURE_DEADLINE_SECONDS = 86_400 as const;

/**
 * `mintRequestId`: `<app>:<checkout id>`, a new one for every unpaid request (design §3.3, step 4). The namespace is
 * the tenant's, shared by every app, so the app's host leads it (R1 §11). At most 128 of `[A-Za-z0-9._:-]`.
 */
export function mintRequestId(appHost: string, checkout: string): string {
  const id = `${appHost}:${checkout}`;
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) throw new RangeError(`not a mintRequestId: ${id}`);
  return id;
}

// ---------------------------------------------------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------------------------------------------------

/**
 * `POST /buy/<offer>`'s body (design §3.2). `quote` names an agreed price (§7); `with` holds what the offer asks for.
 * Both are optional, and `{}` is a request.
 */
export const BuyRequest = z.strictObject({
  quote: NegotiationId.optional().meta({ description: "An agreed price's negotiation id, from negotiate." }),
  with: BuyWith.optional().meta({
    description: "What the offer asks for, by name. It is written into the agreement, which is public.",
  }),
});
export type BuyRequest = z.infer<typeof BuyRequest>;

/** The tool `buy`'s arguments, and `test_buy`'s. */
export const BuyToolArgs = z.strictObject({
  offer: OfferId,
  quote: NegotiationId.optional(),
  with: BuyWith.optional(),
});
export type BuyToolArgs = z.infer<typeof BuyToolArgs>;

/**
 * The HTTP request a `buy` or `test_buy` call stands for (design §3.2): `POST` to the offer's path, no query, and as
 * body the RFC 8785 form of `{quote, with}` with the absent members left out, so the same arguments always make the
 * same bytes. The kit writes `body` with lcp's `canonicalJson`, and commits to it with `requestCommitment`.
 */
export function mcpBuyRequest(
  tool: "buy" | "test_buy",
  args: BuyToolArgs,
): { method: "POST"; path: string; query: ""; body: BuyRequest } {
  const body: BuyRequest = {};
  if (args.quote !== undefined) body.quote = args.quote;
  if (args.with !== undefined) body.with = args.with;
  return { method: "POST", path: tool === "buy" ? buyPath(args.offer) : testBuyPath(args.offer), query: "", body };
}

export function buyPath(offer: string): string {
  return `/buy/${offer}`;
}
export function testBuyPath(offer: string): string {
  return `/test/buy/${offer}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// The one payment option (design §3.3, step 3)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * `now`: x402 `exact` on Base Sepolia, paying the treasury. Pay later's anchoring payment is the same option, for
 * `ANCHOR_AMOUNT` (design §3.9).
 */
export const NowOption = z.strictObject({
  scheme: z.literal("exact"),
  network: z.literal(NETWORK),
  amount: Uint256String,
  asset: z.literal(USDC.address),
  payTo: Address,
  maxTimeoutSeconds: z.literal(MAX_TIMEOUT_SECONDS),
  extra: z.strictObject({ name: z.literal(USDC.name), version: z.literal(USDC.version) }),
});
export type NowOption = z.infer<typeof NowOption>;

/**
 * `authorise` (authorise now, collect later, design §3.6): x402 `auth-capture` into the v1.1 escrow, paying the treasury. `extra` holds what lcp requires (R1 §2),
 * with `paymentFlow: "escrow"` (x402 core §6.1) and:
 * - `captureAuthorizer`: the facilitator's wallet, the operator (R5 §3);
 * - `feeRecipient`: the treasury, with both fee rates 0 (design §3.3);
 * - `captureMode: "deferred"`, which the published binding requires where the operator is `"delegated"` with no
 *   `receiverAuthorizer`, as here; and `authCaptureEscrow` written out, as it asks of new servers.
 */
export const AuthoriseOption = z.strictObject({
  scheme: z.literal("auth-capture"),
  network: z.literal(NETWORK),
  amount: Uint256String,
  asset: z.literal(USDC.address),
  payTo: Address,
  maxTimeoutSeconds: z.literal(MAX_TIMEOUT_SECONDS),
  extra: z.strictObject({
    name: z.literal(USDC.name),
    version: z.literal(USDC.version),
    authCaptureEscrow: z.literal(AUTH_CAPTURE_ESCROW.authCaptureEscrow),
    captureAuthorizer: Address,
    captureDeadline: z.int().min(0),
    refundDeadline: z.int().min(0),
    feeRecipient: Address,
    minFeeBps: z.literal(0),
    maxFeeBps: z.literal(0),
    paymentFlow: z.literal("escrow"),
    captureMode: z.literal("deferred"),
  }),
});
export type AuthoriseOption = z.infer<typeof AuthoriseOption>;

/** The option of either kind, as v4 issues it. */
export const V4Option = z.discriminatedUnion("scheme", [NowOption, AuthoriseOption]);
export type V4Option = z.infer<typeof V4Option>;

/** The `now` option for an amount, paying the treasury. */
export function nowOption(p: { amount: string; treasury: string }): NowOption {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: p.amount,
    asset: USDC.address,
    payTo: p.treasury,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { name: USDC.name, version: USDC.version },
  };
}

/**
 * The `authorise` option for an amount, paying the treasury, with the facilitator's wallet as operator. The capture
 * deadline is `CAPTURE_DEADLINE_SECONDS` after `issuedAt`; refunds are allowed until the same time.
 */
export function authoriseOption(p: { amount: string; treasury: string; facilitator: string; issuedAt: number }): AuthoriseOption {
  const deadline = p.issuedAt + CAPTURE_DEADLINE_SECONDS;
  return {
    scheme: "auth-capture",
    network: NETWORK,
    amount: p.amount,
    asset: USDC.address,
    payTo: p.treasury,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: {
      name: USDC.name,
      version: USDC.version,
      authCaptureEscrow: AUTH_CAPTURE_ESCROW.authCaptureEscrow,
      captureAuthorizer: p.facilitator,
      captureDeadline: deadline,
      refundDeadline: deadline,
      feeRecipient: p.treasury,
      minFeeBps: 0,
      maxFeeBps: 0,
      paymentFlow: "escrow",
      captureMode: "deferred",
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The challenge
// ---------------------------------------------------------------------------------------------------------------------

/** The challenge's `error`: what the buyer gives is public (design §5), which the challenge says. */
export const CHALLENGE_ERROR =
  "Payment required. What you give in `with` is written into the agreement, which is public." as const;

/**
 * The test checkout's words, verbatim (design §6): its challenge's `error`, and `test_buy`'s description.
 */
export const TEST_CHECKOUT_SENTENCE =
  "A checkout for testing your agent. The hash it advertises has one character changed. An agent that checks signs nothing. Nothing is sold here." as const;

/**
 * The challenge's `resource`: the checkout's own address (or `mcp://tool/buy` over MCP), with the demonstration
 * sentence as its `description` (design §2.7). For pay later, the description first says what the payment is: the
 * anchor, not the price, and what is owed and when (§3.9).
 */
export function checkoutResource(url: string, before?: string): ResourceInfo {
  return { url, description: before ? `${before} ${DEMONSTRATION_SENTENCE}` : DEMONSTRATION_SENTENCE, mimeType: "application/json" };
}

/** `mcp://tool/buy` and `mcp://tool/test_buy`. */
export const MCP_BUY_RESOURCE_URL = mcpToolResourceUrl("buy");
export const MCP_TEST_BUY_RESOURCE_URL = mcpToolResourceUrl("test_buy");

// ---------------------------------------------------------------------------------------------------------------------
// The checkout's states, and what may be said (design §3.4)
// ---------------------------------------------------------------------------------------------------------------------

/** Each is one row in the app's store. */
export const CheckoutState = z.enum(["open", "claiming", "settling", "paid", "refused", "expired"]);
export type CheckoutState = z.infer<typeof CheckoutState>;

/**
 * What may be said, and when (design §3.4; v3's rule, R4 Q3, with one addition):
 * - "Paid" only after the app's own chain read confirms the transfer;
 * - a promise to pay is "Authorised into escrow", never "Paid";
 * - a payment sent and not yet read is "Sent, not confirmed";
 * - once the capture is read from the chain, the page adds "Collected";
 * - pay later, once the anchoring payment is read from the chain, is "Anchored on chain, the price owed later": its
 *   price is never "Paid" (design §3.9).
 */
export const HEADLINES = {
  paid: "Paid",
  authorised: "Authorised into escrow",
  anchored: "Anchored on chain, the price owed later",
  sent: "Sent, not confirmed",
  collected: "Collected",
  open: "Waiting for payment",
  claiming: "In progress",
  refused: "Refused",
  expired: "Expired",
} as const;
export type Headline = (typeof HEADLINES)[keyof typeof HEADLINES];

// ---------------------------------------------------------------------------------------------------------------------
// The delivery (design §5): what the buyer's agent receives in the answer to the paid request
// ---------------------------------------------------------------------------------------------------------------------

/** How a pass is presented at `/members/<offer>/<file>`: `Authorization: Bearer <pass>`. */
export const ACCESS_PASS_SCHEME = "Bearer" as const;

/** `file`: the file's own bytes, as base64, with its name, type, size and SHA-256 (which the agreement named). */
export const DeliveredFile = z.strictObject({
  kind: z.literal("file"),
  name: z.string().min(1),
  mediaType: z.string().min(1),
  size: z.int().min(0),
  sha256: Sha256Hex,
  base64: z.string(),
});

/** `booking`: a confirmed slot, its reference and time, and an `.ics` file; `url` is `/bookings/<id>`. */
export const DeliveredBooking = z.strictObject({
  kind: z.literal("booking"),
  reference: z.string().min(1),
  start: IsoTime,
  end: IsoTime,
  timezone: z.string().min(1),
  ics: z.string().min(1),
  url: WebUrl,
});

/** `access`: a pass, good until `until`, for each file at its `url` under `/members/<offer>/`. */
export const DeliveredAccess = z.strictObject({
  kind: z.literal("access"),
  pass: z.string().min(16),
  until: IsoTime,
  files: z.array(z.strictObject({ name: z.string().min(1), url: WebUrl })).min(1),
});

/** `answer`: the work itself, done after the payment; `url` is `/orders/<id>`, where it can be read again. */
export const DeliveredAnswer = z.strictObject({
  kind: z.literal("answer"),
  text: z.string(),
  url: WebUrl,
});

/**
 * `order`: an order confirmation, its number, the items and where it would go; `url` is `/orders/<id>`, which answers
 * its state; `note` is `ORDER_DEMONSTRATION_SENTENCE`.
 */
export const DeliveredOrder = z.strictObject({
  kind: z.literal("order"),
  number: z.string().min(1),
  items: z.array(z.strictObject({ offer: OfferId, name: z.string().min(1), quantity: z.int().min(1) })).min(1),
  to: BuyWith,
  url: WebUrl,
  note: z.string().min(1),
});

export const Delivered = z.discriminatedUnion("kind", [
  DeliveredFile,
  DeliveredBooking,
  DeliveredAccess,
  DeliveredAnswer,
  DeliveredOrder,
]);
export type Delivered = z.infer<typeof Delivered>;

// ---------------------------------------------------------------------------------------------------------------------
// The answers
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The answer to a paid request that settled (design §3.4, step 9): the delivery, and the proof's address. `state` is
 * `paid` for Buy now; `authorised` for a promise to pay, which is never "Paid" (§3.4); and `anchored` for pay later,
 * whose anchoring payment settled and whose price is owed (§3.9), with `owed` saying what and by when.
 */
export const BuyPaid = z.strictObject({
  state: z.enum(["paid", "authorised", "anchored"]),
  headline: z.string().min(1),
  checkout: CheckoutId,
  offer: OfferId,
  atrHash: AtrHash,
  transaction: TransactionHash,
  proof: WebUrl.meta({ description: "The purchase's proof page: <app>/proof/<H>." }),
  delivery: Delivered,
  owed: z.strictObject({ price: Dollars, due: IsoTime }).optional().meta({ description: "Pay later: what is owed, and when it is due." }),
  demonstration: z.literal(DEMONSTRATION_SENTENCE),
});
export type BuyPaid = z.infer<typeof BuyPaid>;

/**
 * A purchase as the app keeps it, and as `get_purchase`, a pending answer and `/api/purchases` give it. `advertised`
 * is the hash the challenge carried: H everywhere but at the test checkout (design §6).
 */
export const Purchase = z.strictObject({
  checkout: CheckoutId,
  offer: OfferId,
  offerName: z.string().min(1),
  payment: z.enum(PAYMENTS),
  test: z.boolean(),
  door: z.enum(["http", "mcp"]),
  state: CheckoutState,
  headline: z.string().min(1),
  atrHash: AtrHash,
  advertised: AtrHash,
  link: WebUrl.meta({ description: "The agreement's link, as issue returned it." }),
  price: z.strictObject({ listed: Dollars, agreed: Dollars.optional() }),
  amount: Uint256String,
  negotiation: NegotiationId.optional(),
  deferred: z
    .strictObject({
      owed: Dollars,
      amount: Uint256String.meta({ description: "What is owed, at the demonstration's scale." }),
      due: IsoTime,
      rule: z.enum(["booking", "days"]),
    })
    .optional()
    .meta({ description: "Pay later (design §3.9): what is owed, and when; `amount` above is the anchoring payment." }),
  transaction: TransactionHash.optional(),
  delivery: Delivered.optional(),
  capture: z
    .strictObject({
      state: z.enum(["due", "sent", "collected", "failed"]),
      due: IsoTime,
      transaction: TransactionHash.optional(),
    })
    .optional(),
  refusal: Refusal.optional(),
  proof: WebUrl,
  createdAt: IsoTime,
  updatedAt: IsoTime,
});
export type Purchase = z.infer<typeof Purchase>;

/** `get_purchase`'s arguments: a purchase, by H. */
export const GetPurchaseArgs = z.strictObject({ atrHash: AtrHash });
export type GetPurchaseArgs = z.infer<typeof GetPurchaseArgs>;

/** Every refusal of the checkout and the test checkout, with its HTTP status. */
export const CHECKOUT_REFUSALS = {
  "checkout/method": { status: 405, sentence: "The checkout answers POST, and GET for an offer that asks for nothing." },
  "checkout/offer-unknown": { status: 404, sentence: "No offer has this id." },
  "checkout/malformed": { status: 400, sentence: "The request is not { quote?, with? }." },
  "checkout/asks-missing": { status: 400, sentence: "The request's with lacks something the offer asks for." },
  "checkout/quote-invalid": { status: 409, sentence: "The quote is unknown, for another offer, expired, or already used." },
  "checkout/none-left": { status: 409, sentence: "None is left: the stock is sold, or the slot is taken." },
  "checkout/unavailable": { status: 503, sentence: "The agreement could not be issued, so no challenge was sent." },
  "checkout/payment-malformed": { status: 400, sentence: "The payment is not base64 of an x402 version 2 payment." },
  "checkout/payment-unknown": { status: 400, sentence: "The payment carries the hash of no checkout of this app." },
  "checkout/in-progress": { status: 409, sentence: "This checkout's payment is being taken forward by another request." },
  "checkout/expired": { status: 410, sentence: "This checkout expired unclaimed. Ask again." },
  "checkout/refused": { status: 409, sentence: "This checkout's payment was refused." },
  "test/true-hash": {
    status: 409,
    sentence:
      "The payment carries the agreement's true hash, though the hash advertised was another. Nothing is sold at the test checkout.",
  },
  "test/not-bound": { status: 400, sentence: "The payment carries neither hash. It is not bound to this agreement." },
  "test/appliance-refused": {
    status: 409,
    sentence: "The payment carries the changed hash. The appliance refused it before any money moved.",
  },
} as const satisfies Record<string, { status: number; sentence: string }>;
export type CheckoutRefusalCode = keyof typeof CHECKOUT_REFUSALS;
