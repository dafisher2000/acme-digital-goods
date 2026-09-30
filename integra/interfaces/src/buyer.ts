/**
 * Integra's buyer service (design §10), at `buyer.demos.integraledger.net`: two doors.
 *
 * **The first door: an agent you instruct** (§10.1). Any origin may call it, with no cookie. A run's id is long and
 * random, and is all that is needed to read it. One bound: the service's largest budget for one run (call 5).
 *
 * | call | what it does |
 * |---|---|
 * | `POST /runs` | starts a run: `RunRequest` → `201 RunCreated` |
 * | `GET /runs/<id>` | the run's record: its events, its result, and the judge's verdict |
 * | `GET /runs/<id>/events` | the run's events, live, as server-sent events (`sseFrame`) |
 * | `GET /records/<hash>` | the record of the run whose challenge advertised that hash |
 * | `GET /` | a page of its own: a demo's address, a goal, and the run as it happens |
 *
 * **The second door: tools for your own agent** (§10.6), MCP at `/mcp`. Two sets of tools, and the shared wallet signs
 * in one of them only (call 6, ruled):
 * - for an agent with a wallet of its own: `atr_confirm`, `atr_finish`, `atr_check`, `terms-mcp`'s, with its names and
 *   schemas (R2 §4);
 * - for any agent, a chat agent among them: `start_checkout`, `check_agreement`, `pay`. The shared wallet signs only
 *   inside `pay`, which also sends. Each checkout made this way is a run, with its record and its events.
 */
import { z } from "zod";
import { Agreement, BuyWith, NegotiationId } from "./agreement.ts";
import { AtrHash, IsoTime, JsonObject, Refusal, Sha256Hex, TransactionHash, Uint256String, WebUrl } from "./common.ts";
import { OfferId, PAYMENTS } from "./business.ts";
import { Delivered } from "./checkout.ts";
import { DEMONSTRATION_SENTENCE } from "./demonstration.ts";
import { EventEnvelope } from "./events.ts";
import { Dollars } from "./price.ts";
import { SERVICE_ORIGINS } from "./services.ts";

export const BUYER_URL = SERVICE_ORIGINS.buyer;

export const BUYER_ROUTES = {
  runs: { method: "POST", path: "/runs" },
  run: { method: "GET", path: "/runs/:id" },
  runEvents: { method: "GET", path: "/runs/:id/events" },
  record: { method: "GET", path: "/records/:hash" },
  page: { method: "GET", path: "/" },
  mcp: { method: "POST", path: "/mcp" },
  ucpProfile: { method: "GET", path: "/.well-known/ucp" },
} as const;

/**
 * `GET /.well-known/ucp` on the buyer service: its own UCP platform profile, which it names in the `UCP-Agent` header
 * and in `meta["ucp-agent"]` when it reads a demo's catalogue, as UCP requires of a buyer (§10.3; R3 §5).
 */
export const BUYER_UCP_PROFILE_URL = `${SERVICE_ORIGINS.buyer}/.well-known/ucp` as const;

/** A run's id: long and random. */
export const RunId = z.string().regex(/^run_[A-Za-z0-9_-]{22,64}$/);
export type RunId = z.infer<typeof RunId>;

/**
 * The scenarios a run can prove (the plan's phase 1; design §6, §7, §3.6, §3.9). `promise-to-pay` is the escrow's
 * authorise now, collect later (an offer paid `"authorise"`); `pay-later` is pay later (an offer paid `"deferred"`).
 */
export const Scenario = z.enum(["buy-now", "test-checkout", "negotiate", "promise-to-pay", "pay-later"]);
export type Scenario = z.infer<typeof Scenario>;

// ---------------------------------------------------------------------------------------------------------------------
// The first door
// ---------------------------------------------------------------------------------------------------------------------

/**
 * `POST /runs`'s body. `seller` is any demo's address on the web. `goal` is in words, as *"a pound of coffee, under
 * $20"*. `budget` bounds the listed price, in dollars; the service converts it at the scale of §3.8 before it signs,
 * and it must be within the service's largest for one run. `door` is how the run buys: `http` when absent. `test`
 * runs against the offer's test checkout.
 */
