// The kit's server: one router that hands each path of design §2.4 to its part's module, with one KitContext per
// request. A path it does not answer goes to the static assets, whose single-page fallback serves the shell: the
// kit's pages (/proof/<H>, /agents) and the storefront's own.
import type { KitHandler } from "@demo-factory/interfaces";
import * as agent from "./agent/index.ts";
import * as checkout from "./checkout/index.ts";
import * as delivery from "./delivery/index.ts";
import { kitContext, type Env } from "./env.ts";
import * as negotiation from "./negotiation/index.ts";
import * as proof from "./proof/index.ts";

const HASH = "(0x[0-9a-f]{64})";
const OFFER = "([a-z0-9]+(?:-[a-z0-9]+)*)";
const ID = "([A-Za-z0-9_-]+)";

/** Each route: its pattern, its part's handler, and the names of its captured parameters. */
const ROUTES: [RegExp, KitHandler, string[]][] = [
  [new RegExp(`^/buy/${OFFER}$`), checkout.buy, ["offer"]],
  [new RegExp(`^/test/buy/${OFFER}$`), checkout.testBuy, ["offer"]],
  [new RegExp(`^/negotiate/${OFFER}$`), negotiation.route, ["offer"]],
  [/^\/mcp$/, agent.mcp, []],
  [/^\/\.well-known\/(.+)$/, agent.published, ["document"]],
  [/^\/(terms\.md|llms\.txt|robots\.txt)$/, agent.published, ["document"]],
  [new RegExp(`^/orders/${ID}$`), delivery.orders, ["id"]],
  [new RegExp(`^/bookings/${ID}$`), delivery.bookings, ["id"]],
  [new RegExp(`^/members/${OFFER}/(.*)$`), delivery.members, ["offer", "file"]],
  [new RegExp(`^/proof/${HASH}\\.json$`), proof.json, ["hash"]],
  [new RegExp(`^/proof/${HASH}/atr$`), proof.atr, ["hash"]],
  [/^\/api\/events$/, proof.events, []],
  [/^\/api\/purchases$/, proof.purchases, []],
  [/^\/api\/health$/, proof.health, []],
];

export async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const kit = kitContext(request, env, ctx);
  const path = new URL(request.url).pathname;
  for (const [pattern, handler, names] of ROUTES) {
    const m = pattern.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    names.forEach((name, i) => (params[name] = decodeURIComponent(m[i + 1] ?? "")));
    return handler(request, params, kit);
  }
  return kit.assets.fetch(request);
}
