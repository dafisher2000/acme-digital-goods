// The checkout (design §3, §6): the unpaid and the paid request, the HTTP door, and the test checkout. Every purchase,
// from either door, is priced, issued, claimed, settled and recorded by `runCheckout`. The MCP door (agent/) makes a
// `CheckoutCall` from a tool call, with `mcpCheckoutCall`, and renders the outcome as a tool result.
//
// Choices where the design is silent (each is in the report):
// - The app keeps its copy of the agreement's bytes right after `issue`, in the background, fetched from the link as a
//   buyer fetches it and kept only when they hash to H.
// - A payment presented at an offer's door is taken only when the checkout it names is that offer's, at that door
//   kind (the test checkout or not); any other is "payment-unknown".
// - `claim` refused with a 5xx (the door or its store unavailable) puts the checkout back to `open`, so the same
//   payment can be sent again; any 4xx ends it as `refused`.
// - A repeat of a paid request that finds the checkout `settling` reads the chain once, and answers `200` if it has
//   settled, so "send the same payment again" finishes the purchase.
// - The test checkout's agreement says, in its demonstration slot, that nothing is sold there.
// - Pay later (design §3.9): the anchoring payment is an ordinary `exact` option for `ANCHOR_AMOUNT`; the agreement's
//   `deferred` slot says what is owed and when. A booking due when it starts names its slot in the agreement: the
//   buyer's `with.slot`, or else the next free slot when the checkout is opened, which the claim then takes.
import {
  ANCHOR_AMOUNT,
  ANCHOR_SENTENCE,
  ANCHOR_USDC,
  BuyRequest,
  CHALLENGE_ERROR,
  CHECKOUT_LIFETIME_SECONDS,
  CHECKOUT_REFUSALS,
  DEFAULT_COLLECT_AFTER_MINUTES,
  DEFERRED_DEMONSTRATION_SENTENCE,
  DEMONSTRATION_SENTENCE,
  MCP_BUY_RESOURCE_URL,
  MCP_TEST_BUY_RESOURCE_URL,
  NETWORK,
  NETWORK_NAME,
  PaymentPayload,
  SETTLEMENT_PENDING,
  TENANT_RESOURCE,
  TEST_CHECKOUT_LIFETIME_SECONDS,
  TEST_CHECKOUT_SENTENCE,
  USDC,
  WALLETS,
  X402_HEADERS,
  X402_VERSION,
  amountToUsdc,
  asksOf,
  authoriseOption,
  check,
  checkoutResource,
  contentSlots,
  decodeX402Header,
  dollarsToAmount,
  encodeX402Header,
  mcpBuyRequest,
  mintRequestId,
  nowOption,
  owedScaleSentence,
  pairingOf,
  priceScaleSentence,
  type AgreementContent,
  type DeferredSlot,
  type AtrHash,
  type BuyToolArgs,
  type CheckoutCall,
  type CheckoutOutcome,
  type Dollars,
  type IsoTime,
  type KitContext,
  type KitHandler,
  type NegotiationSlot,
  type Offer,
  type PaymentRequired,
  type RunCheckout,
  type V4Option,
} from "@demo-factory/interfaces";
import type { IssueRequest } from "@integraledger/agentic-connectors";
import { authCaptureEip3009, exactEip3009, requestCommitment, type RequestCommitment } from "@integraledger/lcp/x402";
import { termsDocument } from "../agent/index.ts";
import { delivery } from "../delivery/index.ts";
import { negotiation } from "../negotiation/index.ts";
import type { StoredRow } from "../store/index.ts";
import { canonicalBytes } from "./canonical.ts";
import * as door from "./door.ts";
import * as facilitator from "./facilitator.ts";
import {
  decline,
  emit,
  finishPaid,
  keysOf,
  move,
  paidAnswer,
  pending,
  readChain,
  refusalOf,
  refused,
  settleStep,
} from "./steps.ts";

export { canonicalBytes, canonicalJson } from "./canonical.ts";
export { resume } from "./steps.ts";


