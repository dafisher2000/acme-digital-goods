// `/terms.md` (design §9): the business's terms of sale, written from `business.json` and the app's origin alone, so
// the same app always serves the same bytes (byte-stable, as in v3; R4 Q10). No date in it is the request's time.
//
// Each offer's section ends with the hash of that offer's terms in RFC 8785 form. `/.well-known/legal-context.json`
// names the SHA-256 of the whole document as its `atrHash`: the terms' hash, never an agreement's. Every agreement's
// `terms` slot holds this document's address and that same hash (`TermsSlot.document`), which `termsDocument` gives.
import {
  ANCHOR_SENTENCE,
  ANCHOR_USDC,
  AUTH_CAPTURE_ESCROW,
  CHECKOUT_LIFETIME_SECONDS,
  DEFAULT_COLLECT_AFTER_MINUTES,
  DEMONSTRATION_SENTENCE,
  MAX_TIMEOUT_SECONDS,
  NETWORK,
  NETWORK_NAME,
  ORDER_DEMONSTRATION_SENTENCE,
  QUOTE_HOLD_SECONDS,
  SERVICE_ORIGINS,
  TEST_CHECKOUT_SENTENCE,
  USDC,
  WALLETS,
  amountToUsdc,
  asksOf,
  dollarsToAmount,
  dollarsToCents,
  type Business,
  type Offer,
} from "@demo-factory/interfaces";
import { canonicalJson, sha256Hex, utf8 } from "./canonical.ts";

export const TERMS_PATH = "/terms.md";
export const TERMS_MEDIA_TYPE = "text/markdown; charset=utf-8";

/** An offer's terms in RFC 8785 form, and the SHA-256 of that form's UTF-8 bytes. */
export async function offerTermsHash(offer: Offer): Promise<{ canonical: string; sha256: `0x${string}` }> {
  const canonical = canonicalJson(offer.terms);
  return { canonical, sha256: await sha256Hex(utf8.encode(canonical)) };
}

/** The price, and what it is paid as: "$6.00, paid as 0.0006 USDC". */
export function priceWords(price: string): string {
  return `$${price}, paid as ${amountToUsdc(dollarsToAmount(price))} USDC`;
}

/** When the price of an offer paid later is due, in words (design §3.9). */
export function dueWords(offer: Extract<Offer, { payment: "deferred" }>): string {
  return offer.due.kind === "booking"
    ? "when the booked slot starts"
    : `${offer.due.days} day${offer.due.days === 1 ? "" : "s"} after the purchase`;
}

/** An offer's price, and what is paid: "$6.00, paid as 0.0006 USDC"; for pay later, "$45.00, owed later as 0.0045 USDC". */
export function offerPriceWords(offer: Offer): string {
  if (offer.payment !== "deferred") return priceWords(offer.price);
  return `$${offer.price}, owed later as ${amountToUsdc(dollarsToAmount(offer.price))} USDC, not paid at purchase`;
}

/** How an offer is paid, in words. */
export function paymentWords(offer: Offer): string {
  if (offer.payment === "now") return "Paid when bought (x402 `exact`).";
  if (offer.payment === "deferred") {
    return (
      `Pay later: the price is owed, due ${dueWords(offer)}, and the agreement says what is owed and when. ` +
      `${ANCHOR_SENTENCE} (x402 \`exact\`.) Nothing here tracks or collects the amount owed.`
    );
  }
  const minutes = offer.collectAfterMinutes ?? DEFAULT_COLLECT_AFTER_MINUTES;
  return (
    "Authorise now, collect later: the whole price is authorised into escrow when bought, and collected by the seller " +
    `${minutes} minute${minutes === 1 ? "" : "s"} after (x402 \`auth-capture\`). Until it is collected, it is ` +
    "authorised, not paid."
  );
}

