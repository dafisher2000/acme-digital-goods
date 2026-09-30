// The store (design §8.1): one Durable Object with SQLite, which holds everything the app remembers. Every other part
// reads and writes the app's records only through its methods, which are KitStore's (@demo-factory/interfaces), called by
// Durable Object RPC. A change of state is one write: each method that changes a row runs as one synchronous
// transaction, so nothing interleaves inside it.
//
// It also serves `/api/events` as server-sent events (its `fetch`), and runs the alarm that finishes what a request left
// to it: a `settling` checkout, the record's `status`, a promise to pay's capture (design §3.4, §3.6), and each open
// checkout's expiry.
import { DurableObject } from "cloudflare:workers";
import business from "integra:server/business";
import {
  HEADLINES,
  proofPath,
  sseFrame,
  type AtrHash,
  type CheckoutId,
  type CheckoutRow,
  type CheckoutState,
  type ClaimTake,
  type DeliveryRecord,
  type EventEnvelope,
  type IsoTime,
  type JsonObject,
  type KitStore,
  type NegotiationId,
  type NegotiationRow,
  type NewEvent,
  type Offer,
  type OfferId,
  type Purchase,
  type PurchaseSummary,
  type RecordView,
  type Supply,
} from "@demo-factory/interfaces";
import { resume } from "../checkout/index.ts";
import { slotsOf } from "../delivery/slots.ts";
import { contextFor, type Env } from "../env.ts";

/** A checkout row as the checkout hands it over: with the origin it was bought at, where its proof lives. */
export type StoredRow = CheckoutRow & { origin?: string };

type Why = "settle" | "status" | "capture" | "expire";

interface Stream {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  seq: number;
  last: number;
  opened: number;
}

/** A stream closes after this long with no event (design §8.4: it stays open only while a purchase runs). */
const STREAM_IDLE_MS = 120_000;
/** …and after this long in all. The page takes up again from `Last-Event-ID`. */
const STREAM_MAX_MS = 15 * 60_000;
const KEEP_ALIVE_MS = 15_000;