async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return `0x${[...d].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** A checkout's id, which is also its order's: 18 random bytes, base64url (CheckoutId). */
function newCheckoutId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** H′: H with its last character changed (design §6). */
export function changedHash(h: AtrHash): AtrHash {
  const last = h.at(-1)!;
  return `${h.slice(0, -1)}${((parseInt(last, 16) + 1) % 16).toString(16)}` as AtrHash;
}

/** Every whole value equal to `from` becomes `to`; a longer string that holds it is left as it is (design §6, step 2). */
function replaceWhole<T>(value: T, from: string, to: string): T {
  if (value === from) return to as T;
  if (Array.isArray(value)) return value.map((v) => replaceWhole(v, from, to)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceWhole(v, from, to)])) as T;
  }
  return value;
}

/** A slot named by the buyer, as `toISOString` writes it; `null` when it is not a time. */
function normalSlot(v: string): IsoTime | null {
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : (new Date(t).toISOString() as IsoTime);
}

/** The pairing's lcp binding, for an option or a payment's `accepted`, by its scheme. */
function bindingOf(scheme: string) {
  return scheme === "exact" ? exactEip3009 : scheme === "auth-capture" ? authCaptureEip3009 : null;
}

/** The hash a payment carries, read with its pairing's `bound`: the nonce for `exact`, the salt for `auth-capture`. */
async function carriedHash(payment: PaymentPayload): Promise<AtrHash | null> {
  const binding = bindingOf(payment.accepted.scheme);
  if (!binding) return null;
  const h = await binding.bound(payment);
  return typeof h === "string" ? (h as AtrHash) : null;
}

/** The authorization's `validBefore`: `settleBy` on the claim (R1 §4). */
function validBeforeOf(payment: PaymentPayload): number | undefined {
  const v = (payment.payload as { authorization?: { validBefore?: unknown } }).authorization?.validBefore;
  const n = typeof v === "string" ? Number(v) : NaN;
  return Number.isSafeInteger(n) ? n : undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// `/terms.md`, by address and hash, for the agreement's `terms` slot (design §4)
// ---------------------------------------------------------------------------------------------------------------------

/** The agent door's `/terms.md`, as it serves it: its address and the SHA-256 of its bytes. */
async function termsOf(ctx: KitContext): Promise<{ url: string; sha256: string }> {
  const doc = await termsDocument(ctx.business, ctx.origin);
  return { url: doc.url, sha256: doc.sha256 };
}

// ---------------------------------------------------------------------------------------------------------------------
// The unpaid request (design §3.3), and the test checkout's (§6)
// ---------------------------------------------------------------------------------------------------------------------

function collectionSentence(offer: Offer): string {
  const minutes = (offer.payment === "authorise" ? offer.collectAfterMinutes : undefined) ?? DEFAULT_COLLECT_AFTER_MINUTES;
  const what = offer.delivers.kind === "booking" ? "it confirms the booking" : "the purchase";
  return `In this demonstration the seller collects the payment ${minutes} minute${minutes === 1 ? "" : "s"} after ${what}.`;
}

/**
 * Pay later's terms, for the agreement's `deferred` slot (design §3.9): what is owed, when, how it is to be paid, and
 * the anchoring payment, which is not part of the price.
 */
function deferredTerms(owed: Dollars, agreed: boolean, due: DeferredSlot["due"]): DeferredSlot {
  const amount = dollarsToAmount(owed);
  const usdcOwed = amountToUsdc(amount);
  const when =
    due.rule.kind === "booking"
      ? `${due.at}, when the booked slot starts`
      : `${due.at}, ${due.rule.days} day${due.rule.days === 1 ? "" : "s"} after this agreement was issued`;
  return {
    owed: { price: owed, currency: "USD", amount, usdc: usdcOwed, asset: USDC.address, network: NETWORK, to: WALLETS.treasury },
    due,
    anchor: { amount: ANCHOR_AMOUNT, usdc: ANCHOR_USDC, partOfPrice: false },
    words:
      `Pay later. $${owed} is owed for this purchase${agreed ? ", the price agreed in the negotiation" : ""}, due by ${when}. ` +
      `It is to be paid as ${usdcOwed} USDC, test USDC on ${NETWORK_NAME} (${NETWORK}) at this demonstration's scale of one ` +
      `millionth of a USDC for each cent, to the seller's address ${WALLETS.treasury}. ${ANCHOR_SENTENCE} The $${owed} is owed in full.`,
  };
}

/** The challenge's words before the demonstration sentence, for pay later: what this payment is, and what is owed. */
function deferredResourceWords(d: DeferredSlot): string {
  return (
    `Pay later: this payment of ${ANCHOR_USDC} USDC anchors the agreement's hash on chain, and is not part of the price. ` +
    `$${d.owed.price} is owed, due by ${d.due.at}, as the agreement says.`
  );
}

