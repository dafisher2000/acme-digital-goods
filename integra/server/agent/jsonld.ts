// Product JSON-LD (design §9): schema.org's vocabulary, written by the shell from the business, so it does not depend on
// the model's pages. This module is the kit's pages' to import; it imports no server code, only the interfaces.
//
// How the kit calls it: once, in the page's head, from `business` (the storefront's view, `publicBusiness`, or
// business.json itself). The kit's build plug-in writes the head (`integra/vite.ts`, `transformIndexHtml`), before the
// app's address is known, so it calls it with no origin, and every address is relative to the page, which JSON-LD
// resolves against the page's own address:
//
//   `<script type="application/ld+json">${productJsonLdText(pub)}</script>`
//
// A page that knows its origin (the shell, at run time) may pass it: `productJsonLdText(business, location.origin)`.
// `productJsonLdText` escapes `<`, so the text cannot close its own script element.
import {
  ANCHOR_SENTENCE,
  DEMONSTRATION_SENTENCE,
  NETWORK_NAME,
  amountToUsdc,
  buyPath,
  dollarsToAmount,
  type PublicBusiness,
} from "@demo-factory/interfaces";

/** What the JSON-LD reads of the business: the storefront's view, or `business.json` itself. */
export type JsonLdBusiness = Pick<PublicBusiness, "name" | "line" | "contact"> & {
  offers: readonly Pick<PublicBusiness["offers"][number], "id" | "name" | "about" | "price" | "payment">[];
};

/** How an offer is paid, in the words its schema.org `Offer` carries. */
const HOW_PAID: Record<JsonLdBusiness["offers"][number]["payment"], string> = {
  now: "Paid when bought",
  authorise: "Authorised into escrow when bought, and collected later",
  deferred: "Pay later: the price is owed, and due as the agreement says",
};

/** The shop as a schema.org `OnlineStore`, and each offer as a `Product` with one `Offer`, in one `@graph`. */
export function productJsonLd(business: JsonLdBusiness, origin = ""): Record<string, unknown> {
  const store = `${origin}/#store`;
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "OnlineStore",
        "@id": store,
        name: business.name,
        description: business.line,
        url: `${origin}/`,
        email: business.contact,
      },
      ...business.offers.map((offer) => ({
        "@type": "Product",
        "@id": `${origin}/#product-${offer.id}`,
        productID: offer.id,
        sku: offer.id,
        name: offer.name,
        description: offer.about,
        brand: { "@id": store },
        offers: {
          "@type": "Offer",
          url: `${origin}${buyPath(offer.id)}`,
          price: offer.price,
          priceCurrency: "USD",
          seller: { "@id": store },
          description: `${DEMONSTRATION_SENTENCE} ${HOW_PAID[offer.payment]}, as ${amountToUsdc(dollarsToAmount(offer.price))} test USDC on ${NETWORK_NAME}.${
            offer.payment === "deferred" ? ` ${ANCHOR_SENTENCE}` : ""
          }`,
        },
      })),
    ],
  };
}

/** The same, as the text of a `<script type="application/ld+json">` element. */
export function productJsonLdText(business: JsonLdBusiness, origin = ""): string {
  return JSON.stringify(productJsonLd(business, origin)).replaceAll("<", "\\u003c");
}
