// The checkout's steps after the claim (design §3.4 steps 7 to 9, and §3.6), shared by the paid request and by the
// store's alarm, which finishes what a request left: a `settling` checkout, the record's `status`, and a promise to
// pay's capture. Each change of state is one write through the store's `transition`.
import {
  CHECKOUT_REFUSALS,
  DEFAULT_COLLECT_AFTER_MINUTES,
  DEMONSTRATION_SENTENCE,
  NETWORK,
  SETTLEMENT_PENDING,
  pairingOf,
  proofPath,
  type BuyPaid,
  type CheckoutOutcome,
  type CheckoutRefusalCode,
  type CheckoutRow,
  type CheckoutState,
  type Json,
  type JsonObject,
  type AuthoriseOption,
  type KitContext,
  type NewEvent,
  type Offer,
  type PaymentPayload,
  type RecordView,
  type Refusal,
  type SettleResponse,
} from "@demo-factory/interfaces";
import { delivery } from "../delivery/index.ts";
import { purchaseOf, type StoredRow } from "../store/index.ts";
import { evmReader, paymentIdOf, readCapture, readPayment, type PaymentRead } from "./chain.ts";
import * as door from "./door.ts";
import * as facilitator from "./facilitator.ts";

// ---------------------------------------------------------------------------------------------------------------------
// Events (design §8.2): every event about a purchase carries its join keys
// ---------------------------------------------------------------------------------------------------------------------

/** The join keys of a checkout's events (design §10.2): the checkout, H, the advertised hash, the negotiation. */
export function keysOf(row: Pick<CheckoutRow, "id" | "atrHash" | "advertised" | "negotiation" | "test">): JsonObject {
  return {
    checkout: row.id,
    atrHash: row.atrHash,
    advertised: row.advertised,
    ...(row.negotiation ? { negotiation: row.negotiation } : {}),
    ...(row.test ? { test: true } : {}),
  };
}

/** Appends one event; `data` is written as JSON, so a member left undefined is left out. */
export async function emit(
  ctx: KitContext,
  step: NewEvent["step"],
  side: NewEvent["side"],
  source: NewEvent["source"],
  text: string,
  data: Record<string, unknown>,
): Promise<void> {
  await ctx.store.append({ side, source, step, text, data: JSON.parse(JSON.stringify(data)) as JsonObject });
}

/** Moves a checkout, as one write, and says so in the stream. Null when its state was not one of `from`. */
export async function move(
  ctx: KitContext,
  row: CheckoutRow,
  from: CheckoutState[],
  to: CheckoutState,
  patch: Partial<CheckoutRow> = {},
): Promise<StoredRow | null> {
  const next = (await ctx.store.transition(row.id, from, to, patch)) as StoredRow | null;
  if (next && next.state !== row.state) {
    await emit(ctx, "checkout/state", "seller", "measured", `Order ${row.id} went from ${row.state} to ${to}.`, {
      ...keysOf(row),
      state: to,
      was: row.state,
    });
  }
  return next;
}

// ---------------------------------------------------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------------------------------------------------

export function refusalOf(code: CheckoutRefusalCode, more?: string): Refusal {
  const sentence = CHECKOUT_REFUSALS[code].sentence;
  return { code, sentence: more ? `${sentence} ${more}` : sentence };
}

export function refused(code: CheckoutRefusalCode, more?: string): CheckoutOutcome {
  return { kind: "refused", status: CHECKOUT_REFUSALS[code].status, refusal: refusalOf(code, more) };
}

const payerOf = (p: PaymentPayload | undefined): string | undefined => {
  const a = (p?.payload as { authorization?: { from?: unknown } } | undefined)?.authorization;
  return typeof a?.from === "string" ? a.from : undefined;
};

/** The receipt of a settled payment, as the facilitator gave it, or rebuilt for a repeat of the paid request. */
function receiptOf(row: CheckoutRow, given?: SettleResponse): SettleResponse {
  if (given?.success) return given;
  const payer = payerOf(row.paymentPayload);
  return { success: true, transaction: row.transaction ?? "", network: NETWORK, ...(payer ? { payer } : {}) };
}