export const RunRequest = z.strictObject({
  seller: WebUrl,
  goal: z.string().min(1).max(500),
  budget: Dollars,
  offer: OfferId.optional(),
  door: z.enum(["http", "mcp"]).optional(),
  test: z.boolean().optional(),
});
export type RunRequest = z.infer<typeof RunRequest>;

/** `201`: the run's id, and the addresses of its events and its record. */
export const RunCreated = z.strictObject({
  run: RunId,
  events: WebUrl.meta({ description: "/runs/<id>/events" }),
  record: WebUrl.meta({ description: "/runs/<id>" }),
});
export type RunCreated = z.infer<typeof RunCreated>;

/**
 * How a run ended. `signed-nothing` is the test checkout's: the hash did not match, and no signature was made.
 * `anchored` is pay later's: the anchoring payment settled, and the price is owed (design §3.9).
 */
export const RunOutcome = z.enum(["paid", "authorised", "anchored", "pending", "signed-nothing", "declined", "refused", "failed"]);
export type RunOutcome = z.infer<typeof RunOutcome>;

/** A run's result. `signerCalls` is the service's own count of its signatures; 0 is a measured zero (R4 Q1). */
export const RunResult = z.strictObject({
  outcome: RunOutcome,
  scenario: Scenario,
  advertised: AtrHash.optional(),
  computed: AtrHash.optional().meta({ description: "The hash of the agreement's bytes as the buyer fetched them." }),
  signerCalls: z.int().min(0),
  amount: Uint256String.optional(),
  owed: z
    .strictObject({ price: Dollars, due: IsoTime })
    .optional()
    .meta({ description: "Pay later: what the agreement says is owed, and when; amount is the anchoring payment." }),
  transaction: TransactionHash.optional(),
  delivery: z
    .strictObject({ kind: z.string(), size: z.int().min(0), sha256: Sha256Hex })
    .optional()
    .meta({ description: "What was received, hashed by the buyer." }),
  proof: WebUrl.optional(),
  refusal: Refusal.optional(),
});
export type RunResult = z.infer<typeof RunResult>;

/** The judge's verdict: does this run prove its scenario? */
export const Verdict = z.strictObject({
  scenario: Scenario,
  proves: z.boolean(),
  reasons: z.array(z.string()).min(1),
});
export type Verdict = z.infer<typeof Verdict>;

/** Where the buyer's record says the hash was compared (design §8.3). */
export const COMPARED_IN = "Integra's hosted buyer service" as const;

/** `GET /runs/<id>`, and `GET /records/<hash>`: a run's record. */
export const RunRecord = z.strictObject({
  run: RunId,
  seller: WebUrl,
  goal: z.string(),
  budget: Dollars,
  offer: OfferId.optional(),
  door: z.enum(["http", "mcp"]),
  test: z.boolean(),
  state: z.enum(["running", "finished"]),
  comparedIn: z.literal(COMPARED_IN),
  startedAt: IsoTime,
  finishedAt: IsoTime.optional(),
  events: z.array(EventEnvelope),
  result: RunResult.optional(),
  verdict: Verdict.optional(),
});
export type RunRecord = z.infer<typeof RunRecord>;

/** `GET /records/<hash>` when no run's challenge advertised it: `404`, with this sentence (design §8.3). */
export const NO_RECORD_SENTENCE = "Integra's buyer service has no record of this purchase." as const;

// ---------------------------------------------------------------------------------------------------------------------
// The second door: MCP at /mcp
// ---------------------------------------------------------------------------------------------------------------------

/** A pairing id, as lcp's `BINDINGS` names them (R1 §1). */
const PairingId = z.string().regex(/^[a-z0-9-]+(\/[A-Za-z0-9._:-]+)+$/).max(128);

/**
 * `terms-mcp`'s three tools, which the buyer service offers with the package's names and schemas (R2 §4). Their
 * schemas here follow the package's: `pairing` is one of lcp's pairings, `atr` is base64 of the agreement's bytes.
 */
