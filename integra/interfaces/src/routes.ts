/**
 * What the kit owns (design §2.4): every path the app's server answers, and the shapes it answers with that are not
 * the checkout's (`checkout.ts`) or negotiation's (`negotiation.ts`).
 *
 * | path | for | what |
 * |---|---|---|
 * | `/buy/<offer>` | agents | the checkout (§3) |
 * | `/test/buy/<offer>` | agents | the test checkout (§6) |
 * | `/negotiate/<offer>` | agents | negotiation (§7) |
 * | `/mcp` | agents | the same three, and the catalogue, as tools (§9) |
 * | `/.well-known/ucp`, `/.well-known/legal-context.json`, `/terms.md`, `/llms.txt`, `/robots.txt` | agents | what the business publishes (§9) |
 * | `/orders/<id>`, `/bookings/<id>`, `/members/…` | agents and people | what was delivered (§5) |
 * | `/proof/<H>`, `/proof/<H>.json`, `/proof/<H>/atr` | people, agents | the proof of one purchase, and the app's copy of its agreement (§8) |
 * | `/agents` | people | "Connect your agent": the addresses, and one line per agent host (R3 §4) |
 * | `/watch/<run>` | people, the Studio | one run of Integra's buyer followed live, as "Watch an agent buy" draws it (§8.4, §10.2) |
 * | `/api/events`, `/api/purchases` | the pages | the app's own record, live (§8) |
 *
 * `/agents`, `/proof/<H>` and `/watch/<run>` are pages: the shell draws them. The server hands a page's path to the static assets,
 * whose single-page fallback serves the shell.
 */
import { z } from "zod";
import { AtrHash, HttpsUrl, IsoTime, WebUrl } from "./common.ts";
import { OfferId } from "./business.ts";
import { Purchase, TEST_CHECKOUT_SENTENCE } from "./checkout.ts";
import { DEMONSTRATION_SENTENCE } from "./demonstration.ts";
import { EventEnvelope } from "./events.ts";
import { NETWORK } from "./network.ts";

/** Each route, as a pattern: `:name` is one path segment, `*` the rest. */
export const KIT_ROUTES = {
  buy: "/buy/:offer",
  testBuy: "/test/buy/:offer",
  negotiate: "/negotiate/:offer",
  mcp: "/mcp",
  ucp: "/.well-known/ucp",
  legalContext: "/.well-known/legal-context.json",
  terms: "/terms.md",
  llms: "/llms.txt",
  robots: "/robots.txt",
  order: "/orders/:id",
  booking: "/bookings/:id",
  members: "/members/:offer/*",
  proof: "/proof/:hash",
  proofJson: "/proof/:hash.json",
  proofAtr: "/proof/:hash/atr",
  agents: "/agents",
  watch: "/watch/:run",
  events: "/api/events",
  purchases: "/api/purchases",
  health: "/api/health",
} as const;
export type KitRoute = keyof typeof KIT_ROUTES;

/** The routes that are pages the shell draws; the server hands them to the static assets. */
export const KIT_PAGES = ["proof", "agents", "watch"] as const satisfies readonly KitRoute[];

/**
 * `assets.run_worker_first` in the app's `wrangler.jsonc`: every path the server answers, so that a person who opens
 * `/terms.md` is not served `index.html` (design §2.4; R6 B1). `/proof/*` is here for `.json` and `/atr`; the server
 * hands `/proof/<H>` itself to the assets.
 */
export const RUN_WORKER_FIRST = [
  "/buy/*",
  "/test/*",
  "/negotiate/*",
  "/mcp",
  "/.well-known/*",
  "/terms.md",
  "/llms.txt",
  "/robots.txt",
  "/orders/*",
  "/bookings/*",
  "/members/*",
  "/proof/*",
  "/api/*",
] as const;

