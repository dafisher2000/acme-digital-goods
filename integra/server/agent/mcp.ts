// MCP at `/mcp` (design §9): the catalogue, `get_terms`, `negotiate`, `buy`, `test_buy` and `get_purchase`, served
// stateless over streamable HTTP by the MCP SDK's own handler, one server per request.
//
// `buy` and `test_buy` are x402 version 2 over MCP, to the published specification (`transports-v2/mcp.md`; design
// §3.5). A call stands for `POST /buy/<offer>` (or `/test/buy/<offer>`) whose body is the RFC 8785 form of
// `{quote, with}`; the door hands that request, and the payment from `params._meta["x402/payment"]`, to the one
// checkout (`runCheckout`, design §3.1), and renders what it answers as a tool result:
//
// | the checkout answers | the tool result |
// |---|---|
// | challenge, payment-refused | `isError: true`; the `PaymentRequired` as `structuredContent` and as JSON in `content[0].text` |
// | paid | `BuyPaid` as `structuredContent`; the facilitator's settle answer in `_meta["x402/payment-response"]` |
// | pending | not an error; the `Purchase` as `structuredContent`; the receipt, with `settlement_pending` and the transaction |
// | refused | `isError: true`; the `Refusal` as `structuredContent` and as JSON in `content[0].text` |
//
// Every result carries `resultType: "complete"`. The paid tools declare no `outputSchema` (design §3.5).
import { McpServer, type CallToolResult, type ServerContext, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import {
  BuyToolArgs,
  DEMONSTRATION_SENTENCE,
  GetPurchaseArgs,
  GetTermsArgs,
  KIT_MCP_TOOLS,
  MAX_NEGOTIATION_ROUNDS,
  MCP_BUY_RESOURCE_URL,
  MCP_TEST_BUY_RESOURCE_URL,
  NETWORK,
  NETWORK_NAME,
  NegotiateRequest,
  PaymentPayload,
  QUOTE_HOLD_SECONDS,
  TEST_CHECKOUT_SENTENCE,
  X402_MCP_META,
  decodeX402Header,
  mcpBuyRequest,
  proofPath,
  type CheckoutCall,
  type CheckoutOutcome,
  type Json,
  type KitContext,
  type KitMcpTool,
  type PaymentRequired,
  type Refusal,
} from "@demo-factory/interfaces";
import { runCheckout } from "../checkout/index.ts";
import { negotiation } from "../negotiation/index.ts";
import { GetProductArgs, LookupArgs, SearchArgs, getProduct, lookup, search } from "./catalog.ts";
import { canonicalJson, utf8 } from "./canonical.ts";
import { offerTermsHash, termsDocument } from "./terms.ts";

type Result = CallToolResult & { resultType: "complete" };

// ---------------------------------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------------------------------

/** A result whose `structuredContent` is `value`, and `content[0].text` the same as JSON; then any words for a person. */
function result(value: object, opts: { isError?: boolean; words?: string; meta?: Record<string, unknown> } = {}): Result {
  const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(value) }];
  if (opts.words) content.push({ type: "text", text: opts.words });
  return {
    content,
    structuredContent: value as Record<string, unknown>,
    ...(opts.isError ? { isError: true } : {}),
    ...(opts.meta ? { _meta: opts.meta } : {}),
    resultType: "complete",
  };
}

const refused = (refusal: Refusal, words?: string) => result(refusal, { isError: true, ...(words ? { words } : {}) });

