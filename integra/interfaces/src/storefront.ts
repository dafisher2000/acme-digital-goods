/**
 * What the storefront may use (design §2.3): three named pieces, and no more.
 *
 * | piece | what it is |
 * |---|---|
 * | `business`, from `integra:business` | the business's name and words, and its offers, with every `limits` taken out and `negotiable` in its place |
 * | `<Buy offer="house-roast" />` | the offer's buy control: "Watch an agent buy", "Connect your agent", and, where the offer allows it, "Watch two agents negotiate". It opens the live purchase, which is the kit's. |
 * | `<Purchases />` | the latest purchases, each with a link to its proof |
 *
 * The kit's build plug-in makes `integra:business` from `business.json` (design §2.2, rule 3). Its type is declared for
 * the storefront by `@demo-factory/interfaces/integra-business`.
 */
import { z } from "zod";
import { Business, Offer, OfferAuthorise, OfferDeferred, OfferId, OfferPaidNow } from "./business.ts";

const negotiable = z
  .boolean()
  .meta({ description: "Whether the price is open to negotiation: true exactly when the offer has limits." });

/** An offer as the storefront sees it: every member but `limits`, and `negotiable`. */
export const PublicOffer = z.discriminatedUnion("payment", [
  OfferPaidNow.omit({ limits: true }).extend({ negotiable }),
  OfferAuthorise.omit({ limits: true }).extend({ negotiable }),
  OfferDeferred.omit({ limits: true }).extend({ negotiable }),
]);
export type PublicOffer = z.infer<typeof PublicOffer>;

/** `business`, from `integra:business`. */
export const PublicBusiness = Business.extend({ offers: z.array(PublicOffer).min(1).max(20) }).meta({
  title: "integra:business",
  description: "The business as the storefront gets it: business.json with every limits taken out.",
});
export type PublicBusiness = z.infer<typeof PublicBusiness>;

/** The offer without its limits. Nothing of `limits` reaches the result. */
export function publicOffer(offer: Offer): PublicOffer {
  const { limits, ...rest } = offer;
  return { ...rest, negotiable: limits !== undefined };
}

/** `integra:business`, made from `business.json`. */
export function publicBusiness(business: Business): PublicBusiness {
  return { ...business, offers: business.offers.map(publicOffer) };
}

/** The name of the virtual module the kit's build plug-in serves. */
export const BUSINESS_MODULE = "integra:business" as const;

/** `<Buy offer="…" />`'s props. */
export interface BuyProps {
  /** The offer's id, as in `business.json`. */
  offer: OfferId;
}

/** `<Purchases />`'s props. Both are optional: with none, the latest purchases of every offer. */
export interface PurchasesProps {
  /** Only this offer's purchases. */
  offer?: OfferId;
  /** At most this many. */
  limit?: number;
}

/**
 * The attributes the Studio's deterministic checks read on a rendered page (design §2.5):
 * - every offer has a `<Buy>` on some page, which renders `data-integra-offer="<id>"`;
 * - every fact the kit draws carries `data-from` (the side that said it, an event's `side`) and `data-seq` (the event's
 *   `seq`).
 */
export const PAGE_ATTRIBUTES = {
  offer: "data-integra-offer",
  from: "data-from",
  seq: "data-seq",
} as const;