/** Sent, not yet confirmed: `202` / a result that is not an error, with the purchase and `settlement_pending`. */
export function pending(row: StoredRow, given?: SettleResponse): CheckoutOutcome {
  const payer = payerOf(row.paymentPayload);
  const receipt: SettleResponse =
    given && given.errorReason === SETTLEMENT_PENDING
      ? given
      : { success: false, errorReason: SETTLEMENT_PENDING, transaction: row.transaction ?? "", network: NETWORK, ...(payer ? { payer } : {}) };
  return { kind: "pending", purchase: purchaseOf(row), receipt };
}

/**
 * Settled and delivered: `200` / a result with `BuyPaid`. A promise to pay is "authorised", never "paid"; pay later is
 * "anchored", with what is owed and when (design §3.9).
 */
export function paidAnswer(row: StoredRow, ctx: KitContext, given?: SettleResponse): CheckoutOutcome {
  if (!row.delivery || !row.transaction) {
    return refused("checkout/unavailable", "The payment settled and the delivery has not been made yet: send the same payment again.");
  }
  const purchase = purchaseOf(row);
  const answer: BuyPaid = {
    state: row.payment === "now" ? "paid" : row.payment === "authorise" ? "authorised" : "anchored",
    headline: purchase.headline,
    checkout: row.id,
    offer: row.offer,
    atrHash: row.atrHash,
    transaction: row.transaction,
    proof: (row.origin ?? ctx.origin) + proofPath(row.advertised),
    delivery: row.delivery,
    ...(row.deferred ? { owed: { price: row.deferred.owed, due: row.deferred.due } } : {}),
    demonstration: DEMONSTRATION_SENTENCE,
  };
  return { kind: "paid", answer, receipt: receiptOf(row, given) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Step 7: the app reads the chain itself
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The app's own read of the payment, tried for a few seconds while the node has not yet seen the receipt the
 * facilitator waited for.
 */
export async function readChain(row: CheckoutRow, transaction: string, ctx: KitContext, tries = 4): Promise<PaymentRead> {
  const reader = evmReader(ctx.settings.rpcUrl);
  let read: PaymentRead = { state: "pending", why: "not-read" };
  for (let i = 0; i < tries; i++) {
    try {
      read = await readPayment(row.paymentPayload!, row.atrHash, transaction, reader);
    } catch (e) {
      read = { state: "pending", why: e instanceof Error ? e.message : String(e) };
    }
    if (read.state !== "pending") break;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 1500));
  }
  const what = row.payment === "now" ? "the transfer" : row.payment === "authorise" ? "the authorisation into escrow" : "the anchoring payment";
  const text =
    read.state === "settled"
      ? `The app read ${what} on chain, in block ${read.block}${row.payment === "authorise" ? ", with the escrow's salt equal to H" : ", and recovered H from it"}.`
      : read.state === "pending"
        ? `The app did not yet find ${what} on chain.`
        : `The app's read of ${what} failed: ${read.why}.`;
  await emit(ctx, "chain/read", "chain", "measured", text, {
    ...keysOf(row),
    what: "payment",
    transaction,
    ...read,
  });
  return read;
}

// ---------------------------------------------------------------------------------------------------------------------
// Steps 8 and 9: report, deliver; and a promise to pay's collection
// ---------------------------------------------------------------------------------------------------------------------

function offerOf(row: CheckoutRow, ctx: KitContext): Offer {
  const offer = ctx.business.offers.find((o) => o.id === row.offer);
  if (!offer) throw new Error(`no offer ${row.offer} in business.json`);
  return offer;
}

/** `report` with the outcome, and the answer kept as the app's copy of the record. */
export async function reportOutcome(row: CheckoutRow, outcome: "paid" | "declined", ctx: KitContext): Promise<void> {
  const r = await door.report(ctx.sellerCredential, {
    atrHash: row.atrHash as `0x${string}`,
    pairing: pairingOf(row.payment),
    outcome,
    network: NETWORK,
    ...(outcome === "paid" && row.transaction ? { reference: row.transaction } : {}),
  });
  if (r.ok) await ctx.store.keepRecord(row.atrHash, r.body as unknown as RecordView);
  await emit(
    ctx,
    "report",
    "appliance",
    "reported",
    r.ok
      ? `The appliance answered the ${outcome} report with ${r.status}: its record is ${r.body.state}.`
      : `The appliance refused the ${outcome} report with ${r.status}, ${r.refusal.code}.`,
    { ...keysOf(row), outcome, status: r.status, ms: r.ms, ...(r.ok ? { record: r.body } : { refusal: r.refusal }) },
  );
}