async function unpaid(call: CheckoutCall, offer: Offer, ctx: KitContext): Promise<CheckoutOutcome> {
  const w = call.body.with ?? {};
  const missing = asksOf(offer).filter((ask) => w[ask] === undefined);
  if (missing.length > 0) return refused("checkout/asks-missing", `It lacks: ${missing.join(", ")}.`);

  // 1. Price it: the offer's, or the quote's, for this offer, unexpired and unused.
  let agreed: Dollars | undefined;
  let negotiationSlot: NegotiationSlot | undefined;
  if (call.body.quote !== undefined) {
    const q = await negotiation.quote(offer.id, call.body.quote, ctx);
    if ("refusal" in q) return refused("checkout/quote-invalid");
    agreed = q.agreed;
    negotiationSlot = q.slot;
  }
  const price = agreed ?? offer.price;
  // Pay later pays only the anchor now; the price is owed (design §3.9).
  const amount = offer.payment === "deferred" ? ANCHOR_AMOUNT : dollarsToAmount(price);
  const dueAtBooking = offer.payment === "deferred" && offer.due.kind === "booking";

  // 2. See that there is something to sell. Nothing is held. Nothing is sold at the test checkout. A booking paid later,
  //    due when it starts, names its slot in the agreement, so its slot is chosen here, and taken at the claim.
  let slot: IsoTime | undefined;
  if (!call.test || dueAtBooking) {
    const supply = await ctx.store.supply(offer);
    if (supply.kind === "stock" && supply.left <= 0) return refused("checkout/none-left");
    if (supply.kind === "slots") {
      const wanted = w["slot"] === undefined ? undefined : normalSlot(w["slot"]);
      if (supply.free.length === 0 || (wanted !== undefined && (wanted === null || !supply.free.includes(wanted)))) {
        return refused("checkout/none-left", wanted === undefined ? undefined : `The slot ${w["slot"]} is not free.`);
      }
      if (dueAtBooking) slot = wanted ?? supply.free[0];
    }
  }

  // 3. The one payment option, as the challenge will carry it.
  const id = newCheckoutId();
  const issuedAt = Math.floor(Date.now() / 1000);
  const option: V4Option =
    offer.payment === "authorise"
      ? authoriseOption({ amount, treasury: WALLETS.treasury, facilitator: WALLETS.facilitator, issuedAt })
      : nowOption({ amount, treasury: WALLETS.treasury });
  let deferred: DeferredSlot | undefined;
  if (offer.payment === "deferred") {
    const issued = new Date(issuedAt * 1000).toISOString() as IsoTime;
    const due: DeferredSlot["due"] =
      offer.due.kind === "booking"
        ? { at: slot!, rule: { kind: "booking", slot: slot! } }
        : { at: new Date((issuedAt + offer.due.days * 86_400) * 1000).toISOString() as IsoTime, rule: { kind: "days", days: offer.due.days, from: issued } };
    deferred = deferredTerms(price, agreed !== undefined, due);
  }
  const target = call.request.query ? `${call.request.path}?${call.request.query}` : call.request.path;
  const request = await requestCommitment({ method: call.request.method, target, body: call.request.body });
  if ("code" in request) return refused("checkout/malformed", `The request cannot be committed to: ${request.code}.`);

  await emit(
    ctx,
    "checkout/opened",
    "seller",
    "measured",
    deferred
      ? `Order ${id} was opened for ${offer.name}, paid later: $${price} owed, due by ${deferred.due.at}; the anchoring payment is ${ANCHOR_USDC} USDC.`
      : `Order ${id} was opened for ${offer.name}, at $${price}.`,
    {
      checkout: id,
      offer: offer.id,
      door: call.door,
      price: { listed: offer.price, ...(agreed ? { agreed } : {}) },
      amount,
      ...(deferred ? { owed: { price, amount: deferred.owed.amount, due: deferred.due.at, rule: deferred.due.rule.kind } } : {}),
      ...(negotiationSlot ? { negotiation: negotiationSlot.id } : {}),
      ...(call.test ? { test: true } : {}),
    },
  );

  // The agreement's content (design §4).
  let content: AgreementContent;
  try {
    const described = await delivery.describe(offer, id, ctx);
    content = {
      seller: { name: ctx.business.name, web: ctx.origin, contact: ctx.business.contact },
      offer: { id: offer.id, name: offer.name, about: offer.about, price: offer.price, currency: "USD" },
      terms: { offer: offer.terms, document: await termsOf(ctx) },
      order: {
        id,
        price: { listed: offer.price, ...(agreed ? { agreed } : {}) },
        paid: { amount, usdc: amountToUsdc(amount), asset: USDC.address, network: NETWORK },
        with: w,
      },
      ...(deferred ? { deferred } : {}),
      ...(negotiationSlot ? { negotiation: negotiationSlot } : {}),
      delivers: described.delivers,
      demonstration: {
        network: NETWORK,
        sentence: DEMONSTRATION_SENTENCE,
        prices: deferred ? owedScaleSentence(price) : priceScaleSentence(price),
        delivery: call.test ? TEST_CHECKOUT_SENTENCE : deferred ? described.words.replace(/^After the payment settles/, "After the anchoring payment settles") : described.words,
        ...(offer.payment === "authorise" ? { collection: collectionSentence(offer) } : {}),
        ...(deferred ? { deferred: DEFERRED_DEMONSTRATION_SENTENCE } : {}),
      },
    };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    await emit(ctx, "refusal", "seller", "measured", "The agreement's content could not be written, so no challenge was sent.", {
      checkout: id,
      code: "checkout/unavailable",
      sentence: why,
    });
    return refused("checkout/unavailable", `The agreement's content could not be written: ${why}`);
  }

  // 4. `issue`, with a new id for this unpaid request. A retry inside the request uses the same id (R1 §1).
  const mint = mintRequestId(ctx.host, id);
  const issueRequest: IssueRequest = {
    mintRequestId: mint,
    resource: TENANT_RESOURCE,
    lifetimeSeconds: call.test ? TEST_CHECKOUT_LIFETIME_SECONDS : CHECKOUT_LIFETIME_SECONDS,
    offers: [{ pairing: pairingOf(offer.payment), option: option as unknown as IssueRequest["offers"][number]["option"] }],
    content: contentSlots(content),
    request,
  };
  let issued = await door.issue(ctx.sellerCredential, issueRequest);
  if (!issued.ok && (issued.refusal.code === "issue/deadline" || issued.status === 503)) issued = await door.issue(ctx.sellerCredential, issueRequest);
  if (!issued.ok) {
    await emit(ctx, "issue", "appliance", "reported", `The appliance refused to issue, with ${issued.status}, ${issued.refusal.code}.`, {
      checkout: id,
      mintRequestId: mint,
      status: issued.status,
      refusal: issued.refusal,
      ms: issued.ms,
    });
    // It fails closed: no challenge goes out without H.
    return refused("checkout/unavailable", `The appliance said: ${issued.refusal.code}, ${issued.refusal.sentence}`);
  }
  const h = issued.body.atrHash as AtrHash;
  const link = issued.body.link;
  const advertised = call.test ? changedHash(h) : h;
  await emit(ctx, "issue", "appliance", "reported", `The appliance issued the agreement in ${issued.ms} ms.`, {
    checkout: id,
    atrHash: h,
    advertised,
    link,
    expiresAt: issued.body.expiresAt,
    mintRequestId: mint,
    ms: issued.ms,
    ...(negotiationSlot ? { negotiation: negotiationSlot.id } : {}),
    ...(call.test ? { test: true } : {}),
  });

  // 6. Place H and the link with lcp's `advertise`. At the test checkout, every whole value equal to H becomes H′.
  const required: PaymentRequired = {
    x402Version: X402_VERSION,
    error: call.test ? TEST_CHECKOUT_SENTENCE : CHALLENGE_ERROR,
    resource: checkoutResource(call.resourceUrl, deferred ? deferredResourceWords(deferred) : undefined),
    accepts: [option],
  };
  const binding = bindingOf(option.scheme)!;
  const placed = binding.advertise(required as never, h as never, link, option as never);
  if ("code" in placed) return refused("checkout/unavailable", `lcp's advertise refused: ${String(placed.code)}.`);
  const challenge = (call.test ? replaceWhole(placed, h, advertised) : placed) as unknown as PaymentRequired;

  // 5. Keep the checkout, `open`, under the hash it advertises.
  const now = new Date().toISOString() as IsoTime;
  const row: StoredRow = {
    id,
    offer: offer.id,
    kind: offer.delivers.kind,
    payment: offer.payment,
    test: call.test,
    door: call.door,
    state: "open",
    atrHash: h,
    advertised,
    link,
    mintRequestId: mint,
    expiresAt: Math.floor(Date.parse(issued.body.expiresAt) / 1000),
    option,
    request: request as RequestCommitment as StoredRow["request"],
    challenge,
    with: w,
    price: { listed: offer.price, ...(agreed ? { agreed } : {}) },
    amount,
    ...(negotiationSlot ? { negotiation: negotiationSlot.id } : {}),
    ...(deferred
      ? { deferred: { owed: price, amount: deferred.owed.amount, due: deferred.due.at, rule: deferred.due.rule.kind, ...(slot ? { slot } : {}) } }
      : {}),
    createdAt: now,
    updatedAt: now,
    origin: ctx.origin,
  };
  await ctx.store.putCheckout(row);
  await emit(
    ctx,
    "challenge",
    "seller",
    "measured",
    call.test
      ? "The test checkout sent its challenge, advertising a hash with one character changed."
      : `The checkout sent its challenge, advertising the agreement's hash.`,
    { ...keysOf(row), door: call.door, required: challenge as never },
  );
  ctx.waitUntil(keepAgreementCopy(row, ctx));
  return { kind: "challenge", required: challenge };
}

