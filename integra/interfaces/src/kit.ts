/**
 * The seams between the kit's server parts (`starter/integra/server/`), as code, so that phase 1 builds the parts at
 * once (the plan's phase 1):
 *
 * | part | folder | owns |
 * |---|---|---|
 * | the checkout | `checkout/` | the unpaid and the paid request, the HTTP door, the test checkout (design §3, §6) |
 * | the store | `store/` | the one Durable Object with SQLite: every record the app keeps (§8.1) |
 * | delivery | `delivery/` | the five kinds, delivered after settlement; `/orders`, `/bookings`, `/members` (§5) |
 * | the agent door | `agent/` | `/mcp` and its tools, x402 over MCP, `/.well-known/*`, `/terms.md`, `/llms.txt`, `/robots.txt` (§3.5, §9) |
 * | negotiation | `negotiation/` | the exchange, the seller's agent, the lowest price in code (§7) |
 * | the proof | `proof/` | `/proof/<H>.json`, `/proof/<H>/atr`, `/api/events`, `/api/purchases`, `/api/health` (§8) |
 *
 * Each part calls another only through the functions named here. The router (`integra/server/index.ts`) builds one
 * `KitContext` per request and hands each route to its part.
 *
 * These types are runtime-agnostic: where a part needs a Cloudflare binding, the context carries it as the narrow
 * shape the part uses, and the starter's `integra/server/env.ts` fills it from the real bindings.
 */
import type { BuyWith, CheckoutId, DeliversSlot, NegotiationId, NegotiationSlot, RequestCommitment } from "./agreement.ts";
import type { AtrHash, IsoTime, JsonObject, Refusal } from "./common.ts";
import type { Business, DeliveryKind, Offer, OfferId, Payment } from "./business.ts";
import type { BuyPaid, BuyRequest, CheckoutState, Delivered, Purchase, V4Option } from "./checkout.ts";
import type { EventEnvelope, Side, Source, Step } from "./events.ts";
import type { NegotiateAnswer, NegotiateRequest } from "./negotiation.ts";
import type { PurchaseSummary, RecordView } from "./routes.ts";
import type { Dollars } from "./price.ts";
import type { PaymentPayload, PaymentRequired, SettleResponse } from "./x402.ts";

// ---------------------------------------------------------------------------------------------------------------------
// The environment every part reads: the app's wrangler.jsonc
// ---------------------------------------------------------------------------------------------------------------------

/** The bindings' names, as `wrangler.jsonc` declares them. */
export const KIT_BINDINGS = {
  /** The store: one Durable Object namespace, class `STORE_CLASS`, with SQLite (design §8.1). */
  store: "STORE",
  /** Workers AI: the seller's agent (§7.2) and the work an `answer` offer delivers (§5). */
  ai: "AI",
  /** The built page: the shell and the storefront, with single-page fallback. */
  assets: "ASSETS",
} as const;

/** The store's Durable Object class, exported by the app's `worker.ts`. */
export const STORE_CLASS = "IntegraStore" as const;

/** The one store every request of an app uses: `env.STORE.idFromName(STORE_NAME)`. */
export const STORE_NAME = "app" as const;

/**
 * The secrets' names. The seller credential is the shared tenant's (`isk_…`), placed in each app as a secret, never in
 * a file of the app (design §12, step 4; call 4). A local run reads it from `.dev.vars`, which no zip or save carries.
 */
export const KIT_SECRETS = {
  sellerCredential: "SELLER_CREDENTIAL",
} as const;

/**
 * The plain settings, as `vars`. Each model is one setting until the bake-off (call 9): a model the Free plan serves.
 * `RPC_URL` is the Base Sepolia endpoint the app reads the chain through; the public one when absent.
 */
export const KIT_VARS = {
  sellerModel: "SELLER_MODEL",
  answerModel: "ANSWER_MODEL",
  rpcUrl: "RPC_URL",
} as const;

