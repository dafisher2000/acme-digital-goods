/**
 * `business.json` (design §2.6): the business as data, the contract between the model and the kit. The model writes it
 * at `src/business.json`; the kit's build checks it, and so does the kit's server when it starts (design §2.2, rule 2).
 * The Studio gives the model this schema as JSON Schema text (`schemas/business.schema.json`).
 *
 * The five kinds of offer are design §5's. Prices are real-life dollars and cents, paid at the scale of §3.8.
 *
 * Rules that span fields are in `businessProblems`, beside the schema, because JSON Schema cannot say them: offer ids
 * are unique, the lowest price is below the price, and each list names a thing once. `checkBusiness` runs both.
 */
import { z } from "zod";
import { Dollars, dollarsToCents } from "./price.ts";
import { check, type Checked, type Problem } from "./validate.ts";

/** An offer's id: lowercase words joined by hyphens. It is in the offer's paths: `/buy/<id>`. */
export const OfferId = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(48)
  .meta({ description: 'The offer\'s id: lowercase letters and digits in words joined by "-", as "house-roast".' });
export type OfferId = z.infer<typeof OfferId>;

/** One thing the buyer gives when it buys: a key of the buy request's `with`, whose value is a string. */
export const Ask = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}$/)
  .meta({ description: 'One thing the buyer gives when it buys, as a lowercase name: "name", "address", "question".' });
export type Ask = z.infer<typeof Ask>;

const Asks = z
  .array(Ask)
  .max(8)
  .meta({
    description:
      "What the buyer gives when it buys, each once. What the buyer gives is written into the agreement, which is public.",
  });

/** A file in `src/goods/`, by its path there: `guide.pdf`, `patterns/cardigan.pdf`. */
export const GoodsFile = z
  .string()
  .regex(/^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .max(200)
  .meta({
    description:
      'A file in src/goods/, by its path there, as "guide.pdf". The kit puts it inside the server, never among the public files.',
  });
export type GoodsFile = z.infer<typeof GoodsFile>;

export const Weekday = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export type Weekday = z.infer<typeof Weekday>;

// ---------------------------------------------------------------------------------------------------------------------
// What an offer delivers: the five kinds (design §5)
// ---------------------------------------------------------------------------------------------------------------------

/** `file`: the file's own bytes, in the answer to the paid request. The agreement names its hash before payment. */
export const DeliversFile = z
  .strictObject({
    kind: z.literal("file"),
    file: GoodsFile,
    asks: Asks.optional(),
  })
  .meta({ description: "A file, delivered in the answer to the paid request." });

/**
 * `booking`: a confirmed slot, its reference, its time, and an `.ics` file. The slots are the `times` on the `days`,
 * in `timezone`, from today to `ahead` days on. One booking takes one slot, and a second buyer is refused it. The
 * buyer may name a slot in `with.slot`, as its start time in ISO 8601 as the catalogue lists it; without one, the next
 * free slot is booked.
 */
export const DeliversBooking = z
  .strictObject({
    kind: z.literal("booking"),
    minutes: z.int().min(5).max(1440).meta({ description: "How long one booking lasts, in minutes." }),
    timezone: z
      .string()
      .regex(/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)*$/)
      .max(64)
      .meta({ description: 'The IANA time zone of the times, as "Europe/London".' }),
    days: z.array(Weekday).min(1).max(7).meta({ description: "The days of the week slots are offered on." }),
    times: z
      .array(z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/))
      .min(1)
      .max(48)
      .meta({ description: 'The start times of the slots on each of those days, as "09:00", in the time zone.' }),
    ahead: z.int().min(1).max(90).meta({ description: "How many days ahead slots are offered." }),
    asks: Asks.optional(),
  })
  .meta({ description: "A booked slot of time: one booking to a slot." });

/**
 * `access`: a pass, good for `hours` after the purchase. `/members/<offer>/<file>` answers each file in `opens` with
 * the pass, and `401` without it.
 */