export const orderPath = (id: string) => `/orders/${id}`;
export const bookingPath = (id: string) => `/bookings/${id}`;
export const membersPath = (offer: string, file = "") => `/members/${offer}/${file}`;
export const proofPath = (h: string) => `/proof/${h}`;
export const proofJsonPath = (h: string) => `/proof/${h}.json`;
export const proofAtrPath = (h: string) => `/proof/${h}/atr`;
export const negotiatePath = (offer: string) => `/negotiate/${offer}`;
/**
 * A run followed live on the app's own page (design §8.4, §10.2): the live purchase that "Watch an agent buy" draws, for
 * a run the page did not start. "Run the scenarios" opens it in a browser, to check that every fact the kit draws
 * carries `data-from` and `data-seq` (§2.5, changed 2026-09-30); a person may open it too.
 */
export const watchPath = (run: string) => `/watch/${run}`;

// ---------------------------------------------------------------------------------------------------------------------
// The app's own record (design §8.1, §8.4)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * `GET /api/events?after=<seq>`: the app's stream, as server-sent events (`sseFrame`), from the event after `seq`, or
 * after `Last-Event-ID`. It stays open only while a purchase runs (design §8.4).
 */
export const EventsQuery = z.strictObject({ after: z.coerce.number().int().min(0).optional() });

/**
 * A purchase in the list: the purchase without its delivery, which can be a whole file, and with `seq`, the number of
 * the seller's latest event for it, so a `<Purchases />` row can carry `data-seq` (design §2.5).
 */
export const PurchaseSummary = Purchase.omit({ delivery: true }).extend({
  seq: z.int().min(0).meta({ description: "The number of the seller's latest event for this purchase; 0 when it has none." }),
});
export type PurchaseSummary = z.infer<typeof PurchaseSummary>;