/**
 * The Studio's preview (design §13, row 5): the app runs under Vite, with Cloudflare's plug-in, in its project's
 * sandbox. There a Workers AI binding needs a Cloudflare API token, and without one Vite does not start. So the Studio
 * starts the app with `flag` set to `"1"`, and the app's `AI` is then a stand-in, used only while developing, that asks
 * the Studio at `http://<modelHost>/run`; the Studio runs the model with its own binding. No token enters the sandbox.
 * A deployed app has the real binding, and never reads either name.
 */
export const KIT_PREVIEW = {
  flag: "INTEGRA_PREVIEW",
  modelHost: "model.internal",
} as const;

/**
 * Where the app's build writes the files of `src/` that nothing uses, from the app's root, as `{ "unused": [paths] }`:
 * beside the build's two folders (`dist/client`, the Worker's), in neither, so it is never served or deployed. The
 * kit's build plug-in writes it (`integra/vite.ts`, `unusedFiles`, which says what counts as used); the Studio's check
 * reads it after the build.
 */
export const UNUSED_REPORT = "dist/.integra/unused.json" as const;

/**
 * Where the kit's dev server writes a line each time it finds a module made from business.json or src/goods/ that was
 * made from files since changed, and makes it again (`integra/vite.ts`, `fresh`): the reload race, caught. Under
 * node_modules/, so it is in no export, save or snapshot of the app. The Studio's check counts its lines.
 */
export const FRESH_LOG = "node_modules/.integra/fresh.log" as const;

/** The stand-in's one request, `POST http://<KIT_PREVIEW.modelHost>/run`: `KitAi.run`'s two arguments. */
export interface KitPreviewModelCall {
  model: string;
  inputs: Record<string, unknown>;
}