/** What an offer delivers, in words. */
export function deliversWords(offer: Offer): string {
  const d = offer.delivers;
  switch (d.kind) {
    case "file":
      return `A file, \`${d.file.slice(d.file.lastIndexOf("/") + 1)}\`, in the answer to the paid request. Its size and SHA-256 are named in the agreement before the payment.`;
    case "booking":
      return (
        `A booking of ${d.minutes} minutes, confirmed with a reference and an .ics file. Slots start at ` +
        `${d.times.join(", ")} (${d.timezone}) on ${d.days.join(", ")}, up to ${d.ahead} days ahead; the catalogue ` +
        "lists the free ones. One booking takes one slot, and a slot is held for one buyer only."
      );
    case "access":
      return `A pass, good for ${d.hours} hours from the purchase, that opens ${d.opens.length} members' file${d.opens.length === 1 ? "" : "s"}.`;
    case "answer":
      return "Work a language model does once, after the payment settles, on what the buyer gives; delivered in the answer to the paid request, and readable again at the address the agreement names.";
    case "order":
      return `An order for goods, with its number. ${ORDER_DEMONSTRATION_SENTENCE}`;
  }
}

function offerSection(offer: Offer, hash: string): string {
  const asks = asksOf(offer);
  const lines = [
    `### ${offer.name} (\`${offer.id}\`)`,
    "",
    offer.about,
    "",
    `- Price: ${offerPriceWords(offer)}.`,
    `- Payment: ${paymentWords(offer)}`,
    `- Delivers: ${deliversWords(offer)}`,
  ];
  if (asks.length > 0) {
    lines.push(`- Asks the buyer for: ${asks.join(", ")}. What the buyer gives is written into the agreement, which is public.`);
  }
  if (offer.delivers.kind === "booking") {
    lines.push("- The buyer may name a free slot as `slot`, its start time as the catalogue lists it; without one, the next free slot is booked.");
  }
  if (offer.limits) lines.push("- The price is open to negotiation, down to a lowest price the seller does not disclose.");
  lines.push("", "Its terms, word for word:", "");
  for (const [heading, text] of Object.entries(offer.terms)) lines.push(`- **${heading}**: ${text}`);
  lines.push("", `The SHA-256 of these terms in their RFC 8785 (JSON Canonicalization Scheme) form is \`${hash}\`.`);
  return lines.join("\n");
}