/** `GET /api/purchases?offer=<id>&limit=<n>`: the list behind `<Purchases />`, newest first. */
export const PurchasesQuery = z.strictObject({
  offer: OfferId.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export const PurchasesAnswer = z.strictObject({ purchases: z.array(PurchaseSummary) });
export type PurchasesAnswer = z.infer<typeof PurchasesAnswer>;

/** `GET /api/health`: whether `business.json` passes its schema, and why not (the plan's phase 2, "the check"). */
export const HealthAnswer = z.strictObject({
  ok: z.boolean(),
  business: z.strictObject({
    valid: z.boolean(),
    problems: z.array(z.strictObject({ path: z.string(), message: z.string() })),
  }),
});
export type HealthAnswer = z.infer<typeof HealthAnswer>;

// ---------------------------------------------------------------------------------------------------------------------
// The proof (design §8.3)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The appliance's record, `RecordView`, as the seller door's `status` and `report` answer it (R1 §6). The app keeps a
 * copy, because the appliance deletes a paid record about an hour after it expires.
 */
export const RecordView = z.looseObject({
  atrHash: AtrHash,
  state: z.enum(["issued", "settling", "paid", "closed", "stale"]),
  expiresAt: IsoTime,
  settlement: z
    .looseObject({ pairing: z.string(), network: z.string().optional(), reference: z.string().optional() })
    .nullable(),
  proves: z.looseObject({
    claimed: z.boolean(),
    pattern: z.looseObject({}).nullable(),
    settledBy: z.enum(["read", "facilitator", "seller-report"]).nullable(),
  }),
  agreement: z.looseObject({}).nullable(),
  channel: z.looseObject({}).nullable(),
});
export type RecordView = z.infer<typeof RecordView>;

/**
 * `GET /proof/<H>.json`: what the proof page draws, from the app's side. The browser also hashes the app's copy of
 * the agreement (`/proof/<H>/atr`), reads the chain itself, and asks the buyer service for its record (`buyerRecord`).
 */
export const ProofDocument = z.strictObject({
  atrHash: AtrHash,
  advertised: AtrHash,
  purchase: Purchase,
  record: z
    .strictObject({ view: RecordView, takenAt: IsoTime })
    .nullable()
    .meta({ description: "The app's copy of the appliance's record, with proves word for word, and when it was taken." }),
  events: z.array(EventEnvelope).meta({ description: "The seller's events for this purchase, in seq order." }),
  buyerRecord: HttpsUrl.meta({ description: "The buyer service's record under the advertised hash: /records/<hash>." }),
  network: z.literal(NETWORK),
  demonstration: z.literal(DEMONSTRATION_SENTENCE),
});
export type ProofDocument = z.infer<typeof ProofDocument>;

/** `GET /proof/<H>/atr`: the app's copy of the agreement's exact bytes, with the agreement store's GET headers. */
export const PROOF_ATR_CONTENT_TYPE = "application/json; charset=utf-8" as const;

// ---------------------------------------------------------------------------------------------------------------------
// What the business publishes (design §9)
// ---------------------------------------------------------------------------------------------------------------------

/** UCP's published version the profile follows (R3 §5). */
export const UCP_VERSION = "2026-08-25" as const;

/**
 * `GET /.well-known/ucp`: UCP's business profile. `services` names the catalogue's address over MCP, the app's own
 * `/mcp`; `payment_handlers` is present and empty, because UCP has no x402 handler (design §9; R3 §5).
 */
export const UcpProfile = z.looseObject({
  ucp: z.looseObject({
    version: z.literal(UCP_VERSION),
    services: z.record(
      z.string(),
      z.array(
        z.looseObject({
          version: z.string(),
          spec: HttpsUrl,
          transport: z.enum(["rest", "mcp", "a2a", "embedded"]),
          endpoint: WebUrl,
          schema: HttpsUrl.optional(),
        }),
      ),
    ),
    capabilities: z.record(z.string(), z.array(z.looseObject({ version: z.string() }))).optional(),
    payment_handlers: z.strictObject({}),
  }),
});
export type UcpProfile = z.infer<typeof UcpProfile>;

/**
 * `GET /.well-known/legal-context.json`: LCP's discovery document, as lcp's `discovery.emit` writes it (R2 §5). Its
 * `atrHash` is the SHA-256 of the whole of `/terms.md`: the terms' hash, never an agreement's (design §9).
 */
export const LegalContextDocument = z.looseObject({
  terms: HttpsUrl,
  termsFormat: z.string().optional(),
  atrHash: AtrHash.optional(),
  acceptanceRequired: z.boolean().optional(),
  disputeResolution: z.looseObject({}).optional(),
  returns: z.string().optional(),
  contact: z.looseObject({ legal: z.string().optional(), technical: z.string().optional() }).optional(),
  api: z.string().optional(),
});
export type LegalContextDocument = z.infer<typeof LegalContextDocument>;

/**
 * The kit's MCP tools at `/mcp` (design §9). The catalogue tools are UCP's Catalog MCP binding (UCP 2026-08-25), with
 * UCP's own arguments; `meta["ucp-agent"]` is not required of a chat agent.
 */
export const KIT_MCP_TOOLS = {
  search_catalog: "UCP's catalogue search, read-only.",
  lookup_catalog: "UCP's catalogue lookup by ids, read-only.",
  get_product: "UCP's product by id, read-only.",
  get_terms: "The business's terms, and an offer's terms with their hash.",
  negotiate: "Negotiate an offer's price (design §7).",
  buy: `Buy an offer, paid by x402. Its answer carries the address of the proof. ${DEMONSTRATION_SENTENCE}`,
  test_buy: TEST_CHECKOUT_SENTENCE,
  get_purchase: "A purchase's state, its delivery and the address of its proof, by the agreement's hash.",
} as const;
export type KitMcpTool = keyof typeof KIT_MCP_TOOLS;

/** `get_terms`' arguments: with an offer, that offer's terms and their hash; without, the business's. */
export const GetTermsArgs = z.strictObject({ offer: OfferId.optional() });
export type GetTermsArgs = z.infer<typeof GetTermsArgs>;
