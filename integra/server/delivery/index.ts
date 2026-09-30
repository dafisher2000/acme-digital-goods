// Delivery (design §5): the five kinds of offer, each delivered once, after settlement; and the addresses where a
// delivery is read: /orders/<id>, /bookings/<id> and /members/<offer>/<file>.
//
// Choices where the design is silent (each is said in the report):
// - Every delivery is keyed by its checkout's id, which is long and random (CheckoutId): that id is the order's, the
//   booking's and the answer's. A pass is HMAC-SHA-256 of the checkout id under the seller credential, so it cannot be
//   guessed without the credential, and `deliver` called twice gives the same delivery instead of a second one.
// - A delivery's event carries the size and SHA-256 of its bytes: the file's own; the `.ics` text; the pass's
//   `files` JSON; the answer's text; the order confirmation's JSON.
import {
  DEMONSTRATION_SENTENCE,
  ORDER_DEMONSTRATION_SENTENCE,
  bookingPath,
  membersPath,
  orderPath,
  type CheckoutRow,
  type Delivered,
  type DeliversSlot,
  type IsoTime,
  type KitContext,
  type KitDelivery,
  type KitHandler,
  type Offer,
} from "@demo-factory/interfaces";
import { icsOf } from "./ics.ts";
import { runAnswer } from "./answer.ts";

const enc = new TextEncoder();