/** The whole of `/terms.md`, for this business at this origin. */
export async function termsMarkdown(business: Business, origin: string): Promise<string> {
  const sections = await Promise.all(business.offers.map(async (o) => offerSection(o, (await offerTermsHash(o)).sha256)));
  const example = business.offers[0]!.price;
  const authorise = business.offers.some((o) => o.payment === "authorise");
  const deferred = business.offers.some((o) => o.payment === "deferred");
  const kinds = new Set(business.offers.map((o) => o.delivers.kind));
  const delivery: string[] = [];
  if (kinds.has("file")) delivery.push("- A file is delivered in the answer to the paid request, and only then. The buyer can check it against the SHA-256 the agreement names.");
  if (kinds.has("booking")) delivery.push("- A booking is confirmed at its own address, with an .ics file. Nothing else is arranged.");
  if (kinds.has("access")) delivery.push("- A pass opens the members' files for its stated time. Without the pass, their addresses answer 401.");
  if (kinds.has("answer")) delivery.push("- An answer is written once, after the payment settles, and can be read again at its own address.");
  if (kinds.has("order")) delivery.push(`- An order is recorded at its own address. ${ORDER_DEMONSTRATION_SENTENCE}`);

  const text = [
    `# Terms of sale: ${business.name}`,
    "",
    `These are the terms on which ${business.name} sells at ${origin}. Each purchase makes its own agreement, which holds these terms' address and hash.`,
    "",
    "## 1. This is a demonstration",
    "",
    DEMONSTRATION_SENTENCE,
    "",
    `Every sale here is fully executed when it is made: the agreement is issued and bound to the payment, the payment is made on ${NETWORK_NAME} (\`${NETWORK}\`), a test network, in its test USDC (\`${USDC.address}\`), and what is sold is delivered as section 6 says. Nothing here is sold for money of any value.`,
    "",
    `Prices are real-life prices in US dollars. In this demonstration each is paid at one millionth of a USDC for each cent: ${priceWords(example)}.`,
    "",
    "## 2. The parties",
    "",
    `- The seller: ${business.name}, at ${origin}. Contact: ${business.contact}.`,
    "- The buyer: whoever pays for an offer here, through an agent of their own or one they use. The buyer is known by the wallet that signs the payment.",
    "",
    "## 3. What is sold, and each offer's terms",
    "",
    sections.join("\n\n"),
    "",
    "## 4. How an agreement is made",
    "",
    "- When a buyer asks to buy, before any payment, Integra's appliance issues an agreement for that purchase: an Agreement Transaction Record (ATR). It holds the seller, the offer, these terms (the offer's word for word, and this document by its address and SHA-256), the order and its price, what the buyer gave, and what this demonstration will and will not do.",
    "- The payment request carries the agreement's hash, H, which is the SHA-256 of its exact bytes, and a link to those bytes, in the x402 extension `legalContext`. An agent should fetch the link, hash the bytes, and compare the result with H before it signs.",
    "- The payment is bound to H: for an offer paid when bought, and for pay later's anchoring payment, H is the nonce of the EIP-3009 authorization; for an offer authorised now and collected later, H is in the escrow payment's salt. A payment that carries H is the buyer's acceptance of that agreement.",
    `- An agreement can be paid once, while it is open: ${CHECKOUT_LIFETIME_SECONDS / 60} minutes from its issue. A signature is good for ${MAX_TIMEOUT_SECONDS} seconds.`,
    `- Where an offer is open to negotiation, a price agreed with the seller's agent stands for ${QUOTE_HOLD_SECONDS / 60} minutes, for one purchase, named as the quote.`,
    `- Every offer also has a test checkout, at \`/test/buy/<offer>\` and as the tool \`test_buy\`. ${TEST_CHECKOUT_SENTENCE}`,
    "",
    "## 5. Payment",
    "",
    `- Paid when bought: an EIP-3009 transfer of the amount, in test USDC, to the seller's treasury, \`${WALLETS.treasury}\`, settled by Integra's facilitator (${SERVICE_ORIGINS.facilitator}).`,
    ...(authorise
      ? [
          `- Authorise now, collect later: the buyer authorises the amount into the x402 \`auth-capture\` escrow (\`${AUTH_CAPTURE_ESCROW.authCaptureEscrow}\`) when it buys, and the seller collects it at the time the offer names. The seller collects within a day of the sale; after that, only the payer can take the money back.`,
        ]
      : []),
    ...(deferred
      ? [
          `- Pay later: the price is owed, and due when the offer says: when the booked slot starts, or a number of days after the purchase. The agreement states what is owed, when it is due, and how it is to be paid: in test USDC, at the scale above, to the seller's treasury. At purchase the buyer pays ${ANCHOR_USDC} USDC, an EIP-3009 transfer whose nonce is the agreement's hash, which anchors the agreement on chain. That payment is not part of the price. Nothing here tracks or collects the amount owed.`,
        ]
      : []),
    "- No fee is charged beyond the price.",
    "- A payment is said to be paid only once the seller's own reading of the chain confirms it.",
    "",
    "## 6. Delivery",
    "",
    "Each purchase is delivered once, at its inception, after its payment settles: for an offer authorised now and collected later, after it is authorised into escrow; for pay later, after the anchoring payment settles.",
    "",
    ...delivery,
    "",
    "## 7. Records",
    "",
    `- Each purchase has a proof page, at \`${origin}/proof/<H>\`, which shows the agreement, the appliance's record of it, and the payment on the chain.`,
    "- The appliance records a transaction at its inception: the agreement, and the payment bound to it. What follows, such as the collection of a payment authorised into escrow, is the seller's own reading of the chain. For pay later, the amount owed is neither tracked nor collected: the record is of the agreement and its anchoring payment.",
    "",
    "## 8. No warranty",
    "",
    "Everything here is provided as it is, for demonstration, with no warranty of any kind.",
    "",
    "## 9. Changes to these terms",
    "",
    `These terms are served at ${origin}${TERMS_PATH}. Their SHA-256 is published as \`atrHash\` in ${origin}/.well-known/legal-context.json. If they change, their hash changes; an agreement already made holds the address and hash of the terms it was made under.`,
    "",
    "## 10. Contact",
    "",
    business.contact,
    "",
  ].join("\n");
  return text;
}

/** `/terms.md` as served: its text, its bytes, the SHA-256 of its bytes, and its address. */
export async function termsDocument(
  business: Business,
  origin: string,
): Promise<{ text: string; bytes: Uint8Array; sha256: `0x${string}`; url: string }> {
  const text = await termsMarkdown(business, origin);
  const bytes = utf8.encode(text);
  return { text, bytes, sha256: await sha256Hex(bytes), url: origin + TERMS_PATH };
}

/** The price of an offer in cents, as UCP's `amount` (ISO 4217 minor units of USD). */
export const priceCents = (offer: Offer) => dollarsToCents(offer.price);