/** What the parts need of Workers AI: one call, by model name. */
export interface KitAi {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

/** What the parts need of the static assets: the shell, for a page's path. */
export interface KitAssets {
  fetch(request: Request): Promise<Response>;
}

/** The files of `src/goods/`, which the kit's build plug-in puts inside the Worker as bytes (design §2.2, rule 2). */
export interface KitGoods {
  /** The file's bytes, or null. `path` is its path in `src/goods/`, as `business.json` names it. */
  get(path: string): Uint8Array | null;
  /** Its media type, by its name. */
  mediaType(path: string): string;
}

/** Everything a part is handed for one request. */
export interface KitContext {
  /** `business.json`, validated when the app was built and again when it started. The server imports no code of `src/`. */
  business: Business;
  goods: KitGoods;
  /** The app's origin, as the request reached it: `https://<host>`. */
  origin: string;
  /** The app's host, which leads its `mintRequestId`s. */
  host: string;
  store: KitStore;
  ai: KitAi;
  assets: KitAssets;
  sellerCredential: string;
  settings: { sellerModel: string; answerModel: string; rpcUrl: string };
  waitUntil(promise: Promise<unknown>): void;
}

/** A part's route handler: the router calls it with the request, the route's parameters and the context. */
export type KitHandler = (request: Request, params: Record<string, string>, ctx: KitContext) => Promise<Response>;

// ---------------------------------------------------------------------------------------------------------------------
// The store (design §8.1): one Durable Object with SQLite. A change of state is one write.
// ---------------------------------------------------------------------------------------------------------------------

/** An event before the store numbers it: the store sets `seq` and `t`. */
export interface NewEvent {
  side: Side;
  source: Source;
  step: Step;
  text: string;
  data: JsonObject;
}

/** A checkout, as the store keeps it: one row, whose state changes by one write at a time (design §3.4). */
export interface CheckoutRow {
  id: CheckoutId;
  offer: OfferId;
  kind: DeliveryKind;
  payment: Payment;
  test: boolean;
  door: "http" | "mcp";
  state: CheckoutState;
  /** H: the hash of the agreement `issue` returned. */
  atrHash: AtrHash;
  /** The hash the challenge carried: H, or H′ at the test checkout (design §6). */
  advertised: AtrHash;
  link: string;
  mintRequestId: string;
  /** When the checkout stops being claimable: `issue`'s `expiresAt`, as Unix seconds. */
  expiresAt: number;
  option: V4Option;
  request: RequestCommitment;
  /** The challenge as sent, which a verify refusal sends again with its `error`. */
  challenge: PaymentRequired;
  with: BuyWith;
  price: { listed: Dollars; agreed?: Dollars };
  amount: string;
  negotiation?: NegotiationId;
  /** A booking's slot, taken at the claim: its start. */
  slot?: IsoTime;
  /** The payment as presented, kept from the claim on. */
  paymentPayload?: PaymentPayload;
  /** The authorization's `validBefore`: `settleBy` on the claim, and the deadline of a pending settlement. */
  settleBy?: number;
  transaction?: string;
  delivery?: Delivered;
  refusal?: Refusal;
  capture?: { state: "due" | "sent" | "collected" | "failed"; due: IsoTime; transaction?: string };
  /**
   * Pay later (design §3.9): what is owed, at the demonstration's scale too, and when, as the agreement says; and for a
   * booking, the slot the agreement names, which the claim takes. `amount` is the anchoring payment.
   */
  deferred?: { owed: Dollars; amount: string; due: IsoTime; rule: "booking" | "days"; slot?: IsoTime };
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

/** What one offer has left to sell: stock for an `order`, free slots for a `booking`; nothing is counted for the rest. */
export type Supply = { kind: "stock"; left: number } | { kind: "slots"; free: IsoTime[] } | { kind: "unlimited" };

/** Step 3 of a paid request (design §3.4): the checkout found under the hash, and what came of taking it forward. */
export type ClaimTake =
  | { ok: true; row: CheckoutRow }
  | { ok: false; why: "unknown" | "in-progress" | "expired" | "none-left" | "quote-used"; row: CheckoutRow | null };

/** A negotiation as the store keeps it (design §7). */
export interface NegotiationRow {
  id: NegotiationId;
  offer: OfferId;
  rounds: NegotiationSlot["rounds"];
  /** The price that stands, once accepted. */
  agreed?: Dollars;
  /** When an accepted price stops standing (Unix seconds). */
  expiresAt?: number;
  final: boolean;
  /** The checkout that used the quote. A quote pays once (design §7.4). */
  usedBy?: CheckoutId;
  /** The seller's own record of the model's reasons, never shown to the buyer (design §7.2). */
  reasons: string[];
}

/** A booking, a pass or an order, as delivery keeps it (design §5). */
export type DeliveryRecord =
  | { kind: "booking"; id: string; checkout: CheckoutId; offer: OfferId; start: IsoTime; end: IsoTime; reference: string }
  | { kind: "access"; pass: string; checkout: CheckoutId; offer: OfferId; until: IsoTime }
  | { kind: "order"; id: string; checkout: CheckoutId; offer: OfferId; number: string; to: BuyWith; state: "recorded" }
  | { kind: "answer"; id: string; checkout: CheckoutId; offer: OfferId; text: string };

/**
 * The store's methods, called by Durable Object RPC through `ctx.store`. The store's module owns the SQL; every other
 * part reads and writes the app's records only through these.
 */
export interface KitStore {
  // --- events (design §8.2, §8.4) ---
  /** Appends an event: the store numbers it `seq`, from 1 with no gaps, and stamps `t`. Open streams are told. */
  append(event: NewEvent): Promise<EventEnvelope>;
  /** Events after `seq`, in order: what `/api/events` sends. */
  eventsAfter(seq: number, limit?: number): Promise<EventEnvelope[]>;
  /** A purchase's events: those whose `data` carries this checkout, H or advertised hash. What the proof shows. */
  eventsOf(keys: { checkout?: CheckoutId; atrHash?: AtrHash; negotiation?: NegotiationId }): Promise<EventEnvelope[]>;