export async function sha256Hex(bytes: Uint8Array): Promise<`0x${string}`> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return `0x${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** The pass of one checkout: unguessable without the seller credential, and the same each time it is asked for. */
async function passOf(checkout: string, ctx: KitContext): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(ctx.sellerCredential), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `pass_${base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`pass:${checkout}`))))}`;
}

const reference = (prefix: string, checkout: string) => `${prefix}-${checkout.replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase()}`;

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function goodsBytes(path: string, ctx: KitContext): Uint8Array {
  const bytes = ctx.goods.get(path);
  if (!bytes) throw new Error(`goods: src/goods/${path} is not in the Worker`);
  return bytes;
}

/** What the agreement's `demonstration.delivery` says, for each kind: what the seller will do, and what it will not. */
const WORDS = {
  file: "After the payment settles, the file named in this agreement is delivered in the answer to the paid request, and only then. Its SHA-256 is named here before the payment, so the buyer can check it.",
  booking:
    "After the payment settles, one slot is held for the buyer and confirmed at the address named in this agreement, with an .ics file. A slot is held for one buyer only. Nothing else is arranged.",
  access:
    "After the payment settles, the buyer is given a pass, good for a stated time, that opens the members' files under the address named in this agreement. Without the pass the address answers 401.",
  answer:
    "After the payment settles, a language model does the work the offer describes, once, on what the buyer gave. The work is delivered in the answer to the paid request and can be read again at the address named in this agreement. What the buyer gave is public, in this agreement.",
  order: ORDER_DEMONSTRATION_SENTENCE,
} as const;

export const delivery: KitDelivery = {
  async describe(offer, checkout, ctx) {
    const d = offer.delivers;
    let delivers: DeliversSlot;
    switch (d.kind) {
      case "file": {
        const bytes = goodsBytes(d.file, ctx);
        delivers = { kind: "file", name: basename(d.file), size: bytes.length, sha256: await sha256Hex(bytes) };
        break;
      }
      case "booking":
        delivers = { kind: "booking", url: ctx.origin + bookingPath(checkout) };
        break;
      case "access":
        delivers = { kind: "access", url: ctx.origin + membersPath(offer.id) };
        break;
      case "answer":
        delivers = { kind: "answer", url: ctx.origin + orderPath(checkout) };
        break;
      case "order":
        delivers = { kind: "order", url: ctx.origin + orderPath(checkout) };
        break;
    }
    return { delivers, words: WORDS[d.kind] };
  },

  async deliver(offer, checkout, ctx) {
    const d = offer.delivers;
    const id = checkout.id;
    let delivered: Delivered;
    let measured: Uint8Array;
    let fresh = true;

    switch (d.kind) {
      case "file": {
        const bytes = goodsBytes(d.file, ctx);
        delivered = {
          kind: "file",
          name: basename(d.file),
          mediaType: ctx.goods.mediaType(d.file),
          size: bytes.length,
          sha256: await sha256Hex(bytes),
          base64: base64(bytes),
        };
        measured = bytes;
        // A file has no record of its own: it is the purchase (design §5), and the same bytes each time.
        fresh = !(await alreadyDelivered(ctx, checkout));
        break;
      }
      case "booking": {
        const kept = await ctx.store.delivery("booking", id);
        const start = (kept?.kind === "booking" ? kept.start : checkout.slot) as IsoTime | undefined;
        if (!start) throw new Error("booking: the checkout took no slot at its claim");
        const end = (kept?.kind === "booking" ? kept.end : new Date(Date.parse(start) + d.minutes * 60_000).toISOString()) as IsoTime;
        const ref = kept?.kind === "booking" ? kept.reference : reference("BK", id);
        if (!kept) {
          await ctx.store.putDelivery({ kind: "booking", id, checkout: id, offer: offer.id, start, end, reference: ref });
        }
        fresh = !kept;
        const ics = icsOf({ reference: ref, host: ctx.host, summary: offer.name, start, end, description: offer.about, url: ctx.origin + bookingPath(id) });
        delivered = { kind: "booking", reference: ref, start, end, timezone: d.timezone, ics, url: ctx.origin + bookingPath(id) };
        measured = enc.encode(ics);
        break;
      }
      case "access": {
        const pass = await passOf(id, ctx);
        const kept = await ctx.store.delivery("access", pass);
        const until = (kept?.kind === "access" ? kept.until : new Date(Date.now() + d.hours * 3_600_000).toISOString()) as IsoTime;
        if (!kept) await ctx.store.putDelivery({ kind: "access", pass, checkout: id, offer: offer.id, until });
        fresh = !kept;
        const files = d.opens.map((f) => ({ name: f, url: ctx.origin + membersPath(offer.id, f) }));
        delivered = { kind: "access", pass, until, files };
        measured = enc.encode(JSON.stringify(files));
        break;
      }
      case "answer": {
        const kept = await ctx.store.delivery("answer", id);
        let text: string;
        if (kept?.kind === "answer") text = kept.text;
        else {
          text = await runAnswer(d.instructions, checkout.with, ctx.ai, ctx.settings.answerModel);
          await ctx.store.putDelivery({ kind: "answer", id, checkout: id, offer: offer.id, text });
        }
        fresh = !kept;
        delivered = { kind: "answer", text, url: ctx.origin + orderPath(id) };
        measured = enc.encode(text);
        break;
      }
      case "order": {
        // The stock was reduced when the payment was claimed (claimAndTake); the order is recorded here.
        const kept = await ctx.store.delivery("order", id);
        const number = kept?.kind === "order" ? kept.number : reference("ORD", id);
        if (!kept) await ctx.store.putDelivery({ kind: "order", id, checkout: id, offer: offer.id, number, to: checkout.with, state: "recorded" });
        fresh = !kept;
        delivered = {
          kind: "order",
          number,
          items: [{ offer: offer.id, name: offer.name, quantity: 1 }],
          to: checkout.with,
          url: ctx.origin + orderPath(id),
          note: ORDER_DEMONSTRATION_SENTENCE,
        };
        measured = enc.encode(JSON.stringify({ number, items: delivered.items, to: delivered.to }));
        break;
      }
    }

    if (fresh) {
      await ctx.store.append({
        side: "seller",
        source: "measured",
        step: "delivery",
        text: `Delivered the ${d.kind} for order ${id}, ${measured.length} bytes.`,
        data: {
          checkout: id,
          atrHash: checkout.atrHash,
          advertised: checkout.advertised,
          ...(checkout.negotiation ? { negotiation: checkout.negotiation } : {}),
          kind: d.kind,
          size: measured.length,
          sha256: await sha256Hex(measured),
          ...("url" in delivered ? { url: delivered.url } : {}),
        },
      });
    }
    return delivered;
  },
};

/** A file is delivered again to a repeat of the paid request: the event is written for the first delivery only. */
async function alreadyDelivered(ctx: KitContext, checkout: CheckoutRow): Promise<boolean> {
  const events = await ctx.store.eventsOf({ checkout: checkout.id });
  return events.some((e) => e.step === "delivery");
}

const NO_STORE = { "cache-control": "no-store", "x-robots-tag": "noindex" };

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...NO_STORE, ...extra },
  });
}

const notFound = (what: string) => json({ error: `no such ${what}` }, 404);

function offerOf(id: string, ctx: KitContext): Offer | undefined {
  return ctx.business.offers.find((o) => o.id === id);
}

/** `GET /orders/<id>`: an order's state; an answer, read again. Reachable only by the purchase's own id. */
export const orders: KitHandler = async (request, params, ctx) => {
  if (request.method !== "GET") return json({ error: "GET only" }, 405, { allow: "GET" });
  const id = params.id!;
  const order = await ctx.store.delivery("order", id);
  if (order?.kind === "order") {
    const offer = offerOf(order.offer, ctx);
    return json({
      order: order.number,
      state: order.state,
      offer: order.offer,
      items: [{ offer: order.offer, name: offer?.name ?? order.offer, quantity: 1 }],
      to: order.to,
      note: ORDER_DEMONSTRATION_SENTENCE,
      demonstration: DEMONSTRATION_SENTENCE,
    });
  }
  const answer = await ctx.store.delivery("answer", id);
  if (answer?.kind === "answer") {
    return json({ offer: answer.offer, answer: answer.text, demonstration: DEMONSTRATION_SENTENCE });
  }
  return notFound("order");
};

/** `GET /bookings/<id>`: a booking, and its `.ics` (`?format=ics`, or `Accept: text/calendar`). */
export const bookings: KitHandler = async (request, params, ctx) => {
  if (request.method !== "GET") return json({ error: "GET only" }, 405, { allow: "GET" });
  const id = params.id!;
  const booking = await ctx.store.delivery("booking", id);
  if (booking?.kind !== "booking") return notFound("booking");
  const offer = offerOf(booking.offer, ctx);
  const ics = icsOf({
    reference: booking.reference,
    host: ctx.host,
    summary: offer?.name ?? booking.offer,
    start: booking.start,
    end: booking.end,
    description: offer?.about ?? "",
    url: ctx.origin + bookingPath(id),
  });
  const wantsIcs = new URL(request.url).searchParams.get("format") === "ics" || (request.headers.get("accept") ?? "").includes("text/calendar");
  if (wantsIcs) {
    return new Response(ics, {
      headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": `attachment; filename="${booking.reference}.ics"`, ...NO_STORE },
    });
  }
  return json({
    reference: booking.reference,
    state: "confirmed",
    offer: booking.offer,
    start: booking.start,
    end: booking.end,
    ics,
    demonstration: DEMONSTRATION_SENTENCE,
  });
};

/** The pass a request carries: `Authorization: Bearer <pass>`, `X-Pass`, or `?pass=`. */
function passOfRequest(request: Request): string | null {
  const auth = request.headers.get("authorization");
  const bearer = auth && /^Bearer\s+(\S+)$/i.exec(auth);
  return (bearer && bearer[1]) || request.headers.get("x-pass") || new URL(request.url).searchParams.get("pass");
}

/** `GET /members/<offer>/<file>`: `401` without the pass, the file with it. */
export const members: KitHandler = async (request, params, ctx) => {
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "GET only" }, 405, { allow: "GET, HEAD" });
  const unauthorised = () =>
    json({ error: "A pass is needed. Buy this offer, and send the pass as `Authorization: Bearer <pass>`." }, 401, {
      "www-authenticate": 'Bearer realm="members"',
    });
  const pass = passOfRequest(request);
  if (!pass) return unauthorised();
  const record = await ctx.store.delivery("access", pass);
  if (record?.kind !== "access" || record.offer !== params.offer || Date.parse(record.until) <= Date.now()) return unauthorised();
  const offer = offerOf(record.offer, ctx);
  if (!offer || offer.delivers.kind !== "access") return notFound("members' area");
  const file = params.file!;
  if (file === "") {
    return json({
      offer: offer.id,
      until: record.until,
      files: offer.delivers.opens.map((f) => ({ name: f, url: ctx.origin + membersPath(offer.id, f) })),
      demonstration: DEMONSTRATION_SENTENCE,
    });
  }
  if (!offer.delivers.opens.includes(file)) return notFound("file");
  const bytes = ctx.goods.get(file);
  if (!bytes) return notFound("file");
  return new Response(request.method === "HEAD" ? null : (bytes as BodyInit), {
    headers: { "content-type": ctx.goods.mediaType(file), "content-length": String(bytes.length), ...NO_STORE },
  });
};