const enc = new TextEncoder();
const nowIso = (): IsoTime => new Date().toISOString() as IsoTime;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT NOT NULL, side TEXT NOT NULL,
     source TEXT NOT NULL, step TEXT NOT NULL, text TEXT NOT NULL, data TEXT NOT NULL,
     checkout TEXT, atr_hash TEXT, advertised TEXT, negotiation TEXT)`,
  `CREATE INDEX IF NOT EXISTS events_checkout ON events(checkout)`,
  `CREATE INDEX IF NOT EXISTS events_atr_hash ON events(atr_hash)`,
  `CREATE INDEX IF NOT EXISTS events_advertised ON events(advertised)`,
  `CREATE INDEX IF NOT EXISTS events_negotiation ON events(negotiation)`,
  `CREATE TABLE IF NOT EXISTS checkouts (id TEXT PRIMARY KEY, atr_hash TEXT NOT NULL, advertised TEXT NOT NULL,
     offer TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, origin TEXT, row TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS checkouts_atr_hash ON checkouts(atr_hash)`,
  `CREATE INDEX IF NOT EXISTS checkouts_advertised ON checkouts(advertised)`,
  `CREATE INDEX IF NOT EXISTS checkouts_created ON checkouts(created_at)`,
  `CREATE TABLE IF NOT EXISTS stock_taken (checkout TEXT PRIMARY KEY, offer TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS stock_taken_offer ON stock_taken(offer)`,
  `CREATE TABLE IF NOT EXISTS slots_taken (offer TEXT NOT NULL, start TEXT NOT NULL, checkout TEXT NOT NULL, PRIMARY KEY (offer, start))`,
  `CREATE TABLE IF NOT EXISTS agreements (atr_hash TEXT PRIMARY KEY, bytes BLOB NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS records (atr_hash TEXT PRIMARY KEY, view TEXT NOT NULL, taken_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS negotiations (id TEXT PRIMARY KEY, row TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS deliveries (kind TEXT NOT NULL, key TEXT NOT NULL, row TEXT NOT NULL, PRIMARY KEY (kind, key))`,
  `CREATE TABLE IF NOT EXISTS wakes (checkout TEXT NOT NULL, why TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (checkout, why))`,
];

/** What the page may say of a checkout, by the rule of design §3.4. */
export function headlineOf(row: CheckoutRow): string {
  switch (row.state) {
    case "paid":
      if (row.payment === "now") return HEADLINES.paid;
      if (row.payment === "deferred") return HEADLINES.anchored;
      return row.capture?.state === "collected" ? `${HEADLINES.authorised}. ${HEADLINES.collected}.` : HEADLINES.authorised;
    case "settling":
      return HEADLINES.sent;
    case "claiming":
      return HEADLINES.claiming;
    case "open":
      return HEADLINES.open;
    case "refused":
      return HEADLINES.refused;
    case "expired":
      return HEADLINES.expired;
  }
}

/** A checkout as a purchase: what `get_purchase`, a pending answer, `/api/purchases` and the proof give. */
export function purchaseOf(row: StoredRow): Purchase {
  const offer = business.offers.find((o) => o.id === row.offer);
  const origin = row.origin ?? "http://localhost";
  const p: Purchase = {
    checkout: row.id,
    offer: row.offer,
    offerName: offer?.name ?? row.offer,
    payment: row.payment,
    test: row.test,
    door: row.door,
    state: row.state,
    headline: headlineOf(row),
    atrHash: row.atrHash,
    advertised: row.advertised,
    link: row.link,
    price: row.price,
    amount: row.amount,
    proof: origin + proofPath(row.advertised),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.negotiation) p.negotiation = row.negotiation;
  if (row.deferred) p.deferred = { owed: row.deferred.owed, amount: row.deferred.amount, due: row.deferred.due, rule: row.deferred.rule };
  if (row.transaction) p.transaction = row.transaction;
  if (row.delivery) p.delivery = row.delivery;
  if (row.capture) p.capture = row.capture;
  if (row.refusal) p.refusal = row.refusal;
  return p;
}

function offerOf(id: OfferId): Offer | undefined {
  return business.offers.find((o) => o.id === id);
}

export class IntegraStore extends DurableObject<Env> implements KitStore {
  private readonly sql: SqlStorage;
  private readonly streams = new Set<Stream>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const statement of SCHEMA) this.sql.exec(statement);
  }

  // --- events (design §8.2, §8.4) -------------------------------------------------------------------------------------

  async append(event: NewEvent): Promise<EventEnvelope> {
    const t = nowIso();
    const d = event.data as Record<string, unknown>;
    const row = this.sql
      .exec<{ seq: number }>(
        `INSERT INTO events (t, side, source, step, text, data, checkout, atr_hash, advertised, negotiation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
        t,
        event.side,
        event.source,
        event.step,
        event.text,
        JSON.stringify(event.data),
        str(d["checkout"]),
        str(d["atrHash"]),
        str(d["advertised"]),
        str(d["negotiation"]),
      )
      .one();
    const envelope: EventEnvelope = { seq: row.seq, t, side: event.side, source: event.source, step: event.step, text: event.text, data: event.data };
    this.tell(envelope);
    return envelope;
  }

  async eventsAfter(seq: number, limit = 500): Promise<EventEnvelope[]> {
    return this.eventsAfterNow(seq, limit);
  }

  private eventsAfterNow(seq: number, limit: number): EventEnvelope[] {
    return this.sql
      .exec<{ seq: number; t: string; side: string; source: string; step: string; text: string; data: string }>(
        `SELECT seq, t, side, source, step, text, data FROM events WHERE seq > ? ORDER BY seq LIMIT ?`,
        seq,
        Math.max(1, Math.min(limit, 5000)),
      )
      .toArray()
      .map(envelopeOf);
  }

  async eventsOf(keys: { checkout?: CheckoutId; atrHash?: AtrHash; negotiation?: NegotiationId }): Promise<EventEnvelope[]> {
    const h = keys.atrHash ?? null;
    return this.sql
      .exec<{ seq: number; t: string; side: string; source: string; step: string; text: string; data: string }>(
        `SELECT seq, t, side, source, step, text, data FROM events
         WHERE checkout = ? OR atr_hash = ? OR advertised = ? OR negotiation = ? ORDER BY seq`,
        keys.checkout ?? null,
        h,
        h,
        keys.negotiation ?? null,
      )
      .toArray()
      .map(envelopeOf);
  }

  // --- checkouts (design §3.3, §3.4) ----------------------------------------------------------------------------------

  async putCheckout(row: CheckoutRow): Promise<void> {
    const { origin, ...plain } = row as StoredRow;
    this.sql.exec(
      `INSERT INTO checkouts (id, atr_hash, advertised, offer, state, created_at, origin, row) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.atrHash,
      row.advertised,
      row.offer,
      row.state,
      row.createdAt,
      origin ?? null,
      JSON.stringify(plain),
    );
    // Its expiry, if it is still open then (design §3.4, the state `expired`; §6, "no payment arrived").
    await this.schedule(row.id, row.expiresAt * 1000 + 1000, "expire");
  }

  async checkout(by: { id: CheckoutId } | { hash: AtrHash }): Promise<StoredRow | null> {
    return "id" in by ? this.rowById(by.id) : this.rowByHash(by.hash);
  }

  private rowById(id: string): StoredRow | null {
    const r = this.sql.exec<{ row: string; origin: string | null }>(`SELECT row, origin FROM checkouts WHERE id = ?`, id).toArray()[0];
    return r ? rowOf(r) : null;
  }

  private rowByHash(hash: string): StoredRow | null {
    const r = this.sql
      .exec<{ row: string; origin: string | null }>(
        `SELECT row, origin FROM checkouts WHERE advertised = ? OR atr_hash = ? ORDER BY advertised = ? DESC LIMIT 1`,
        hash,
        hash,
        hash,
      )
      .toArray()[0];
    return r ? rowOf(r) : null;
  }

  private write(row: StoredRow): void {
    const { origin, ...plain } = row;
    this.sql.exec(`UPDATE checkouts SET state = ?, row = ? WHERE id = ?`, row.state, JSON.stringify(plain), row.id);
    void origin;
  }

  async claimAndTake(hash: AtrHash, slot?: IsoTime): Promise<ClaimTake> {
    return this.ctx.storage.transactionSync((): ClaimTake => {
      const r = this.sql
        .exec<{ row: string; origin: string | null }>(`SELECT row, origin FROM checkouts WHERE advertised = ?`, hash)
        .toArray()[0];
      if (!r) return { ok: false, why: "unknown", row: null };
      const row = rowOf(r);
      if (row.state !== "open") return { ok: false, why: "in-progress", row };
      if (Date.now() >= row.expiresAt * 1000) return { ok: false, why: "expired", row };

      // The quote pays once (design §7.4): marked used by this checkout, at its claim.
      let negotiation: NegotiationRow | null = null;
      if (row.negotiation) {
        negotiation = this.negotiationNow(row.negotiation);
        if (!negotiation || (negotiation.usedBy !== undefined && negotiation.usedBy !== row.id)) {
          return { ok: false, why: "quote-used", row };
        }
      }

      // One unit of stock, or the slot. Nothing is held for an unpaid request (design §3.3, step 2).
      const offer = offerOf(row.offer);
      const d = offer?.delivers;
      let taken: IsoTime | undefined;
      if (!row.test && d?.kind === "order") {
        const count = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM stock_taken WHERE offer = ?`, row.offer).one().n;
        if (count >= d.stock) return { ok: false, why: "none-left", row };
        this.sql.exec(`INSERT INTO stock_taken (checkout, offer) VALUES (?, ?)`, row.id, row.offer);
      }
      if (!row.test && d?.kind === "booking") {
        const free = this.freeSlots(row.offer, d);
        const wanted = normalSlot(slot ?? row.with["slot"]);
        taken = wanted === undefined ? free[0] : free.includes(wanted) ? wanted : undefined;
        if (taken === undefined) return { ok: false, why: "none-left", row };
        this.sql.exec(`INSERT INTO slots_taken (offer, start, checkout) VALUES (?, ?, ?)`, row.offer, taken, row.id);
      }
      if (negotiation) {
        negotiation.usedBy = row.id;
        this.sql.exec(`UPDATE negotiations SET row = ? WHERE id = ?`, JSON.stringify(negotiation), negotiation.id);
      }
      const next: StoredRow = { ...row, state: "claiming", updatedAt: nowIso() };
      if (taken !== undefined) next.slot = taken;
      this.write(next);
      return { ok: true, row: next };
    });
  }

  async transition(id: CheckoutId, from: CheckoutState[], to: CheckoutState, patch: Partial<CheckoutRow> = {}): Promise<StoredRow | null> {
    return this.ctx.storage.transactionSync((): StoredRow | null => {
      const row = this.rowById(id);
      if (!row || !from.includes(row.state)) return null;
      const next: StoredRow = { ...row, ...patch, id: row.id, state: to, updatedAt: nowIso() };
      // Moving a taken checkout back puts back what it took, and frees its quote (design §3.4, steps 4 to 6).
      if ((row.state === "claiming" || row.state === "settling") && (to === "open" || to === "refused")) {
        this.sql.exec(`DELETE FROM stock_taken WHERE checkout = ?`, id);
        this.sql.exec(`DELETE FROM slots_taken WHERE checkout = ?`, id);
        delete next.slot;
        if (row.negotiation) {
          const n = this.negotiationNow(row.negotiation);
          if (n && n.usedBy === id) {
            delete n.usedBy;
            this.sql.exec(`UPDATE negotiations SET row = ? WHERE id = ?`, JSON.stringify(n), n.id);
          }
        }
      }
      this.write(next);
      return next;
    });
  }

  async supply(offer: Offer): Promise<Supply> {
    const d = offer.delivers;
    if (d.kind === "order") {
      const count = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM stock_taken WHERE offer = ?`, offer.id).one().n;
      return { kind: "stock", left: Math.max(0, d.stock - count) };
    }
    if (d.kind === "booking") return { kind: "slots", free: this.freeSlots(offer.id, d) };
    return { kind: "unlimited" };
  }

  private freeSlots(offer: OfferId, d: Extract<Offer["delivers"], { kind: "booking" }>): IsoTime[] {
    const taken = new Set(
      this.sql.exec<{ start: string }>(`SELECT start FROM slots_taken WHERE offer = ?`, offer).toArray().map((r) => r.start),
    );
    return slotsOf(d, Date.now()).filter((s) => !taken.has(s));
  }

  // --- the kept copies (design §8) ------------------------------------------------------------------------------------

  async keepAgreement(atrHash: AtrHash, bytes: Uint8Array): Promise<void> {
    this.sql.exec(`INSERT OR IGNORE INTO agreements (atr_hash, bytes) VALUES (?, ?)`, atrHash, bytes);
  }

  async agreement(atrHash: AtrHash): Promise<Uint8Array | null> {
    const r = this.sql.exec<{ bytes: ArrayBuffer }>(`SELECT bytes FROM agreements WHERE atr_hash = ?`, atrHash).toArray()[0];
    return r ? new Uint8Array(r.bytes) : null;
  }

  async keepRecord(atrHash: AtrHash, view: RecordView): Promise<void> {
    this.sql.exec(`INSERT OR REPLACE INTO records (atr_hash, view, taken_at) VALUES (?, ?, ?)`, atrHash, JSON.stringify(view), nowIso());
  }

  async record(atrHash: AtrHash): Promise<{ view: RecordView; takenAt: IsoTime } | null> {
    const r = this.sql.exec<{ view: string; taken_at: string }>(`SELECT view, taken_at FROM records WHERE atr_hash = ?`, atrHash).toArray()[0];
    return r ? { view: JSON.parse(r.view) as RecordView, takenAt: r.taken_at as IsoTime } : null;
  }

  // --- negotiation (design §7) ----------------------------------------------------------------------------------------

  async negotiation(id: NegotiationId): Promise<NegotiationRow | null> {
    return this.negotiationNow(id);
  }

  private negotiationNow(id: string): NegotiationRow | null {
    const r = this.sql.exec<{ row: string }>(`SELECT row FROM negotiations WHERE id = ?`, id).toArray()[0];
    return r ? (JSON.parse(r.row) as NegotiationRow) : null;
  }

  async putNegotiation(row: NegotiationRow): Promise<void> {
    this.sql.exec(`INSERT OR REPLACE INTO negotiations (id, row) VALUES (?, ?)`, row.id, JSON.stringify(row));
  }

  // --- delivery's records (design §5): keyed by the checkout's id, and a pass by the pass ----------------------------

  async putDelivery(record: DeliveryRecord): Promise<void> {
    const key = record.kind === "access" ? record.pass : record.id;
    this.sql.exec(`INSERT OR REPLACE INTO deliveries (kind, key, row) VALUES (?, ?, ?)`, record.kind, key, JSON.stringify(record));
  }

  async delivery(kind: DeliveryRecord["kind"], key: string): Promise<DeliveryRecord | null> {
    const r = this.sql.exec<{ row: string }>(`SELECT row FROM deliveries WHERE kind = ? AND key = ?`, kind, key).toArray()[0];
    return r ? (JSON.parse(r.row) as DeliveryRecord) : null;
  }

  // --- purchases (design §8.4) ----------------------------------------------------------------------------------------

  /** Every checkout a payment reached, newest first: `claiming`, `settling`, `paid` and `refused`. */
  async purchases(query: { offer?: OfferId; limit?: number }): Promise<PurchaseSummary[]> {
    const limit = Math.max(1, Math.min(query.limit ?? 20, 100));
    const rows = this.sql
      .exec<{ row: string; origin: string | null }>(
        `SELECT row, origin FROM checkouts WHERE state IN ('claiming', 'settling', 'paid', 'refused') AND (? IS NULL OR offer = ?)
         ORDER BY created_at DESC, id LIMIT ?`,
        query.offer ?? null,
        query.offer ?? null,
        limit,
      )
      .toArray();
    return rows.map((r) => {
      const { delivery, ...purchase } = purchaseOf(rowOf(r));
      void delivery;
      const seq = this.sql
        .exec<{ seq: number | null }>(
          `SELECT MAX(seq) AS seq FROM events WHERE checkout = ? OR atr_hash = ? OR advertised = ?`,
          purchase.checkout,
          purchase.atrHash,
          purchase.advertised,
        )
        .one().seq;
      return { ...purchase, seq: seq ?? 0 };
    });
  }

  async purchase(hash: AtrHash): Promise<Purchase | null> {
    const row = this.rowByHash(hash);
    return row ? purchaseOf(row) : null;
  }

  // --- the alarm (design §3.4, §3.6) ----------------------------------------------------------------------------------

  async wake(id: CheckoutId, at: number, why: "settle" | "status" | "capture"): Promise<void> {
    await this.schedule(id, at, why);
  }

  private async schedule(id: string, at: number, why: Why): Promise<void> {
    this.sql.exec(`INSERT OR REPLACE INTO wakes (checkout, why, at) VALUES (?, ?, ?)`, id, why, Math.floor(at));
    await this.arm();
  }

  /**
   * The alarm set for the earliest wake. An alarm already set for later is brought forward; one set in the past is set
   * again: it never ran, or Cloudflare gave it up after its retries (it still reports its time, and never fires), and
   * such a store would never wake again. While the alarm runs, `getAlarm` answers null (Cloudflare's rule, and the
   * hosting's), so the alarm's own `arm` is never taken for a past one.
   */
  private async arm(): Promise<void> {
    const next = this.sql.exec<{ at: number | null }>(`SELECT MIN(at) AS at FROM wakes`).one().at;
    if (next === null) return;
    const current = await this.ctx.storage.getAlarm();
    const now = Date.now();
    if (current === null || current > next || current < now) await this.ctx.storage.setAlarm(Math.max(next, now + 50));
  }

  /**
   * Every wake that is due runs its step. A wake is deleted after its step, never before, so a step cut short (a
   * deploy, a reset of the store) leaves its wake, and the alarm's retry, the next `arm` or the hosting's sweep runs it
   * again. Each step is safe to run again: it starts from the checkout's state, and the facilitator answers a capture it
   * has sent from its journal. The delete names the wake's time, so a step that set its own wake again keeps the new one.
   */
  async alarm(): Promise<void> {
    const due = this.sql
      .exec<{ checkout: string; why: Why; at: number }>(`SELECT checkout, why, at FROM wakes WHERE at <= ? ORDER BY at`, Date.now() + 250)
      .toArray();
    for (const w of due) {
      try {
        if (w.why === "expire") await this.expire(w.checkout);
        else await this.step(w.checkout, w.why);
        this.sql.exec(`DELETE FROM wakes WHERE checkout = ? AND why = ? AND at = ?`, w.checkout, w.why, w.at);
      } catch (e) {
        await this.append({
          side: "seller",
          source: "measured",
          step: "x/alarm-failed",
          text: `The store's alarm could not run its ${w.why} step for order ${w.checkout}; it tries again in a minute.`,
          data: { checkout: w.checkout, why: w.why, error: e instanceof Error ? e.message : String(e) },
        });
        // Its wake, kept, is set a minute on: an expiry too, which before was dropped with its wake.
        await this.schedule(w.checkout, Date.now() + 60_000, w.why);
      }
    }
    await this.arm();
  }

  /** A checkout's own step, run by the checkout's code with a context built here (design §3.4: "the alarm runs it"). */
  private async step(id: string, why: "settle" | "status" | "capture"): Promise<void> {
    const row = this.rowById(id);
    if (!row) return;
    const ctx = contextFor(this.env, row.origin ?? "http://localhost", this, (p) => this.ctx.waitUntil(p));
    await resume(why, row, ctx);
  }

  /** An open checkout whose lifetime passed, unclaimed. At the test checkout, no payment arrived (design §6). */
  private async expire(id: string): Promise<void> {
    const row = this.rowById(id);
    if (!row || row.state !== "open") return;
    const next = await this.transition(id, ["open"], "expired");
    if (!next) return;
    await this.append({
      side: "seller",
      source: "measured",
      step: "checkout/state",
      text: `Order ${id} expired unclaimed.`,
      data: { checkout: id, atrHash: row.atrHash, advertised: row.advertised, state: "expired", was: "open" },
    });
    if (row.test) {
      await this.append({
        side: "seller",
        source: "measured",
        step: "test/outcome",
        text: "No payment arrived at this offer's test checkout while this one was open.",
        data: { checkout: id, atrHash: row.atrHash, advertised: row.advertised, offer: row.offer, outcome: "none-arrived" },
      });
    }
  }

  // --- the live stream: `GET /api/events` (design §8.4) ---------------------------------------------------------------

  /** `/api/events?after=<seq>`, or from `Last-Event-ID`: the events after it, then each as it is appended. */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const fromHeader = request.headers.get("last-event-id");
    const after = Number(fromHeader ?? url.searchParams.get("after") ?? 0);
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const s: Stream = { writer: writable.getWriter(), seq: Number.isSafeInteger(after) && after > 0 ? after : 0, last: Date.now(), opened: Date.now() };
    this.streams.add(s);
    const backlog = this.eventsAfterNow(s.seq, 5000);
    if (backlog.length > 0) s.seq = backlog[backlog.length - 1]!.seq;
    this.send(s, `retry: 3000\n\n${backlog.map(sseFrame).join("")}`);
    this.sweeper ??= setInterval(() => this.sweep(), KEEP_ALIVE_MS);
    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      },
    });
  }

  private send(s: Stream, text: string): void {
    s.writer.write(enc.encode(text)).catch(() => this.drop(s));
  }

  private drop(s: Stream): void {
    if (!this.streams.delete(s)) return;
    s.writer.close().catch(() => {});
    if (this.streams.size === 0 && this.sweeper !== null) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
  }

  private tell(e: EventEnvelope): void {
    for (const s of this.streams) {
      if (e.seq <= s.seq) continue;
      s.seq = e.seq;
      s.last = Date.now();
      this.send(s, sseFrame(e));
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const s of [...this.streams]) {
      if (now - s.last > STREAM_IDLE_MS || now - s.opened > STREAM_MAX_MS) this.drop(s);
      else this.send(s, ": keep-alive\n\n");
    }
  }
}

function rowOf(r: { row: string; origin: string | null }): StoredRow {
  const row = JSON.parse(r.row) as StoredRow;
  if (r.origin) row.origin = r.origin;
  return row;
}

function envelopeOf(r: { seq: number; t: string; side: string; source: string; step: string; text: string; data: string }): EventEnvelope {
  return {
    seq: r.seq,
    t: r.t,
    side: r.side as EventEnvelope["side"],
    source: r.source as EventEnvelope["source"],
    step: r.step as EventEnvelope["step"],
    text: r.text,
    data: JSON.parse(r.data) as JsonObject,
  };
}

/** A slot named by the buyer, as the catalogue lists it: an ISO 8601 instant, written as `toISOString` writes it. */
function normalSlot(v: unknown): IsoTime | undefined {
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? ("invalid" as IsoTime) : (new Date(t).toISOString() as IsoTime);
}