export const AtrConfirmArgs = z.strictObject({
  pairing: PairingId,
  document: z.unknown(),
  account: z.string().min(1),
  inputs: JsonObject.optional(),
  receipt: z.unknown().optional(),
});
export const AtrFinishArgs = z.strictObject({
  pairing: PairingId,
  atr: z.base64(),
  chosen: JsonObject,
  signature: z.unknown(),
});
export const AtrCheckArgs = z.strictObject({
  pairing: PairingId,
  atr: z.base64(),
  presented: z.unknown(),
});

/** `start_checkout`: makes the unpaid request to the demo, as a run. The budget is the run's, as at the first door. */
export const StartCheckoutArgs = z.strictObject({
  seller: WebUrl,
  offer: OfferId,
  budget: Dollars,
  quote: NegotiationId.optional(),
  with: BuyWith.optional(),
});
export type StartCheckoutArgs = z.infer<typeof StartCheckoutArgs>;

/** What `start_checkout` returns: the checkout (a run), and what the challenge asks. */
export const StartCheckoutResult = z.strictObject({
  checkout: RunId,
  advertised: AtrHash,
  link: WebUrl,
  amount: Uint256String,
  price: Dollars.meta({ description: "The price: the amount, as the listed price's form; for pay later, what is owed." }),
  payment: z.enum(PAYMENTS),
  owed: z
    .strictObject({ price: Dollars, due: IsoTime, words: z.string() })
    .optional()
    .meta({ description: "Pay later: what the agreement says is owed, and when. The amount paid now only anchors the agreement." }),
  expiresAt: IsoTime.optional(),
  events: WebUrl,
  record: WebUrl,
});
export type StartCheckoutResult = z.infer<typeof StartCheckoutResult>;

/** `check_agreement` and `pay` take the checkout. */
export const CheckoutRef = z.strictObject({ checkout: RunId });
export type CheckoutRef = z.infer<typeof CheckoutRef>;

/** What `check_agreement` returns: the comparison, and the agreement to read. */
export const CheckAgreementResult = z.strictObject({
  checkout: RunId,
  advertised: AtrHash,
  computed: AtrHash,
  equal: z.boolean(),
  agreement: Agreement.optional().meta({ description: "The agreement, parsed, when its bytes hash to the advertised hash." }),
});
export type CheckAgreementResult = z.infer<typeof CheckAgreementResult>;

/** What `pay` returns: it checks the agreement again, signs, sends, and gives back the delivery and the proof. */
export const PayResult = z.strictObject({
  checkout: RunId,
  state: z.enum(["paid", "authorised", "anchored", "pending"]),
  atrHash: AtrHash,
  transaction: TransactionHash.optional(),
  delivery: Delivered.optional(),
  proof: WebUrl.optional(),
});
export type PayResult = z.infer<typeof PayResult>;

/** The second door's tools, and their descriptions. Every tool that buys carries the demonstration sentence. */
export const BUYER_MCP_TOOLS = {
  atr_confirm: "terms-mcp's: fetch the agreement a payment request advertises, hash it, compare, and build the request to sign.",
  atr_finish: "terms-mcp's: join a signature to the payment, and confirm it carries the agreement's hash.",
  atr_check: "terms-mcp's: confirm a held payment carries the hash of an agreement.",
  start_checkout: `Start a checkout at a demo's offer, within a budget in dollars. For an offer paid later, the budget bounds what is owed, and the payment made now is 0.000001 USDC, which anchors the agreement on chain. ${DEMONSTRATION_SENTENCE}`,
  check_agreement: "Fetch the checkout's agreement, compare its hash with the one advertised, and return it to read.",
  pay: `Check the agreement again, sign with Integra's shared test wallet, send, and return the delivery and the proof. For an offer paid later, it pays only the 0.000001 USDC anchor, and the agreement says what is owed and when. ${DEMONSTRATION_SENTENCE}`,
} as const;
export type BuyerMcpTool = keyof typeof BUYER_MCP_TOOLS;
