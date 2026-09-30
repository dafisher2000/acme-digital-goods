// The catalogue, as UCP's Catalog capability over MCP (UCP 2026-08-25; design §9, "as in v3"): `search_catalog`,
// `lookup_catalog` and `get_product`, read-only. One product per offer, with one variant.
//
// Where UCP is silent for a demonstration, the door chooses (each is said in the report):
// - the price is the offer's real-life price, in USD minor units, as the storefront shows it; what it is paid as, on
//   which network and in which asset, is in `metadata.pays`, with the demonstration sentence;
// - a product's id is the offer's id, and its one variant's id is `<offer>:default`;
// - `metadata` says how to buy it (the MCP tool and the HTTP address), its terms' address and hash, and, for a
//   booking, the free slots, which the buyer may name as `with.slot`;
// - `meta["ucp-agent"]` is read if given and never required: a chat agent has none (design §9).
import { z } from "zod";
import {
  ANCHOR_AMOUNT,
  ANCHOR_USDC,
  DEFAULT_COLLECT_AFTER_MINUTES,
  DEMONSTRATION_SENTENCE,
  NETWORK,
  UCP_VERSION,
  USDC,
  amountToUsdc,
  asksOf,
  buyPath,
  dollarsToAmount,
  testBuyPath,
  type KitContext,
  type Offer,
  type Supply,
} from "@demo-factory/interfaces";
import { offerTermsHash, paymentWords, priceCents, TERMS_PATH } from "./terms.ts";

export const CATALOG_SEARCH = "dev.ucp.shopping.catalog.search";
export const CATALOG_LOOKUP = "dev.ucp.shopping.catalog.lookup";

/** UCP's catalogue capabilities, as the business profile declares them. */
export const CATALOG_CAPABILITIES = {
  [CATALOG_SEARCH]: [
    {
      version: UCP_VERSION,
      spec: `https://ucp.dev/${UCP_VERSION}/specification/shopping/catalog/search`,
      schema: `https://ucp.dev/${UCP_VERSION}/schemas/shopping/catalog_search.json`,
    },
  ],
  [CATALOG_LOOKUP]: [
    {
      version: UCP_VERSION,
      spec: `https://ucp.dev/${UCP_VERSION}/specification/shopping/catalog/lookup`,
      schema: `https://ucp.dev/${UCP_VERSION}/schemas/shopping/catalog_lookup.json`,
    },
  ],
};

// ---------------------------------------------------------------------------------------------------------------------
// The tools' arguments: UCP's own (the Catalog MCP binding), read loosely, as UCP extends by adding members
// ---------------------------------------------------------------------------------------------------------------------

const Meta = z
  .looseObject({
    "ucp-agent": z.looseObject({ profile: z.string() }).optional(),
    "idempotency-key": z.string().optional(),
  })
  .optional()
  .meta({ description: "UCP's request metadata. `ucp-agent` is read if given; this business does not require it." });

const PriceFilter = z.looseObject({ min: z.int().min(0).optional(), max: z.int().min(0).optional() });
const Filters = z
  .looseObject({ categories: z.array(z.string()).optional(), price: PriceFilter.optional() })
  .optional()
  .meta({ description: "UCP's search filters: categories (any of), and price in USD cents (min, max)." });

export const SearchArgs = z.object({
  meta: Meta,
  catalog: z
    .looseObject({
      query: z.string().optional().meta({ description: "Free text. Every word must match the offer's name, words or kind." }),
      context: z.looseObject({}).optional(),
      signals: z.looseObject({}).optional(),
      attribution: z.looseObject({}).optional(),
      filters: Filters,
      pagination: z.looseObject({ cursor: z.string().optional(), limit: z.int().min(1).optional() }).optional(),
    })
    .default({}),
});
export type SearchArgs = z.infer<typeof SearchArgs>;

export const LookupArgs = z.object({
  meta: Meta,
  catalog: z.looseObject({
    ids: z.array(z.string()).min(1).max(50).meta({ description: "Product ids (an offer's id) or variant ids." }),
    filters: Filters,
    context: z.looseObject({}).optional(),
    signals: z.looseObject({}).optional(),
    attribution: z.looseObject({}).optional(),
  }),
});
export type LookupArgs = z.infer<typeof LookupArgs>;