/**
 * Steps 8 and 9 of the paid request, for a checkout `paid` by the app's own read: `report`, then deliver once, and
 * for a promise to pay, the collection set for the time the offer names (design §3.6). Each is skipped when done.
 */
export async function finishPaid(row: StoredRow, ctx: KitContext): Promise<StoredRow> {
  if (row.state !== "paid") return row;
  const offer = offerOf(row, ctx);
  const kept = await ctx.store.record(row.atrHash);
  if (kept?.view.state !== "paid") {
    await reportOutcome(row, "paid", ctx);
    // The copy of the record the app keeps, read with `status` until it is paid (design §3.4, "After the answer").
    await ctx.store.wake(row.id, Date.now() + 2_000, "status");
  }
  if (!row.delivery) {
    try {
      const delivered = await delivery.deliver(offer, row, ctx);
      row = ((await ctx.store.transition(row.id, ["paid"], "paid", { delivery: delivered })) as StoredRow | null) ?? row;
    } catch (e) {
      await emit(ctx, "x/delivery-failed", "seller", "measured", `The delivery of order ${row.id} failed; a repeat of the paid request tries again.`, {
        ...keysOf(row),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  if (row.payment === "authorise" && !row.capture) {
    const minutes = (offer.payment === "authorise" ? offer.collectAfterMinutes : undefined) ?? DEFAULT_COLLECT_AFTER_MINUTES;
    const at = Date.now() + minutes * 60_000;
    const due = new Date(at).toISOString();
    row = ((await ctx.store.transition(row.id, ["paid"], "paid", { capture: { state: "due", due } })) as StoredRow | null) ?? row;
    await ctx.store.wake(row.id, at, "capture");
    await emit(ctx, "x/capture-due", "seller", "measured", `The seller will collect order ${row.id} from escrow at ${due}.`, {
      ...keysOf(row),
      due,
    });
  }
  return row;
}

/** A payment that did not settle: `report` declined; the checkout is refused, and what it took is put back. */
export async function decline(row: CheckoutRow, why: string, ctx: KitContext): Promise<StoredRow | null> {
  await reportOutcome(row, "declined", ctx);
  return move(ctx, row, ["claiming", "settling"], "refused", {
    refusal: refusalOf("checkout/refused", `It did not settle: ${why}.`),
  });
}

/**
 * A `settling` checkout: read the chain for its transaction. Settled: steps 8 and 9. Failed, or unsettled once the
 * authorization's `validBefore` has passed: declined (design §3.4, "A pending settlement").
 */
export async function settleStep(row: StoredRow, ctx: KitContext): Promise<StoredRow> {
  if (row.state !== "settling" || !row.transaction) return row;
  const read = await readChain(row, row.transaction, ctx, 1);
  if (read.state === "settled") {
    const paid = await move(ctx, row, ["settling"], "paid");
    return paid ? finishPaid(paid, ctx) : row;
  }
  // Unsettled once `validBefore` has passed: the authorization can no longer execute. A node that answered nothing
  // disproves nothing, so an unreadable chain is read again for an hour past that before it is declined.
  const past = Date.now() / 1000 - (row.settleBy ?? 0);
  const late = read.state === "pending" && (read.why === "not-found" ? past > 30 : past > 3_600);
  if (read.state === "failed" || late) {
    return (await decline(row, read.state === "failed" ? read.why : "the authorization's validBefore passed with no settlement on chain", ctx)) ?? row;
  }
  await ctx.store.wake(row.id, Date.now() + 10_000, "settle");
  return row;
}

/** The appliance's record, read with `status` and kept, until it is paid; two hours at most (design §3.4). */
async function statusStep(row: StoredRow, ctx: KitContext): Promise<void> {
  const s = await door.status(ctx.sellerCredential, row.atrHash);
  const takenAt = new Date().toISOString();
  if (s.ok) {
    await ctx.store.keepRecord(row.atrHash, s.body as unknown as RecordView);
    await emit(ctx, "status", "appliance", "reported", `The appliance's record of this agreement is ${s.body.state}, read at ${takenAt}.`, {
      ...keysOf(row),
      record: s.body,
      takenAt,
    });
  } else {
    await emit(ctx, "status", "appliance", "reported", `The appliance answered status with ${s.status}, ${s.refusal.code}.`, {
      ...keysOf(row),
      status: s.status,
      refusal: s.refusal,
      takenAt,
    });
  }
  const young = Date.now() - Date.parse(row.createdAt) < 2 * 3_600_000;
  if (young && s.status !== 404 && !(s.ok && ["paid", "closed", "stale"].includes(s.body.state))) {
    await ctx.store.wake(row.id, Date.now() + 30_000, "status");
  }
}

/**
 * A promise to pay's collection (design §3.6): the facilitator's `/capture`, then the app's own read of it. A failed
 * capture is asked again each minute until the capture's deadline; after it, the money stays in escrow.
 */
async function captureStep(row: StoredRow, ctx: KitContext): Promise<void> {
  const cap = row.capture;
  if (row.state !== "paid" || row.payment !== "authorise" || !cap || !row.transaction || !row.paymentPayload) return;
  if (cap.state === "collected" || cap.state === "failed") return;
  const paymentId = await paymentIdOf(row.paymentPayload);
  if (!paymentId) throw new Error("the payment's id in the escrow could not be read from the payment");
  const deadline = (row.option as AuthoriseOption).extra.captureDeadline;

  let transaction = cap.state === "sent" ? cap.transaction : undefined;
  if (!transaction) {
    if (Date.now() / 1000 > deadline) {
      await ctx.store.transition(row.id, ["paid"], "paid", { capture: { ...cap, state: "failed" } });
      await emit(ctx, "x/capture-failed", "seller", "measured", "The capture's deadline passed: the money stays in escrow, and only the payer can take it back.", {
        ...keysOf(row),
        deadline,
      });
      return;
    }
    const r = await facilitator.capture(row.transaction);
    await emit(
      ctx,
      "capture",
      "chain",
      "reported",
      r.ok
        ? r.body.success
          ? `The facilitator captured the payment from escrow in ${r.body.transaction}.`
          : `The facilitator answered the capture with ${r.body.errorReason ?? "a failure"}.`
        : `The facilitator did not answer the capture: ${r.why}.`,
      { ...keysOf(row), ...(r.ok ? { response: r.body as unknown as Json } : { why: r.why }), ms: r.ms },
    );
    const sent = r.ok && r.body.transaction && (r.body.success || r.body.errorReason === SETTLEMENT_PENDING) ? r.body.transaction : undefined;
    if (!sent) {
      await ctx.store.wake(row.id, Date.now() + 60_000, "capture");
      return;
    }
    transaction = sent;
    await ctx.store.transition(row.id, ["paid"], "paid", { capture: { ...cap, state: "sent", transaction } });
  }

  const read = await readCapture({ transaction, paymentId, payTo: row.option.payTo, amount: row.amount }, evmReader(ctx.settings.rpcUrl));
  await emit(
    ctx,
    "chain/read",
    "chain",
    "measured",
    read.state === "collected"
      ? `The app read the capture on chain, in block ${read.block}: the escrow paid the amount to the treasury.`
      : read.state === "pending"
        ? "The app did not yet find the capture on chain."
        : `The app's read of the capture failed: ${read.why}.`,
    { ...keysOf(row), what: "capture", transaction, ...read },
  );
  if (read.state === "collected") {
    await ctx.store.transition(row.id, ["paid"], "paid", { capture: { state: "collected", due: cap.due, transaction } });
  } else if (read.state === "pending") {
    await ctx.store.wake(row.id, Date.now() + 15_000, "capture");
  } else {
    await ctx.store.transition(row.id, ["paid"], "paid", { capture: { state: "due", due: cap.due } });
    await ctx.store.wake(row.id, Date.now() + 60_000, "capture");
  }
}

/** What the store's alarm runs for a checkout (`KitStore.wake`). */
export async function resume(why: "settle" | "status" | "capture", row: StoredRow, ctx: KitContext): Promise<void> {
  if (why === "settle") await settleStep(row, ctx);
  else if (why === "status") await statusStep(row, ctx);
  else await captureStep(row, ctx);
}