export const DeliversAccess = z
  .strictObject({
    kind: z.literal("access"),
    hours: z.int().min(1).max(8784).meta({ description: "How long a pass is good for, in hours." }),
    opens: z.array(GoodsFile).min(1).max(32).meta({ description: "The files in src/goods/ the pass opens." }),
    asks: Asks.optional(),
  })
  .meta({ description: "A pass that opens members' files for a time." });

/**
 * `answer`: the work itself, done after the payment on what the buyer gave in `with`, by a model given the offer's
 * `instructions`.
 */
export const DeliversAnswer = z
  .strictObject({
    kind: z.literal("answer"),
    instructions: z
      .string()
      .min(1)
      .max(4000)
      .meta({ description: "What the model is told to do with what the buyer gives, in plain words." }),
    asks: z
      .array(Ask)
      .min(1)
      .max(8)
      .meta({ description: "What the buyer gives, each once, for the model to work on. It is written into the public agreement." }),
  })
  .meta({ description: "Work a model does after payment, on what the buyer gives." });

/**
 * `order`: an order confirmation, its number, the items, where it would go; and `/orders/<id>`, which answers its
 * state. The order and the stock are real; the goods are not, and the agreement says so (design §5).
 */
export const DeliversOrder = z
  .strictObject({
    kind: z.literal("order"),
    stock: z.int().min(0).max(1_000_000).meta({ description: "How many can be sold. Each purchase takes one." }),
    asks: Asks.optional(),
  })
  .meta({ description: "An order for goods: recorded, and the stock reduced. Nothing is sent." });

/** What an offer delivers: one of the five kinds. */
export const Delivers = z
  .discriminatedUnion("kind", [DeliversFile, DeliversBooking, DeliversAccess, DeliversAnswer, DeliversOrder])
  .meta({ id: "Delivers", description: "What the offer delivers: one of five kinds." });
export type Delivers = z.infer<typeof Delivers>;
export type DeliveryKind = Delivers["kind"];
export const DELIVERY_KINDS = ["file", "booking", "access", "answer", "order"] as const satisfies readonly DeliveryKind[];

// ---------------------------------------------------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------------------------------------------------

/** An offer's terms, word for word: a heading in lowercase words joined by "-", and its text. */
export const Terms = z
  .record(
    z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(40),
    z.string().min(1).max(2000),
  )
  .meta({
    id: "Terms",
    description:
      'The offer\'s terms, word for word: each heading, as "returns", and its text. The agreement carries them as written.',
  });
export type Terms = z.infer<typeof Terms>;

/** The seller's limits, never shown in a browser. Present only where the price is open to negotiation. */
export const Limits = z
  .strictObject({
    lowest: Dollars.meta({ description: "The lowest price the seller will agree to, below the price." }),
  })
  .meta({ description: "Present only when the price is open to negotiation. Never shown to a buyer." });
export type Limits = z.infer<typeof Limits>;

const offerFields = {
  id: OfferId,
  name: z.string().min(1).max(80).meta({ description: 'The offer\'s name, as "House roast, 1 lb".' }),
  about: z.string().min(1).max(600).meta({ description: "What it is, in a sentence or two." }),
  price: Dollars,
  delivers: Delivers,
  terms: Terms,
  limits: Limits.optional(),
};

/** Paid now: x402 `exact`. */
export const OfferPaidNow = z.strictObject({
  ...offerFields,
  payment: z.literal("now").meta({ description: "Paid when bought (x402 exact)." }),
});

/**
 * Authorise now, collect later: x402 `auth-capture`. The whole price is authorised into escrow when bought, and
 * collected `collectAfterMinutes` after (design §3.6). For a demonstration that time is short, and the agreement says
 * so in plain words. Not open to negotiation: an offer paid this way has no `limits` (`businessProblems`).
 *
 * Renamed from `"later"` on 2026-09-30 (phase 3), when pay later was added beside it: `checkBusiness` names the rename
 * to a `business.json` that still says `"later"`.
 */