export const GetProductArgs = z.object({
  meta: Meta,
  catalog: z.looseObject({
    id: z.string().meta({ description: "A product id (an offer's id) or its variant's id." }),
    selected: z.array(z.looseObject({})).optional(),
    preferences: z.array(z.string()).optional(),
    filters: Filters,
    context: z.looseObject({}).optional(),
    signals: z.looseObject({}).optional(),
    attribution: z.looseObject({}).optional(),
  }),
});
export type GetProductArgs = z.infer<typeof GetProductArgs>;

// ---------------------------------------------------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------------------------------------------------

const CATEGORY: Record<Offer["delivers"]["kind"], string> = {
  file: "Downloads",
  booking: "Bookings",
  access: "Memberships",
  answer: "Answers",
  order: "Goods",
};

export const variantId = (offer: Offer) => `${offer.id}:default`;

function availability(supply: Supply): { available: boolean; status: string } {
  if (supply.kind === "stock") return supply.left > 0 ? { available: true, status: "in_stock" } : { available: false, status: "out_of_stock" };
  if (supply.kind === "slots") return supply.free.length > 0 ? { available: true, status: "in_stock" } : { available: false, status: "out_of_stock" };
  return { available: true, status: "in_stock" };
}

const PAYMENT_TAGS: Record<Offer["payment"], string> = { now: "paid-now", authorise: "authorise-now-collect-later", deferred: "pay-later" };

/**
 * How the offer is paid, for an agent: `when` is the offer's `payment`, with its x402 scheme. Pay later (design §3.9)
 * says what is owed and when it is due, and that `pays` is only the anchoring payment.
 */
function paymentMeta(offer: Offer): Record<string, unknown> {
  if (offer.payment === "now") return { when: "now", scheme: "exact" };
  if (offer.payment === "authorise") {
    return { when: "authorise", scheme: "auth-capture", words: paymentWords(offer), collectAfterMinutes: offer.collectAfterMinutes ?? DEFAULT_COLLECT_AFTER_MINUTES };
  }
  const owed = dollarsToAmount(offer.price);
  return {
    when: "deferred",
    scheme: "exact",
    owed: { price: offer.price, amount: owed, usdc: amountToUsdc(owed) },
    due: offer.due,
    anchor: { amount: ANCHOR_AMOUNT, usdc: ANCHOR_USDC, partOfPrice: false },
    words: paymentWords(offer),
  };
}

/** One offer as a UCP product, with what an agent needs to buy it. */
export async function productOf(offer: Offer, ctx: KitContext, supply: Supply): Promise<Record<string, unknown>> {
  const cents = priceCents(offer);
  const price = { amount: cents, currency: "USD" };
  const amount = offer.payment === "deferred" ? ANCHOR_AMOUNT : dollarsToAmount(offer.price);
  const terms = await offerTermsHash(offer);
  const kind = offer.delivers.kind;
  const metadata: Record<string, unknown> = {
    demonstration: DEMONSTRATION_SENTENCE,
    pays: { amount, usdc: amountToUsdc(amount), asset: USDC.address, network: NETWORK },
    payment: paymentMeta(offer),
    delivers: kind,
    asks: [...asksOf(offer)],
    negotiable: offer.limits !== undefined,
    terms: { offer: offer.terms, sha256: terms.sha256, document: ctx.origin + TERMS_PATH },
    buy: {
      mcp: { endpoint: `${ctx.origin}/mcp`, tool: "buy", arguments: { offer: offer.id } },
      http: ctx.origin + buyPath(offer.id),
    },
    test: {
      mcp: { endpoint: `${ctx.origin}/mcp`, tool: "test_buy", arguments: { offer: offer.id } },
      http: ctx.origin + testBuyPath(offer.id),
    },
  };
  if (supply.kind === "stock") metadata.stock = supply.left;
  if (supply.kind === "slots") metadata.slots = supply.free;
  return {
    id: offer.id,
    handle: offer.id,
    title: offer.name,
    description: { plain: offer.about },
    categories: [{ value: CATEGORY[kind], taxonomy: "merchant" }],
    price_range: { min: price, max: price },
    variants: [
      {
        id: variantId(offer),
        title: offer.name,
        description: { plain: offer.about },
        price,
        availability: availability(supply),
        seller: { name: ctx.business.name, links: [{ type: "terms_of_service", url: ctx.origin + TERMS_PATH }] },
      },
    ],
    tags: [kind, PAYMENT_TAGS[offer.payment], ...(offer.limits ? ["negotiable"] : [])],
    metadata,
  };
}

