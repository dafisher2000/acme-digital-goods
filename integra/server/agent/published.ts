// What the business publishes (design §9): `/.well-known/ucp`, `/.well-known/legal-context.json`, `/terms.md`,
// `/llms.txt` and `/robots.txt`. Each is written from `business.json` and the app's origin alone, so the same app
// always serves the same bytes; each is open to any origin.
import { emit } from "@integraledger/lcp/discovery";
import {
  CHECKOUT_LIFETIME_SECONDS,
  DEMONSTRATION_SENTENCE,
  MAX_NEGOTIATION_ROUNDS,
  NETWORK,
  NETWORK_NAME,
  QUOTE_HOLD_SECONDS,
  TEST_CHECKOUT_SENTENCE,
  UCP_VERSION,
  USDC,
  asksOf,
  buyPath,
  negotiatePath,
  testBuyPath,
  type KitContext,
  type UcpProfile,
} from "@demo-factory/interfaces";
import { CATALOG_CAPABILITIES } from "./catalog.ts";
import { utf8 } from "./canonical.ts";
import { TERMS_MEDIA_TYPE, TERMS_PATH, deliversWords, offerPriceWords, paymentWords, termsDocument } from "./terms.ts";

const LEGAL_CONTEXT_PATH = "/.well-known/legal-context.json";

/** Headers every published document carries: open to any origin, cached for five minutes. */
function headers(type: string, more: Record<string, string> = {}): Headers {
  return new Headers({
    "content-type": type,
    "cache-control": "public, max-age=300",
    "access-control-allow-origin": "*",
    ...more,
  });
}

function answer(request: Request, body: Uint8Array | string, h: Headers): Response {
  if (request.method === "OPTIONS") {
    h.set("access-control-allow-methods", "GET, HEAD, OPTIONS");
    return new Response(null, { status: 204, headers: h });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    h.set("allow", "GET, HEAD, OPTIONS");
    return new Response("Method not allowed.\n", { status: 405, headers: h });
  }
  const etag = h.get("etag");
  if (etag && request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: h });
  return new Response(request.method === "HEAD" ? null : body, { headers: h });
}

/** `/.well-known/ucp`: UCP's business profile. The catalogue's address over MCP is the app's `/mcp`. */
export function ucpProfile(ctx: KitContext): UcpProfile {
  return {
    ucp: {
      version: UCP_VERSION,
      services: {
        "dev.ucp.shopping": [
          {
            version: UCP_VERSION,
            spec: `https://ucp.dev/${UCP_VERSION}/specification/overview`,
            transport: "mcp",
            endpoint: `${ctx.origin}/mcp`,
            schema: `https://ucp.dev/${UCP_VERSION}/services/shopping/mcp.openrpc.json`,
          },
        ],
      },
      capabilities: CATALOG_CAPABILITIES,
      // UCP has no x402 handler, and one may be named only by the owner of its domain (design §9; R3 §5).
      payment_handlers: {},
    },
  };
}

/** `/.well-known/legal-context.json`, as lcp's `discovery.emit` writes it. Its `atrHash` is the terms' hash. */
export async function legalContext(ctx: KitContext): Promise<{ bytes: Uint8Array; termsHash: string }> {
  const terms = await termsDocument(ctx.business, ctx.origin);
  const bytes = emit({ terms: terms.url, termsFormat: "markdown", atrHash: terms.sha256 });
  if (!(bytes instanceof Uint8Array)) throw new Error(`legal-context.json: ${JSON.stringify(bytes)}`);
  return { bytes, termsHash: terms.sha256 };
}