export const OfferAuthorise = z.strictObject({
  ...offerFields,
  payment: z
    .literal("authorise")
    .meta({ description: 'Authorise now, collect later: the whole price is held in escrow when bought, and collected collectAfterMinutes after (x402 auth-capture). Once called "later".' }),
  collectAfterMinutes: z
    .int()
    .min(1)
    .max(1440)
    .optional()
    .meta({ description: "When the seller collects, in minutes after the purchase. Two when not given." }),
});

/**
 * When the price of an offer paid later is due (design §3.9), as the offer says it:
 * - `{"kind": "booking"}`: when the booked slot starts. Only an offer that delivers a booking says it;
 * - `{"kind": "days", "days": n}`: `n` days after the purchase, as an invoice is.
 */
export const Due = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("booking").meta({ description: "Due when the booked slot starts: for an offer that delivers a booking." }) }),
    z.strictObject({
      kind: z.literal("days").meta({ description: "Due a number of days after the purchase, as an invoice is." }),
      days: z.int().min(1).max(365).meta({ description: "How many days after the purchase the price is due." }),
    }),
  ])
  .meta({ id: "Due", description: 'When the price is due: {"kind": "booking"}, when the booked slot starts; or {"kind": "days", "days": 30}, that many days after the purchase.' });
export type Due = z.infer<typeof Due>;

/**
 * Pay later (Fisher, 2026-09-30; design §3.9): the price is owed, and due when `due` says. At purchase the buyer pays
 * the smallest possible amount, one unit of test USDC (`ANCHOR_AMOUNT`), with x402 `exact`, whose nonce is the
 * agreement's hash: so the agreement, which holds what is owed and when, is anchored on chain. To the appliance it is
 * an ordinary transaction. Nothing tracks or collects the amount owed. Open to negotiation like an offer paid now: the
 * agreed price is what is owed.
 */
export const OfferDeferred = z.strictObject({
  ...offerFields,
  payment: z
    .literal("deferred")
    .meta({ description: "Pay later: the price is owed, and due when due says. At purchase the buyer pays only 0.000001 USDC, which anchors the agreement's hash on chain and is not part of the price." }),
  due: Due,
});

/** One offer, sold one way (design §2.6). */
export const Offer = z.discriminatedUnion("payment", [OfferPaidNow, OfferAuthorise, OfferDeferred]);
export type Offer = z.infer<typeof Offer>;
export type Payment = Offer["payment"];

/** How an offer is paid: the three values of `payment`. */
export const PAYMENTS = ["now", "authorise", "deferred"] as const satisfies readonly Payment[];

/** When a promise to pay is collected, when its offer does not say: two minutes after (design §3.6's example). */
export const DEFAULT_COLLECT_AFTER_MINUTES = 2 as const;

// ---------------------------------------------------------------------------------------------------------------------
// The business
// ---------------------------------------------------------------------------------------------------------------------

/** `business.json`. */
export const Business = z
  .strictObject({
    name: z.string().min(1).max(80).meta({ description: 'The business\'s name, as "Wren Coffee".' }),
    line: z.string().min(1).max(200).meta({ description: "One line that says what it is." }),
    contact: z
      .string()
      .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)
      .max(254)
      .meta({ description: "An email address." }),
    offers: z.array(Offer).min(1).max(20),
  })
  .meta({
    title: "business.json",
    description:
      "The business as data: its name and words, its offers, what each delivers, and the seller's limits. Prices are real-life US dollars and cents.",
  });
export type Business = z.infer<typeof Business>;

/** The example of design §2.6, verbatim. */
export const EXAMPLE_BUSINESS: Business = {
  name: "Wren Coffee",
  line: "Small-batch roasts, posted the day they are roasted.",
  contact: "hello@wren.example",
  offers: [
    {
      id: "house-roast",
      name: "House roast, 1 lb",
      about: "A medium roast from two farms in Huila.",
      price: "18.00",
      payment: "now",
      delivers: { kind: "order", stock: 40, asks: ["name", "address"] },
      terms: { returns: "Unopened bags, within 14 days.", dispatch: "Within 2 working days." },
      limits: { lowest: "15.00" },
    },
  ],
};