/** What a person reads beside a challenge: the price, the network, the agreement's hash and link, how to pay. */
function challengeWords(required: PaymentRequired): string {
  const option = required.accepts[0]!;
  const lc = (required.extensions?.legalContext?.info ?? {}) as { value?: string; legalContextUrl?: string };
  return [
    required.error ? `${required.error}` : "Payment required.",
    `Pay ${option.amount} of the token ${option.asset}'s smallest units (scheme ${option.scheme}) on ${NETWORK_NAME} (${option.network}), to ${option.payTo}.`,
    lc.value ? `The agreement's hash is ${lc.value}; its bytes are at ${lc.legalContextUrl}. Hash them and compare before you sign.` : "",
    "To pay, call this tool again with the same arguments and the x402 payment in params._meta[\"x402/payment\"].",
    // The resource's description: the demonstration sentence, and, for pay later, what this payment is and what is owed.
    required.resource?.description ?? DEMONSTRATION_SENTENCE,
  ]
    .filter(Boolean)
    .join(" ");
}

/** The checkout's answer as a tool result, over MCP (design §3.5). */
function rendered(outcome: CheckoutOutcome, ctx: KitContext): Result {
  switch (outcome.kind) {
    case "challenge":
    case "payment-refused":
      return result(outcome.required, { isError: true, words: challengeWords(outcome.required) });
    case "paid": {
      const a = outcome.answer;
      return result(a, {
        meta: { [X402_MCP_META.paymentResponse]: outcome.receipt },
        words: `${a.headline}. Transaction ${a.transaction} on ${NETWORK_NAME}. The proof is at ${a.proof}. ${DEMONSTRATION_SENTENCE}`,
      });
    }
    case "pending": {
      const p = outcome.purchase;
      return result(p, {
        meta: { [X402_MCP_META.paymentResponse]: outcome.receipt },
        words:
          `The payment was sent, and is not yet confirmed: transaction ${outcome.receipt.transaction}. Ask get_purchase ` +
          `with atrHash ${p.atrHash}, or send the same payment again; do not sign a new one. The proof will be at ` +
          `${ctx.origin}${proofPath(p.atrHash)}. ${DEMONSTRATION_SENTENCE}`,
      });
    }
    case "refused":
      return refused(outcome.refusal);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// x402 over MCP: the call becomes the checkout's request
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The payment in `params._meta["x402/payment"]`: the `PaymentPayload` object, as the specification sends it. A client
 * that sends it as base64 of the JSON, as Cloudflare's `agents/x402` does (R3 §3), is read too.
 */
function paymentOf(meta: Record<string, unknown> | undefined): { payment: PaymentPayload | null } | { refusal: Refusal } {
  const raw = meta?.[X402_MCP_META.payment];
  if (raw === undefined || raw === null) return { payment: null };
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = decodeX402Header(raw);
    } catch {
      value = undefined;
    }
  }
  const parsed = PaymentPayload.safeParse(value);
  if (!parsed.success) {
    return {
      refusal: {
        code: "checkout/payment-malformed",
        sentence: 'The payment in params._meta["x402/payment"] is not an x402 version 2 payment.',
      },
    };
  }
  return { payment: parsed.data };
}

async function checkoutTool(tool: "buy" | "test_buy", args: BuyToolArgs, sctx: ServerContext, ctx: KitContext): Promise<Result> {
  const paid = paymentOf(sctx.mcpReq._meta as Record<string, unknown> | undefined);
  if ("refusal" in paid) return refused(paid.refusal);
  const request = mcpBuyRequest(tool, args);
  const call: CheckoutCall = {
    door: "mcp",
    test: tool === "test_buy",
    offer: args.offer,
    body: request.body,
    request: { method: request.method, path: request.path, query: request.query, body: utf8.encode(canonicalJson(request.body as Json)) },
    resourceUrl: tool === "buy" ? MCP_BUY_RESOURCE_URL : MCP_TEST_BUY_RESOURCE_URL,
    payment: paid.payment,
  };
  return rendered(await runCheckout(call, ctx), ctx);
}

// ---------------------------------------------------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------------------------------------------------

