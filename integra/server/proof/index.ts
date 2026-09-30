// The app's own record, read (design §8): the proof's data and the app's copy of the agreement, the live stream,
// the purchases, and the health of business.json. Each is public, as the agreement is, and readable from any origin.
import {
  ATR_GET_HEADERS,
  DEMONSTRATION_SENTENCE,
  NETWORK,
  PROOF_ATR_CONTENT_TYPE,
  PurchasesQuery,
  SERVICE_ORIGINS,
  check,
  checkBusiness,
  type AtrHash,
  type HealthAnswer,
  type KitHandler,
  type ProofDocument,
  type PurchasesAnswer,
  type RecordView,
} from "@demo-factory/interfaces";
import * as door from "../checkout/door.ts";

const PUBLIC = { "access-control-allow-origin": "*" };

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...PUBLIC, ...extra },
  });
}

const notFound = (what: string) => json(404, { code: "proof/not-found", sentence: `This app has no ${what} under that hash.` });

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return `0x${[...d].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * `GET /proof/<H>.json`: a ProofDocument, by H or by the hash the challenge advertised. When the app has no copy of the
 * appliance's record yet, it reads `status` now, while the door still holds it, and keeps that copy.
 */
export const json_: KitHandler = async (_request, params, ctx) => {
  const hash = params["hash"] as AtrHash;
  const purchase = await ctx.store.purchase(hash);
  if (!purchase) return notFound("purchase");
  let record = await ctx.store.record(purchase.atrHash);
  if (!record && !purchase.test) {
    const s = await door.status(ctx.sellerCredential, purchase.atrHash);
    if (s.ok) {
      await ctx.store.keepRecord(purchase.atrHash, s.body as unknown as RecordView);
      record = await ctx.store.record(purchase.atrHash);
    }
  }
  const events = await ctx.store.eventsOf({
    checkout: purchase.checkout,
    atrHash: purchase.atrHash,
    ...(purchase.negotiation ? { negotiation: purchase.negotiation } : {}),
  });
  const advertisedEvents = purchase.advertised === purchase.atrHash ? [] : await ctx.store.eventsOf({ atrHash: purchase.advertised });
  const bySeq = new Map([...events, ...advertisedEvents].map((e) => [e.seq, e]));
  const doc: ProofDocument = {
    atrHash: purchase.atrHash,
    advertised: purchase.advertised,
    purchase,
    record,
    events: [...bySeq.values()].sort((a, b) => a.seq - b.seq),
    buyerRecord: `${SERVICE_ORIGINS.buyer}/records/${purchase.advertised}`,
    network: NETWORK,
    demonstration: DEMONSTRATION_SENTENCE,
  };
  return json(200, doc);
};
export { json_ as json };

/**
 * `GET /proof/<H>/atr`: the app's copy of the agreement's exact bytes, with the agreement store's GET headers. Under
 * the test checkout's changed hash it is the same agreement, whose bytes hash to H, and not to the hash advertised.
 */
export const atr: KitHandler = async (request, params, ctx) => {
  const hash = params["hash"] as AtrHash;
  let bytes = await ctx.store.agreement(hash);
  let h = hash;
  if (!bytes) {
    const row = await ctx.store.checkout({ hash });
    if (!row) return notFound("agreement");
    h = row.atrHash;
    bytes = await ctx.store.agreement(h);
    if (!bytes) {
      // The agreement store keeps it for 30 days: the copy is taken now, when its bytes hash to H.
      const res = await fetch(row.link, { redirect: "manual", headers: { "accept-encoding": "identity" }, signal: AbortSignal.timeout(10_000) });
      const got = new Uint8Array(await res.arrayBuffer());
      if (res.status !== 200 || (await sha256Hex(got)) !== h) return notFound("copy of the agreement");
      await ctx.store.keepAgreement(h, got);
      bytes = got;
    }
  }
  return new Response(request.method === "HEAD" ? null : (bytes as BodyInit), {
    headers: { ...ATR_GET_HEADERS, "content-type": PROOF_ATR_CONTENT_TYPE, etag: `"${h}"`, "content-length": String(bytes.length) },
  });
};

/** `GET /api/events?after=<seq>`: the app's stream, as server-sent events, served by the store. */
export const events: KitHandler = async (request, _params, ctx) => {
  const stub = ctx.store as unknown as { fetch(request: Request): Promise<Response> };
  return stub.fetch(request);
};

/** `GET /api/purchases?offer=<id>&limit=<n>`: the list behind <Purchases />, newest first. */
export const purchases: KitHandler = async (request, _params, ctx) => {
  const q = check(PurchasesQuery, Object.fromEntries(new URL(request.url).searchParams));
  if (!q.ok) return json(400, { code: "purchases/malformed", sentence: "The query is offer and limit, from 1 to 100." });
  const answer: PurchasesAnswer = {
    purchases: await ctx.store.purchases({
      ...(q.value.offer ? { offer: q.value.offer } : {}),
      ...(q.value.limit ? { limit: q.value.limit } : {}),
    }),
  };
  return json(200, answer);
};

/** `GET /api/health`: whether business.json passes its schema, and why not. */
export const health: KitHandler = async (_request, _params, ctx) => {
  const checked = checkBusiness(ctx.business);
  const answer: HealthAnswer = {
    ok: checked.ok,
    business: { valid: checked.ok, problems: checked.ok ? [] : checked.problems },
  };
  return json(checked.ok ? 200 : 500, answer);
};