  // --- checkouts (design §3.3, §3.4) ---
  /** Keeps a new checkout, `open`, under the hash it advertises (step 5 of the unpaid request). */
  putCheckout(row: CheckoutRow): Promise<void>;
  /** A checkout by its id, or by a hash it was issued or advertised under. */
  checkout(by: { id: CheckoutId } | { hash: AtrHash }): Promise<CheckoutRow | null>;
  /**
   * Step 3 of the paid request, as one write: finds the checkout advertised under `hash`; if it is `open` and
   * unexpired, sets it `claiming`, takes one unit of stock or the slot (a booking's `slot`, else its next free one),
   * and marks its quote used. Otherwise says why, and changes nothing.
   */
  claimAndTake(hash: AtrHash, slot?: IsoTime): Promise<ClaimTake>;
  /**
   * Moves a checkout from one of `from` to `to`, with `patch`, as one write. Moving `claiming` or `settling` back to
   * `open` or to `refused` puts back what was taken, and frees the quote. Null when its state was not one of `from`.
   */
  transition(id: CheckoutId, from: CheckoutState[], to: CheckoutState, patch?: Partial<CheckoutRow>): Promise<CheckoutRow | null>;
  /** What an offer has left: step 2 of the unpaid request, which holds nothing (design §3.3). */
  supply(offer: Offer): Promise<Supply>;

  // --- the kept copies (design §8) ---
  /** The app's copy of the agreement's bytes, kept at issue: what `/proof/<H>/atr` answers. */
  keepAgreement(atrHash: AtrHash, bytes: Uint8Array): Promise<void>;
  agreement(atrHash: AtrHash): Promise<Uint8Array | null>;
  /** The app's copy of the appliance's record, with `proves` word for word, and when it was taken. */
  keepRecord(atrHash: AtrHash, view: RecordView): Promise<void>;
  record(atrHash: AtrHash): Promise<{ view: RecordView; takenAt: IsoTime } | null>;

  // --- negotiation (design §7) ---
  negotiation(id: NegotiationId): Promise<NegotiationRow | null>;
  putNegotiation(row: NegotiationRow): Promise<void>;

  // --- delivery's records (design §5) ---
  putDelivery(record: DeliveryRecord): Promise<void>;
  /** A booking or an order by its id, a pass by its token, an answer by its id. */
  delivery(kind: DeliveryRecord["kind"], key: string): Promise<DeliveryRecord | null>;

  // --- purchases (design §8.4) ---
  /** The list behind `<Purchases />`, newest first. */
  purchases(query: { offer?: OfferId; limit?: number }): Promise<PurchaseSummary[]>;
  /** One purchase by H or by the hash it advertised: what `get_purchase` and a pending answer give. */
  purchase(hash: AtrHash): Promise<Purchase | null>;