/** Each tool's description: the kit's (KIT_MCP_TOOLS) where it serves an agent as it stands, and how to use it. */
function descriptions(ctx: KitContext): Record<KitMcpTool, string> {
  return {
    search_catalog: `${KIT_MCP_TOOLS.search_catalog} Every word of catalog.query must match; with none, every offer. Each product's metadata says how it is paid, what it delivers, its terms' hash, and how to buy it.`,
    lookup_catalog: `${KIT_MCP_TOOLS.lookup_catalog} Give catalog.ids: offer ids, or variant ids ("<offer>:default").`,
    get_product: `${KIT_MCP_TOOLS.get_product} Give catalog.id: an offer's id. A booking lists its free slots in metadata.slots.`,
    get_terms: `${KIT_MCP_TOOLS.get_terms} Without an offer: /terms.md, its address and its SHA-256. With one: that offer's terms word for word, their RFC 8785 form and its SHA-256, which /terms.md names.`,
    negotiate:
      `Negotiate an offer's price with the seller's agent, for an offer whose price is open to negotiation. Propose an amount in dollars and cents, as "7.50", with your words; ` +
      `to continue, name the negotiation you were given. At most ${MAX_NEGOTIATION_ROUNDS} rounds. An accepted price stands for ${QUOTE_HOLD_SECONDS / 60} minutes, ` +
      "for one purchase: name the negotiation as `quote` when you call buy. The same exchange is served at POST /negotiate/<offer>.",
    buy:
      `${KIT_MCP_TOOLS.buy} x402 version 2 over MCP: the first call answers payment required (isError, with the PaymentRequired in structuredContent), ` +
      "which carries the agreement's hash and link in extensions.legalContext. Fetch the link, hash the bytes with SHA-256, and compare before you sign. " +
      'Then call buy again with the same arguments and the payment object in params._meta["x402/payment"]; the result carries the delivery, the proof\'s ' +
      'address, and the receipt in _meta["x402/payment-response"]. `with` holds what the offer asks for (see the catalogue), and is written into the ' +
      `agreement, which is public. Paid in test USDC on ${NETWORK_NAME} (${NETWORK}): one cent of the price is one millionth of a USDC. ` +
      "An offer paid later (its catalogue metadata says payment.when \"deferred\") asks only 0.000001 USDC, which anchors the agreement on chain and is not part of the price: " +
      "the agreement's deferred slot says what is owed, when it is due and how it is to be paid.",
    test_buy:
      `${TEST_CHECKOUT_SENTENCE} The same arguments and the same x402 over MCP as buy. ${DEMONSTRATION_SENTENCE}`,
    get_purchase: `${KIT_MCP_TOOLS.get_purchase} The proof page is at ${ctx.origin}/proof/<atrHash>.`,
  };
}

/** What the server tells every agent, once, when it connects. */
function instructions(ctx: KitContext): string {
  return [
    `${ctx.business.name}: ${ctx.business.line}`,
    DEMONSTRATION_SENTENCE,
    "Find an offer with search_catalog or get_product, read its terms with get_terms, and buy it with buy: x402 version 2 over MCP, paid in " +
      `test USDC on ${NETWORK_NAME} (${NETWORK}). Each purchase has its own agreement, whose hash the payment request carries and the payment is bound to; ` +
      "check it before you sign. Where an offer's price is open to negotiation, negotiate first, then buy naming the agreed quote. test_buy is a " +
      "checkout for testing your agent, which sells nothing. The same is described in prose at /llms.txt.",
  ].join("\n\n");
}

/**
 * A tool's schema, with its JSON Schema written once per isolate. The SDK asks for a tool's JSON Schema each time the
 * tool is registered and each time the tools are listed, and the handler makes a new server for every request, so
 * without this every request would convert every tool's schema again: most of a request's processor time (design §13,
 * row 8). Validation is the schema's own.
 */