/** The app's copy of the agreement's bytes (design §8), fetched as a buyer fetches the link, kept when they hash to H. */
async function keepAgreementCopy(row: StoredRow, ctx: KitContext): Promise<void> {
  if (await ctx.store.agreement(row.atrHash)) return;
  try {
    const res = await fetch(row.link, {
      method: "GET",
      redirect: "manual",
      headers: { "accept-encoding": "identity" },
      signal: AbortSignal.timeout(10_000),
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const sha256 = await sha256Hex(bytes);
    if (res.status === 200 && sha256 === row.atrHash) {
      await ctx.store.keepAgreement(row.atrHash, bytes);
      return;
    }
    await emit(ctx, "x/agreement-unkept", "seller", "measured", `The agreement's link answered ${res.status} with bytes that do not hash to H.`, {
      ...keysOf(row),
      status: res.status,
      size: bytes.length,
      sha256,
    });
  } catch (e) {
    await emit(ctx, "x/agreement-unkept", "seller", "measured", "The agreement's link could not be read for the app's copy.", {
      ...keysOf(row),
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** The kept copy, or the link's bytes when there is none yet. */
async function agreementBytes(row: StoredRow, ctx: KitContext): Promise<Uint8Array | null> {
  const kept = await ctx.store.agreement(row.atrHash);
  if (kept) return kept;
  await keepAgreementCopy(row, ctx);
  return ctx.store.agreement(row.atrHash);
}

// ---------------------------------------------------------------------------------------------------------------------
// The paid request (design §3.4)
// ---------------------------------------------------------------------------------------------------------------------

/** A paid request that finds its checkout taken forward already: what the kept state says (the table of §3.4). */
async function already(row: StoredRow, ctx: KitContext): Promise<CheckoutOutcome> {
  switch (row.state) {
    case "claiming":
      return refused("checkout/in-progress");
    case "settling": {
      const next = await settleStep(row, ctx);
      return next.state === "paid" ? paidAnswer(next, ctx) : next.state === "refused" ? { kind: "refused", status: 409, refusal: next.refusal ?? refusalOf("checkout/refused") } : pending(next);
    }
    case "paid":
      return paidAnswer(row.delivery ? row : await finishPaid(row, ctx), ctx);
    case "refused":
      return { kind: "refused", status: CHECKOUT_REFUSALS["checkout/refused"].status, refusal: row.refusal ?? refusalOf("checkout/refused") };
    case "expired":
      return refused("checkout/expired");
    case "open":
      return refused("checkout/in-progress");
  }
}

async function paid(call: CheckoutCall, offer: Offer, ctx: KitContext): Promise<CheckoutOutcome> {
  const payment = call.payment!;
  // 1. Read the payment, and the hash it carries, with the pairing's `bound`.
  const carried = await carriedHash(payment);
  // 2. The checkout under that hash, in the app's own store: this offer's, at this door.
  const found = carried ? await ctx.store.checkout({ hash: carried }) : null;
  const row0 = found && !found.test && found.offer === offer.id && found.advertised === carried ? (found as StoredRow) : null;
  await emit(
    ctx,
    "payment/arrived",
    "seller",
    "measured",
    row0 ? "A payment arrived that carries this checkout's hash." : carried ? "A payment arrived that carries the hash of no checkout of this offer." : "A payment arrived that carries no hash the pairing can read.",
    { ...(row0 ? keysOf(row0) : {}), carried, door: call.door, offer: offer.id },
  );
  if (!row0) return refused("checkout/payment-unknown");

  const target = call.request.query ? `${call.request.path}?${call.request.query}` : call.request.path;
  const commitment = await requestCommitment({ method: call.request.method, target, body: call.request.body });
  if ("code" in commitment) return refused("checkout/malformed", `The request cannot be committed to: ${commitment.code}.`);

  // 3. `claiming`, and what is sold taken, as one write.
  // A booking paid later takes the slot its agreement names (design §3.9).
  const take = await ctx.store.claimAndTake(carried!, row0.deferred?.slot);
  if (!take.ok) {
    if (take.why === "unknown") return refused("checkout/payment-unknown");
    if (take.why === "expired") return refused("checkout/expired");
    if (take.why === "none-left") return refused("checkout/none-left");
    if (take.why === "quote-used") return refused("checkout/quote-invalid");
    return already(take.row as StoredRow, ctx);
  }
  let row = take.row as StoredRow;
  await emit(ctx, "checkout/state", "seller", "measured", `Order ${row.id} went from open to claiming${row.slot ? `, taking the slot at ${row.slot}` : ""}.`, {
    ...keysOf(row),
    state: "claiming",
    was: "open",
    ...(row.slot ? { slot: row.slot } : {}),
  });

  // 4. The facilitator's `/verify`, read-only. A refusal puts back what was taken.
  const v = await facilitator.verify(payment, row.option);
  await emit(
    ctx,
    "verify",
    "chain",
    "reported",
    v.ok ? (v.body.isValid ? "The facilitator verified the payment." : `The facilitator refused the payment: ${v.body.invalidReason ?? "invalid"}.`) : `The facilitator did not answer verify: ${v.why}.`,
    { ...keysOf(row), ...(v.ok ? { response: v.body as never } : { why: v.why }), ms: v.ms },
  );
  if (!v.ok) {
    await move(ctx, row, ["claiming"], "open");
    return refused("checkout/unavailable", "The facilitator did not answer: send the same payment again.");
  }
  if (!v.body.isValid) {
    await move(ctx, row, ["claiming"], "open");
    return { kind: "payment-refused", required: { ...row.challenge, error: `The payment was refused: ${v.body.invalidReason ?? "invalid"}.` } };
  }

  // 5. `claim`, with this request's commitment, and `settleBy` the authorization's `validBefore`.
  const settleBy = validBeforeOf(payment);
  const c = await door.claim(ctx.sellerCredential, {
    resource: TENANT_RESOURCE,
    pairing: pairingOf(row.payment),
    payment: payment as never,
    chosen: payment.accepted as never,
    network: payment.accepted.network,
    request: commitment,
    ...(settleBy !== undefined ? { settleBy } : {}),
  });
  await emit(
    ctx,
    "claim",
    "appliance",
    "reported",
    c.ok ? `The appliance claimed the payment for this agreement: ${c.body.state}.` : `The appliance refused the claim with ${c.status}, ${c.refusal.code}.`,
    { ...keysOf(row), status: c.status, ms: c.ms, ...(c.ok ? { state: c.body.state, proves: c.body.proves as never } : { refusal: c.refusal }) },
  );
  if (!c.ok) {
    if (c.status >= 500) {
      await move(ctx, row, ["claiming"], "open");
      return refused("checkout/unavailable", `The appliance said: ${c.refusal.code}. Send the same payment again.`);
    }
    await move(ctx, row, ["claiming"], "refused", { refusal: c.refusal });
    return { kind: "refused", status: c.status, refusal: c.refusal };
  }
  row = ((await ctx.store.transition(row.id, ["claiming"], "claiming", { paymentPayload: payment, ...(settleBy !== undefined ? { settleBy } : {}) })) as StoredRow | null) ?? row;

  // 6. The facilitator's `/settle`.
  const s = await facilitator.settle(payment, row.option);
  await emit(
    ctx,
    "settle",
    "chain",
    "reported",
    s.ok
      ? s.body.success
        ? `The facilitator settled the payment in ${s.body.transaction}.`
        : `The facilitator answered settle with ${s.body.errorReason ?? "a failure"}.`
      : `The facilitator did not answer settle: ${s.why}.`,
    { ...keysOf(row), ...(s.ok ? { response: s.body as never } : { why: s.why }), ms: s.ms },
  );
  if (!s.ok) {
    // Whether anything was broadcast is not known here. Nothing is reported: the appliance's own reader finds a
    // settlement by its keys (R1 §5).
    await move(ctx, row, ["claiming"], "refused", { refusal: refusalOf("checkout/refused", `The facilitator did not answer: ${s.why}.`) });
    return refused("checkout/unavailable", `The facilitator did not answer settle: ${s.why}.`);
  }
  if (!s.body.success) {
    if (s.body.errorReason === SETTLEMENT_PENDING && s.body.transaction) {
      const next = (await move(ctx, row, ["claiming"], "settling", { transaction: s.body.transaction })) ?? row;
      await ctx.store.wake(row.id, Date.now() + 10_000, "settle");
      return pending(next, s.body);
    }
    await decline(row, `the facilitator answered ${s.body.errorReason ?? "a failure"}`, ctx);
    return {
      kind: "refused",
      status: 402,
      refusal: refusalOf("checkout/refused", `The facilitator could not settle it: ${s.body.errorReason ?? "a failure"}.`),
    };
  }
  const transaction = s.body.transaction;

  // 7. The app reads the chain itself.
  const read = await readChain(row, transaction, ctx);
  if (read.state === "pending") {
    const next = (await move(ctx, row, ["claiming"], "settling", { transaction })) ?? row;
    await ctx.store.wake(row.id, Date.now() + 10_000, "settle");
    return pending(next, { success: false, errorReason: SETTLEMENT_PENDING, transaction, network: NETWORK });
  }
  if (read.state === "failed") {
    await ctx.store.transition(row.id, ["claiming"], "claiming", { transaction });
    await decline({ ...row, transaction }, read.why, ctx);
    return { kind: "refused", status: 402, refusal: refusalOf("checkout/refused", `The app's own read of the chain did not confirm it: ${read.why}.`) };
  }
  row = (await move(ctx, row, ["claiming"], "paid", { transaction })) ?? row;

  // 8 and 9. `report`, deliver, and answer.
  row = await finishPaid(row, ctx);
  return paidAnswer(row, ctx, s.body);
}

// ---------------------------------------------------------------------------------------------------------------------
// The test checkout's paid request (design §6): four things can happen, and each is recorded
// ---------------------------------------------------------------------------------------------------------------------

async function paidTest(call: CheckoutCall, offer: Offer, ctx: KitContext): Promise<CheckoutOutcome> {
  const payment = call.payment!;
  const carried = await carriedHash(payment);
  const found = carried ? await ctx.store.checkout({ hash: carried }) : null;
  const row = found && found.test && found.offer === offer.id ? (found as StoredRow) : null;
  await emit(ctx, "payment/arrived", "seller", "measured", "A payment arrived at the test checkout.", {
    ...(row ? keysOf(row) : { test: true }),
    carried,
    door: call.door,
    offer: offer.id,
  });

  if (!row) {
    // It carries neither hash: it belongs to no checkout, and is recorded against the offer's test checkout and the time.
    await emit(ctx, "test/outcome", "seller", "measured", "A payment arrived that carries neither hash. It is not bound to this agreement.", {
      offer: offer.id,
      outcome: "neither",
      carried,
      at: new Date().toISOString(),
      test: true,
    });
    return refused("test/not-bound");
  }

  if (carried === row.atrHash) {
    await move(ctx, row, ["open"], "refused", { refusal: refusalOf("test/true-hash"), paymentPayload: payment });
    await emit(
      ctx,
      "test/outcome",
      "seller",
      "measured",
      "A payment arrived that carries the agreement's true hash, though the hash advertised was another. Nothing is sold at the test checkout.",
      { ...keysOf(row), outcome: "true-hash", carried },
    );
    return refused("test/true-hash");
  }

  // It carries H′: the payment checked against the agreement's bytes, then `claim`, which the appliance refuses.
  const bytes = await agreementBytes(row, ctx);
  const computed = bytes ? await sha256Hex(bytes) : null;
  const target = call.request.query ? `${call.request.path}?${call.request.query}` : call.request.path;
  const commitment = await requestCommitment({ method: call.request.method, target, body: call.request.body });
  if ("code" in commitment) return refused("checkout/malformed", `The request cannot be committed to: ${commitment.code}.`);
  const settleBy = validBeforeOf(payment);
  const c = await door.claim(ctx.sellerCredential, {
    resource: TENANT_RESOURCE,
    pairing: pairingOf(row.payment),
    payment: payment as never,
    chosen: payment.accepted as never,
    network: payment.accepted.network,
    request: commitment,
    ...(settleBy !== undefined ? { settleBy } : {}),
  });
  await emit(
    ctx,
    "claim",
    "appliance",
    "reported",
    c.ok ? `The appliance claimed the payment: ${c.body.state}.` : `The appliance refused the claim with ${c.status}, ${c.refusal.code}.`,
    { ...keysOf(row), status: c.status, ms: c.ms, ...(c.ok ? { state: c.body.state } : { refusal: c.refusal }) },
  );
  await move(ctx, row, ["open"], "refused", { refusal: refusalOf("test/appliance-refused"), paymentPayload: payment });
  await emit(
    ctx,
    "test/outcome",
    "seller",
    "measured",
    c.ok
      ? "A payment arrived that carries the changed hash, and the appliance did not refuse its claim."
      : "A payment arrived that carries the changed hash. The appliance refused it before any money moved.",
    {
      ...keysOf(row),
      outcome: "changed-hash",
      carried,
      agreementSha256: computed,
      carriedIsAgreement: computed === carried,
      claim: c.ok ? { status: c.status, state: c.body.state } : { status: c.status, code: c.refusal.code },
    },
  );
  return refused("test/appliance-refused");
}

// ---------------------------------------------------------------------------------------------------------------------
// The one checkout, and its HTTP door
// ---------------------------------------------------------------------------------------------------------------------

/** The one checkout. The HTTP door calls it, and the agent door calls it for `buy` and `test_buy`. */
export const runCheckout: RunCheckout = async (call, ctx) => {
  const offer = ctx.business.offers.find((o) => o.id === call.offer);
  if (!offer) return refused("checkout/offer-unknown");
  const body = check(BuyRequest, call.body);
  if (!body.ok) return refused("checkout/malformed");
  const c = { ...call, body: body.value };
  if (c.payment === null) return unpaid(c, offer, ctx);
  return c.test ? paidTest(c, offer, ctx) : paid(c, offer, ctx);
};

/**
 * The `CheckoutCall` a `buy` or `test_buy` tool call stands for (design §3.2): `POST` to the offer's path, whose body
 * is the RFC 8785 form of `{quote, with}`, with the payment from `params._meta["x402/payment"]`.
 */
export function mcpCheckoutCall(tool: "buy" | "test_buy", args: BuyToolArgs, payment: PaymentPayload | null): CheckoutCall {
  const r = mcpBuyRequest(tool, args);
  return {
    door: "mcp",
    test: tool === "test_buy",
    offer: args.offer,
    body: r.body,
    request: { method: r.method, path: r.path, query: r.query, body: canonicalBytes(r.body) },
    resourceUrl: tool === "buy" ? MCP_BUY_RESOURCE_URL : MCP_TEST_BUY_RESOURCE_URL,
    payment,
  };
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": `${X402_HEADERS.paymentRequired}, ${X402_HEADERS.paymentResponse}`,
};

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS, ...extra },
  });
}

/** The outcome as x402 over HTTP (`checkout.ts`'s module comment). */
export function renderHttp(outcome: CheckoutOutcome): Response {
  switch (outcome.kind) {
    case "challenge":
    case "payment-refused":
      return json(402, outcome.required, { [X402_HEADERS.paymentRequired]: encodeX402Header(outcome.required) });
    case "paid":
      return json(200, outcome.answer, { [X402_HEADERS.paymentResponse]: encodeX402Header(outcome.receipt) });
    case "pending":
      return json(202, outcome.purchase, { [X402_HEADERS.paymentResponse]: encodeX402Header(outcome.receipt) });
    case "refused":
      return json(outcome.status, outcome.refusal);
  }
}

async function httpDoor(request: Request, offer: string, test: boolean, ctx: KitContext): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...CORS,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": `content-type, ${X402_HEADERS.paymentSignature}`,
        "access-control-max-age": "86400",
      },
    });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return renderHttp(refused("checkout/method"));
  }
  const url = new URL(request.url);
  const bytes = new Uint8Array(await request.arrayBuffer());
  let body: unknown = {};
  if (request.method === "POST" && bytes.length > 0) {
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    } catch {
      return renderHttp(refused("checkout/malformed"));
    }
  }
  const parsed = check(BuyRequest, body);
  if (!parsed.ok) return renderHttp(refused("checkout/malformed"));

  let payment: PaymentPayload | null = null;
  const header = request.headers.get(X402_HEADERS.paymentSignature);
  if (header) {
    let decoded: unknown;
    try {
      decoded = decodeX402Header(header);
    } catch {
      return renderHttp(refused("checkout/payment-malformed"));
    }
    const p = check(PaymentPayload, decoded);
    if (!p.ok) return renderHttp(refused("checkout/payment-malformed"));
    payment = p.value;
  }

  const outcome = await runCheckout(
    {
      door: "http",
      test,
      offer,
      body: parsed.value,
      request: { method: request.method, path: url.pathname, query: url.search.slice(1), body: bytes },
      resourceUrl: ctx.origin + url.pathname,
      payment,
    },
    ctx,
  );
  return renderHttp(outcome);
}

/** `POST` and `GET /buy/<offer>`: the HTTP door. It renders `runCheckout`'s outcome as x402 over HTTP. */
export const buy: KitHandler = (request, params, ctx) => httpDoor(request, params["offer"] ?? "", false, ctx);

/** `POST` and `GET /test/buy/<offer>`: the test checkout (design §6). */
export const testBuy: KitHandler = (request, params, ctx) => httpDoor(request, params["offer"] ?? "", true, ctx);