/** `/llms.txt`: the doors, the tools and the test checkout, in prose (design §9). */
export function llmsTxt(ctx: KitContext): string {
  const o = ctx.origin;
  const b = ctx.business;
  const offers = b.offers.map((offer) => {
    const asks = asksOf(offer);
    return [
      `- [${offer.name}](${o}${buyPath(offer.id)}): ${offer.about} ${offerPriceWords(offer)}. ${paymentWords(offer)}`,
      `  Delivers: ${deliversWords(offer)}${asks.length ? ` Asks for: ${asks.join(", ")}.` : ""}${offer.limits ? " Open to negotiation." : ""}`,
      `  Offer id \`${offer.id}\`; test checkout ${o}${testBuyPath(offer.id)}.`,
    ].join("\n");
  });
  return [
    `# ${b.name}`,
    "",
    `> ${b.line} ${DEMONSTRATION_SENTENCE}`,
    "",
    `This shop sells to agents and to people. Every purchase is a real transaction on ${NETWORK_NAME} (\`${NETWORK}\`), a test network, paid in its test USDC (\`${USDC.address}\`): prices are real-life prices, and each cent is paid as one millionth of a USDC. Each purchase has its own agreement, whose SHA-256, H, the payment request carries and the payment is bound to.`,
    "",
    "## Offers",
    "",
    ...offers,
    "",
    "## Buy over MCP",
    "",
    `- Endpoint: ${o}/mcp, streamable HTTP, MCP revision 2026-07-28, stateless, with no sign-in. Clients of the 2025 revisions are served too.`,
    "- `search_catalog`, `lookup_catalog`, `get_product`: the catalogue, as UCP's Catalog capability. `meta[\"ucp-agent\"]` is not required.",
    "- `get_terms`: the terms of sale, and an offer's terms with their hash.",
    `- \`negotiate\`: for an offer open to negotiation, propose a price in dollars and cents. At most ${MAX_NEGOTIATION_ROUNDS} rounds; an accepted price stands for ${QUOTE_HOLD_SECONDS / 60} minutes, for one purchase, under the negotiation's id.`,
    "- `buy` `{offer, quote?, with?}`: x402 version 2 over MCP. The first call answers payment required: a result with `isError: true` and the `PaymentRequired` in `structuredContent`. Call `buy` again with the same arguments and the signed payment object in `params._meta[\"x402/payment\"]`. The result holds the delivery and the proof's address, and the receipt in `_meta[\"x402/payment-response\"]`. A payment sent but not yet confirmed is answered as pending, not as an error: ask `get_purchase`, or send the same payment again.",
    "- `test_buy`: the test checkout, below.",
    "- `get_purchase` `{atrHash}`: a purchase's state, its delivery and its proof's address.",
    "",
    "## Buy over HTTP",
    "",
    `- \`POST ${o}/buy/<offer>\` with JSON \`{"quote"?, "with"?}\`; \`GET\` for an offer that asks for nothing. Unpaid, it answers \`402\` with \`PAYMENT-REQUIRED\`: base64 of the \`PaymentRequired\`.`,
    "- Repeat the same request exactly, with `PAYMENT-SIGNATURE`: base64 of the payment. It answers `200` with `PAYMENT-RESPONSE`, or `202` while the payment is sent and not yet confirmed.",
    `- \`POST ${o}${negotiatePath("<offer>")}\` with \`{"amount", "text", "negotiation"?}\`: the same negotiation as the tool.`,
    "- A payment is presented at the door that asked for it.",
    "",
    "## Before you sign",
    "",
    "- The payment request's `extensions.legalContext.info` holds `value`, the agreement's hash H, and `legalContextUrl`, its link. Fetch the link, hash the exact bytes with SHA-256, and compare with H. Sign only if they match.",
    "- Paid now, and pay later's anchoring payment (x402 `exact`): the EIP-3009 authorization's nonce is H. Authorise now, collect later (x402 `auth-capture`): H is the escrow payment's salt.",
    ...(b.offers.some((offer) => offer.payment === "deferred")
      ? [
          "- Pay later: the amount the payment request asks is the anchor, 0.000001 USDC, not the price. What is owed, when it is due and how it is to be paid are in the agreement's `deferred` slot: read them there, and hold your budget against what is owed.",
        ]
      : []),
    `- An agreement can be paid once, within ${CHECKOUT_LIFETIME_SECONDS / 60} minutes of its issue.`,
    "",
    "## The test checkout",
    "",
    `\`${o}/test/buy/<offer>\` and the tool \`test_buy\`. ${TEST_CHECKOUT_SENTENCE}`,
    "",
    "## After",
    "",
    `- Each purchase has a proof page at \`${o}/proof/<H>\`, and its record at \`${o}/proof/<H>.json\`.`,
    "",
    "## Documents",
    "",
    `- [Terms of sale](${o}${TERMS_PATH}): each offer's terms, with the SHA-256 of their RFC 8785 form.`,
    `- [Legal context](${o}${LEGAL_CONTEXT_PATH}): where the terms are. Its \`atrHash\` is the terms' hash: the SHA-256 of ${TERMS_PATH}, not an agreement's.`,
    `- [UCP profile](${o}/.well-known/ucp): the catalogue's address over MCP.`,
    "",
  ].join("\n");
}

/** `/robots.txt`: pages open to crawlers; the paths that act (issue an agreement, negotiate, call a tool) are not. */
export function robotsTxt(ctx: KitContext): string {
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /buy/",
    "Disallow: /test/",
    "Disallow: /negotiate/",
    "Disallow: /mcp",
    "Disallow: /api/",
    "",
    `# Agents: ${ctx.origin}/llms.txt; MCP at ${ctx.origin}/mcp; ${ctx.origin}/.well-known/ucp;`,
    `# ${ctx.origin}/.well-known/legal-context.json; ${ctx.origin}${TERMS_PATH}.`,
    `# ${DEMONSTRATION_SENTENCE}`,
    "",
  ].join("\n");
}

/** Serves one published document by its name: after `/.well-known/`, or at the root. */
export async function servePublished(request: Request, name: string, ctx: KitContext): Promise<Response> {
  switch (name) {
    case "ucp":
      return answer(request, JSON.stringify(ucpProfile(ctx)), headers("application/json"));
    case "legal-context.json": {
      const doc = await legalContext(ctx);
      return answer(request, doc.bytes, headers("application/json", { link: `<${ctx.origin}${TERMS_PATH}>; rel="terms-of-service"` }));
    }
    case "terms.md": {
      const terms = await termsDocument(ctx.business, ctx.origin);
      return answer(
        request,
        terms.bytes,
        headers(TERMS_MEDIA_TYPE, {
          etag: `"${terms.sha256}"`,
          link: `<${ctx.origin}${LEGAL_CONTEXT_PATH}>; rel="describedby"`,
        }),
      );
    }
    case "llms.txt":
      return answer(request, utf8.encode(llmsTxt(ctx)), headers("text/plain; charset=utf-8"));
    case "robots.txt":
      return answer(request, utf8.encode(robotsTxt(ctx)), headers("text/plain; charset=utf-8"));
    default:
      return new Response("Not found.\n", { status: 404, headers: headers("text/plain; charset=utf-8") });
  }
}