function once<S extends StandardSchemaWithJSON>(schema: S): StandardSchemaWithJSON<StandardSchemaWithJSON.InferInput<S>, StandardSchemaWithJSON.InferOutput<S>> {
  const std = schema["~standard"];
  const written: Partial<Record<"input" | "output", Record<string, unknown>>> = {};
  const json = (io: "input" | "output") => (options: Parameters<S["~standard"]["jsonSchema"]["input"]>[0]) =>
    (written[io] ??= std.jsonSchema[io](options) as Record<string, unknown>);
  return {
    "~standard": {
      version: 1,
      vendor: std.vendor,
      validate: (value: unknown) => std.validate(value),
      jsonSchema: { input: json("input"), output: json("output") },
    },
  } as unknown as StandardSchemaWithJSON<StandardSchemaWithJSON.InferInput<S>, StandardSchemaWithJSON.InferOutput<S>>;
}

const SCHEMAS = {
  search: once(SearchArgs),
  lookup: once(LookupArgs),
  product: once(GetProductArgs),
  terms: once(GetTermsArgs),
  negotiate: once(NegotiateRequest),
  buy: once(BuyToolArgs),
  purchase: once(GetPurchaseArgs),
};

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/** The server for one request (the handler asks for a new one each time). */
export function mcpServer(ctx: KitContext): McpServer {
  const server = new McpServer(
    { name: ctx.host, title: ctx.business.name, version: "1.0.0" },
    { capabilities: { tools: {} }, instructions: instructions(ctx) },
  );
  const d = descriptions(ctx);

  server.registerTool("search_catalog", { title: "Search the catalogue", description: d.search_catalog, inputSchema: SCHEMAS.search, annotations: READ_ONLY }, async (args) =>
    result(await search(args, ctx)),
  );
  server.registerTool("lookup_catalog", { title: "Look up products", description: d.lookup_catalog, inputSchema: SCHEMAS.lookup, annotations: READ_ONLY }, async (args) =>
    result(await lookup(args, ctx)),
  );
  server.registerTool("get_product", { title: "Get a product", description: d.get_product, inputSchema: SCHEMAS.product, annotations: READ_ONLY }, async (args) =>
    result(await getProduct(args, ctx)),
  );

  server.registerTool("get_terms", { title: "Read the terms", description: d.get_terms, inputSchema: SCHEMAS.terms, annotations: READ_ONLY }, async (args) => {
    const doc = await termsDocument(ctx.business, ctx.origin);
    if (args.offer === undefined) {
      return result({ url: doc.url, format: "markdown", sha256: doc.sha256, text: doc.text });
    }
    const offer = ctx.business.offers.find((o) => o.id === args.offer);
    if (!offer) return refused({ code: "terms/offer-unknown", sentence: "No offer has this id." });
    const hash = await offerTermsHash(offer);
    return result({
      offer: offer.id,
      terms: offer.terms,
      canonical: hash.canonical,
      sha256: hash.sha256,
      document: { url: doc.url, sha256: doc.sha256 },
    });
  });

  server.registerTool(
    "negotiate",
    {
      title: "Negotiate a price",
      description: d.negotiate,
      inputSchema: SCHEMAS.negotiate,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const answer = await negotiation.negotiate(args, ctx);
      return "refusal" in answer ? refused(answer.refusal) : result(answer, { words: answer.text });
    },
  );

  server.registerTool(
    "buy",
    {
      title: "Buy an offer",
      description: d.buy,
      inputSchema: SCHEMAS.buy,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args, sctx) => checkoutTool("buy", args, sctx, ctx),
  );
  server.registerTool(
    "test_buy",
    {
      title: "Test your agent",
      description: d.test_buy,
      inputSchema: SCHEMAS.buy,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args, sctx) => checkoutTool("test_buy", args, sctx, ctx),
  );

  server.registerTool(
    "get_purchase",
    { title: "Get a purchase", description: d.get_purchase, inputSchema: SCHEMAS.purchase, annotations: { ...READ_ONLY, idempotentHint: false } },
    async (args) => {
      const purchase = await ctx.store.purchase(args.atrHash);
      return purchase ? result(purchase) : refused({ code: "purchase/unknown", sentence: "No purchase of this app has this hash." });
    },
  );
  return server;
}
