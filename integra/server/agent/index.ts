// The agent door (design §3.5, §9): MCP at /mcp, with x402 over MCP, and what the business publishes.
//
// The MCP handler is the MCP SDK's own `createMcpHandler` (`@modelcontextprotocol/server`), which serves the 2026-07-28
// revision stateless and 2025-era clients through its stateless fallback. It is validation-free by design, so it
// answers on any host: `workers.dev`, a hosted demo's own name, or a deployer's domain (design §13, row 7). The door
// puts the one check MCP asks of every server in front of it, the `Origin` header's, and opens itself to any origin:
// the endpoint holds no credential and sets no cookie, so a page on another origin can do nothing through a visitor's
// browser that it could not do by asking itself; and a browser-based agent must be able to reach it.
import { AsyncLocalStorage } from "node:async_hooks";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { KitContext, KitHandler } from "@demo-factory/interfaces";
import { mcpServer } from "./mcp.ts";
import { servePublished } from "./published.ts";

export { productJsonLd, productJsonLdText } from "./jsonld.ts";
export { termsDocument, offerTermsHash } from "./terms.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
  "access-control-allow-headers":
    "Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID",
  "access-control-expose-headers": "Mcp-Session-Id, MCP-Protocol-Version",
  "access-control-max-age": "86400",
} as const;

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** MCP's `Origin` rule: a present `Origin` must be an origin. A missing one is a client that is not a browser. */
function originRefused(request: Request): Response | null {
  const origin = request.headers.get("origin");
  if (origin === null || origin === "") return null;
  try {
    const url = new URL(origin);
    if ((url.protocol === "https:" || url.protocol === "http:") && url.origin === origin) return null;
  } catch {
    // falls through
  }
  return Response.json({ jsonrpc: "2.0", error: { code: -32600, message: "The Origin header is not an origin." }, id: null }, { status: 403 });
}

/**
 * The request's context, for the server the handler asks for. The handler is made once per isolate, and asks its
 * factory for a new server on every request, of either era; the context travels with the request's own async work.
 */
const requestContext = new AsyncLocalStorage<KitContext>();

const handler = createMcpHandler(() => {
  const ctx = requestContext.getStore();
  if (!ctx) throw new Error("the agent door: an MCP request with no context");
  return mcpServer(ctx);
});

/** `/mcp`: the catalogue, `get_terms`, `negotiate`, `buy`, `test_buy` and `get_purchase` (KIT_MCP_TOOLS). */
export const mcp: KitHandler = async (request, _params, ctx) => {
  const refusedOrigin = originRefused(request);
  if (refusedOrigin) return withCors(refusedOrigin);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  return withCors(await requestContext.run(ctx, () => handler.fetch(request)));
};

const WELL_KNOWN = new Set(["ucp", "legal-context.json"]);
const AT_ROOT = new Set(["terms.md", "llms.txt", "robots.txt"]);

/**
 * `/.well-known/<document>`, `/terms.md`, `/llms.txt` and `/robots.txt`. `params.document` is the name after the
 * root or after `/.well-known/`; an unknown one is a 404.
 */
export const published: KitHandler = async (request, params, ctx) => {
  const name = params.document ?? "";
  const wellKnown = new URL(request.url).pathname.startsWith("/.well-known/");
  const known = wellKnown ? WELL_KNOWN.has(name) : AT_ROOT.has(name);
  return servePublished(request, known ? name : "", ctx);
};