function ucpMeta(capability: string, status?: "error") {
  return { version: UCP_VERSION, ...(status ? { status } : {}), capabilities: { [capability]: [{ version: UCP_VERSION }] } };
}

function passes(offer: Offer, filters: SearchArgs["catalog"]["filters"]): boolean {
  if (!filters) return true;
  const cents = priceCents(offer);
  if (filters.price?.min !== undefined && cents < filters.price.min) return false;
  if (filters.price?.max !== undefined && cents > filters.price.max) return false;
  if (filters.categories && filters.categories.length > 0 && !filters.categories.includes(CATEGORY[offer.delivers.kind])) return false;
  return true;
}

function matches(offer: Offer, query: string | undefined): boolean {
  const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [offer.id, offer.name, offer.about, offer.delivers.kind, CATEGORY[offer.delivers.kind], ...Object.values(offer.terms)]
    .join(" ")
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

async function productsOf(offers: Offer[], ctx: KitContext) {
  const supplies = await Promise.all(offers.map((o) => ctx.store.supply(o)));
  return Promise.all(offers.map((o, i) => productOf(o, ctx, supplies[i]!)));
}

/** `search_catalog`: every word of the query must match; pages of 10 by default, 50 at most. */
export async function search(args: SearchArgs, ctx: KitContext) {
  const found = ctx.business.offers.filter((o) => matches(o, args.catalog.query) && passes(o, args.catalog.filters));
  const limit = Math.min(args.catalog.pagination?.limit ?? 10, 50);
  const start = Number.parseInt(args.catalog.pagination?.cursor ?? "0", 10) || 0;
  const page = found.slice(start, start + limit);
  const next = start + limit < found.length;
  return {
    ucp: ucpMeta(CATALOG_SEARCH),
    products: await productsOf(page, ctx),
    pagination: { has_next_page: next, ...(next ? { cursor: String(start + limit) } : {}), total_count: found.length },
  };
}

function resolve(id: string, ctx: KitContext): { offer: Offer; match: "exact" | "featured" } | null {
  for (const offer of ctx.business.offers) {
    if (offer.id === id) return { offer, match: "featured" };
    if (variantId(offer) === id) return { offer, match: "exact" };
  }
  return null;
}

/** `lookup_catalog`: the products the ids name, each variant with the request ids that resolved to it. */
export async function lookup(args: LookupArgs, ctx: KitContext) {
  const hits = new Map<string, { offer: Offer; inputs: { id: string; match: string }[] }>();
  const missing: string[] = [];
  for (const id of args.catalog.ids) {
    const r = resolve(id, ctx);
    if (!r || !passes(r.offer, args.catalog.filters)) {
      missing.push(id);
      continue;
    }
    const hit = hits.get(r.offer.id) ?? { offer: r.offer, inputs: [] };
    hit.inputs.push({ id, match: r.match });
    hits.set(r.offer.id, hit);
  }
  const list = [...hits.values()];
  const products = await productsOf(
    list.map((h) => h.offer),
    ctx,
  );
  products.forEach((p, i) => {
    const variants = p.variants as Record<string, unknown>[];
    variants[0]!.inputs = list[i]!.inputs;
  });
  return {
    ucp: ucpMeta(CATALOG_LOOKUP),
    products,
    ...(missing.length > 0 ? { messages: missing.map((id) => ({ type: "info", code: "not_found", content: id })) } : {}),
  };
}

/** `get_product`: one product, or UCP's not-found outcome. */
export async function getProduct(args: GetProductArgs, ctx: KitContext) {
  const r = resolve(args.catalog.id, ctx);
  if (!r) {
    return {
      ucp: ucpMeta(CATALOG_LOOKUP, "error"),
      messages: [{ type: "error", code: "not_found", content: `Product not found: ${args.catalog.id}`, severity: "unrecoverable" }],
    };
  }
  return { ucp: ucpMeta(CATALOG_LOOKUP), product: await productOf(r.offer, ctx, await ctx.store.supply(r.offer)) };
}