/** The rules that span fields. Each problem's path is a JSON Pointer into the business. */
export function businessProblems(business: Business): Problem[] {
  const problems: Problem[] = [];
  const once = (list: readonly string[], path: string, what: string) => {
    const seen = new Set<string>();
    list.forEach((item, i) => {
      if (seen.has(item)) problems.push({ path: `${path}/${i}`, message: `${what} "${item}" is named twice.` });
      seen.add(item);
    });
  };
  once(
    business.offers.map((o) => o.id),
    "/offers",
    "The offer id",
  );
  business.offers.forEach((offer, i) => {
    const at = `/offers/${i}`;
    if (Object.keys(offer.terms).length === 0) problems.push({ path: `${at}/terms`, message: "An offer needs at least one term." });
    if (offer.limits && dollarsToCents(offer.limits.lowest) >= dollarsToCents(offer.price)) {
      problems.push({ path: `${at}/limits/lowest`, message: "The lowest price must be below the price." });
    }
    if (offer.payment === "authorise" && offer.limits) {
      problems.push({
        path: `${at}/limits`,
        message: 'An offer paid "authorise" (held in escrow) is not open to negotiation: take out its limits, or make it "now" or "deferred".',
      });
    }
    if (offer.payment === "deferred" && offer.due.kind === "booking" && offer.delivers.kind !== "booking") {
      problems.push({
        path: `${at}/due`,
        message: 'Only an offer that delivers a booking is due when the booking starts: give "due": {"kind": "days", "days": …} instead.',
      });
    }
    const d = offer.delivers;
    if (d.asks) once(d.asks, `${at}/delivers/asks`, "The ask");
    if (d.kind === "booking") {
      once(d.days, `${at}/delivers/days`, "The day");
      once(d.times, `${at}/delivers/times`, "The time");
      if (d.asks?.includes("slot")) {
        problems.push({ path: `${at}/delivers/asks`, message: 'A booking takes "slot" itself; it is not an ask.' });
      }
    }
    if (d.kind === "access") once(d.opens, `${at}/delivers/opens`, "The file");
  });
  return problems;
}

/**
 * What `payment` once was, and is no longer: `"later"` meant the escrow's authorise-now, collect-later until pay later
 * was added beside it (2026-09-30, phase 3). A `business.json` that still says it fails, with words that name the
 * rename, rather than silently meaning something else.
 */
export const RENAMED_PAYMENT =
  '"payment": "later" was renamed: write "authorise" for authorise now, collect later (the whole price held in escrow when bought, and collected collectAfterMinutes after), or "deferred" for pay later (the price owed, due when "due" says, anchored on chain by a payment of 0.000001 USDC). "now" is unchanged.';

function renamedPayments(value: unknown): Problem[] {
  const offers = typeof value === "object" && value !== null ? (value as { offers?: unknown }).offers : undefined;
  if (!Array.isArray(offers)) return [];
  return offers.flatMap((o, i) =>
    typeof o === "object" && o !== null && (o as { payment?: unknown }).payment === "later" ? [{ path: `/offers/${i}/payment`, message: RENAMED_PAYMENT }] : [],
  );
}

/** Checks `business.json`: the rename of `"later"`, the schema, then the rules that span fields. */
export function checkBusiness(value: unknown): Checked<Business> {
  const renamed = renamedPayments(value);
  if (renamed.length > 0) return { ok: false, problems: renamed };
  const checked = check(Business, value);
  if (!checked.ok) return checked;
  const problems = businessProblems(checked.value);
  return problems.length === 0 ? checked : { ok: false, problems };
}

/** Every file in `src/goods/` that the business names, each once. The build refuses a business naming a missing file. */
export function goodsFilesOf(business: Business): string[] {
  const files = new Set<string>();
  for (const offer of business.offers) {
    if (offer.delivers.kind === "file") files.add(offer.delivers.file);
    if (offer.delivers.kind === "access") offer.delivers.opens.forEach((f) => files.add(f));
  }
  return [...files];
}

/** What the offer asks the buyer for. */
export function asksOf(offer: Offer): readonly string[] {
  return offer.delivers.asks ?? [];
}