  // --- the alarm (design §3.4, §3.6) ---
  /**
   * Asks the store's alarm to come back to a checkout at `at` (Unix ms): to finish a `settling` checkout, to follow
   * `status` until the record is paid, or to capture a promise to pay. The alarm runs the checkout's own step for it.
   */
  wake(id: CheckoutId, at: number, why: "settle" | "status" | "capture"): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------------------
// The agent door → the checkout (design §3.1, §3.5)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * One request to the checkout, from either door. The MCP door makes it from a tool call: `request` is the HTTP request
 * the call stands for (`mcpBuyRequest`), whose body is the RFC 8785 form of `{quote, with}`, and whose commitment the
 * checkout takes (design §3.2).
 */
export interface CheckoutCall {
  door: "http" | "mcp";
  test: boolean;
  offer: OfferId;
  body: BuyRequest;
  /** The request as received, or as the tool call stands for it: its commitment is taken over these. */
  request: { method: "GET" | "POST"; path: string; query: string; body: Uint8Array };
  /** The challenge's `resource.url`: `<origin>/buy/<offer>` over HTTP, `mcp://tool/buy` over MCP. */
  resourceUrl: string;
  /** The payment presented: from `PAYMENT-SIGNATURE`, or from `params._meta["x402/payment"]`. Null when unpaid. */
  payment: PaymentPayload | null;
}

/** What the checkout answers, for each door to render in its own form (the module comment of `checkout.ts`). */
export type CheckoutOutcome =
  /** Unpaid: `402` / the MCP payment-required result. */
  | { kind: "challenge"; required: PaymentRequired }
  /** A payment `/verify` refused: `402` / the payment-required result, with `error` set to the reason. */
  | { kind: "payment-refused"; required: PaymentRequired }
  /** Settled: `200` / a result with `BuyPaid`, and the receipt. */
  | { kind: "paid"; answer: BuyPaid; receipt: SettleResponse }
  /** Sent, not yet confirmed: `202` / a result that is not an error, with the purchase, and the receipt. */
  | { kind: "pending"; purchase: Purchase; receipt: SettleResponse }
  /** Any other refusal: its status / an `isError` result. */
  | { kind: "refused"; status: number; refusal: Refusal };

/** The checkout's one entry: every purchase is priced, issued, claimed, settled and recorded by it. */
export type RunCheckout = (call: CheckoutCall, ctx: KitContext) => Promise<CheckoutOutcome>;

// ---------------------------------------------------------------------------------------------------------------------
// The checkout → delivery (design §4, §5)
// ---------------------------------------------------------------------------------------------------------------------

/** Delivery, as the checkout calls it. */
export interface KitDelivery {
  /**
   * Before `issue`: the agreement's `delivers` slot, and the demonstration slot's `delivery` words, for this offer and
   * checkout. For a file, its name, size and SHA-256; for every other kind, the address where the delivery will be read.
   */
  describe(offer: Offer, checkout: CheckoutId, ctx: KitContext): Promise<{ delivers: DeliversSlot; words: string }>;
  /**
   * After settlement, once (design §5, rule 2): delivers one settled purchase, records it with `putDelivery`, and
   * returns what the buyer's agent receives. The checkout keeps it, so a repeat is given the same.
   */
  deliver(offer: Offer, checkout: CheckoutRow, ctx: KitContext): Promise<Delivered>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Negotiation → the checkout (design §7.3)
// ---------------------------------------------------------------------------------------------------------------------

/** Negotiation, as the checkout and the agent door call it. */
export interface KitNegotiation {
  /** One round of the exchange; the HTTP route and the `negotiate` tool both call it. */
  negotiate(request: NegotiateRequest, ctx: KitContext): Promise<NegotiateAnswer | { status: number; refusal: Refusal }>;
  /**
   * An agreed price becomes a new unpaid request under a new id (design §7.3): the checkout asks for the quote named
   * in the buy request, for this offer, unexpired and unused, and is given the agreed price and the agreement's
   * `negotiation` slot. The quote is marked used when the paid request claims it (`claimAndTake`).
   */
  quote(offer: OfferId, quote: NegotiationId, ctx: KitContext): Promise<{ agreed: Dollars; slot: NegotiationSlot } | { refusal: Refusal }>;
}

// ---------------------------------------------------------------------------------------------------------------------
// The server's modules from the kit's build plug-in (`starter/integra/vite.ts`)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The virtual modules the kit's build plug-in serves to the server, and only to it (design §2.2, rule 2):
 * - `integra:server/business` default-exports `src/business.json` as a `Business`, checked with `checkBusiness` at
 *   build, `limits` included: the server's view;
 * - `integra:server/goods` default-exports every file of `src/goods/` as `Record<string, Uint8Array>`, keyed by its
 *   path there: inside the Worker, never among the static files.
 * The storefront's view is `integra:business` (`BUSINESS_MODULE`), with every `limits` taken out.
 */
export const SERVER_MODULES = {
  business: "integra:server/business",
  goods: "integra:server/goods",
} as const;
