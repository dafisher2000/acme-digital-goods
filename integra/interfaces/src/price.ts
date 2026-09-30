/**
 * Prices: real-life, paid tiny (design §3.8). The scale is held here and nowhere else.
 *
 * Ruled by Fisher, 2026-09-29 (late), on call 5: "we need to always transact in tiny prices (.00023 USDC, etc.) - that
 * can simulate real prices"; the scale confirmed: "yes to all three".
 *
 * - An offer's price is a real-life price in US dollars and cents, written `"18.00"`. The storefront shows it as that.
 * - It is paid at one fixed scale: **one cent is one millionth of a USDC**, the token's smallest unit. So $18.00 is
 *   paid as 0.0018 USDC (1800 units), and $2.30 as 0.00023 USDC (230 units). Every price in cents is a whole number of
 *   units, so no price is rounded.
 * - Everything the transaction carries is the amount paid: the payment option's `amount`, the agreement's `order`, the
 *   payment and the chain. The listed price goes beside it, in words.
 * - Negotiation is in cents, and budgets are in dollars, converted at the same scale.
 */
import { z } from "zod";
import { USDC } from "./network.ts";

/** The token's smallest units paid for one cent of a listed price. */
export const UNITS_PER_CENT = 1 as const;

/** Cents in a dollar. */
export const CENTS_PER_DOLLAR = 100 as const;

/** The largest price a `Dollars` value may hold, in cents: $9,999,999.99. */
export const MAX_CENTS = 999_999_999 as const;

const DOLLARS = /^(?:[1-9][0-9]{0,6}\.[0-9]{2}|0\.(?:0[1-9]|[1-9][0-9]))$/;

/**
 * A real-life price in US dollars and cents: digits, a point, and exactly two digits of cents, as `"18.00"`. At least
 * `"0.01"` and at most `"9999999.99"`. No currency sign, no thousands separator.
 */
export const Dollars = z
  .string()
  .regex(DOLLARS)
  .meta({
    description:
      'A real-life price in US dollars and cents, as "18.00": digits, a point and two digits of cents, from "0.01" to "9999999.99". No "$" and no thousands separator.',
    examples: ["18.00", "2.30"],
  });
export type Dollars = z.infer<typeof Dollars>;

/** Whole cents, from 1 to `MAX_CENTS`. */
export const Cents = z.int().min(1).max(MAX_CENTS);
export type Cents = z.infer<typeof Cents>;

function refuse(what: string, value: unknown): never {
  throw new RangeError(`${what}: ${JSON.stringify(value)}`);
}

/** `"18.00"` → `1800`. Throws on anything that is not `Dollars`. */
export function dollarsToCents(dollars: string): number {
  if (!DOLLARS.test(dollars)) refuse("not a price in dollars and cents", dollars);
  const [whole, cents] = dollars.split(".") as [string, string];
  return Number(whole) * CENTS_PER_DOLLAR + Number(cents);
}

/** `1800` → `"18.00"`. Throws on anything that is not whole cents from 1 to `MAX_CENTS`. */
export function centsToDollars(cents: number): Dollars {
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > MAX_CENTS) refuse("not whole cents in range", cents);
  const whole = Math.floor(cents / CENTS_PER_DOLLAR);
  const rest = cents % CENTS_PER_DOLLAR;
  return `${whole}.${String(rest).padStart(2, "0")}`;
}

/**
 * **The conversion.** Whole cents of a listed or agreed price → the amount paid, in the token's smallest units, as the
 * decimal string x402 carries: `1800` → `"1800"`.
 */
export function centsToAmount(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > MAX_CENTS) refuse("not whole cents in range", cents);
  return String(cents * UNITS_PER_CENT);
}

/** **The conversion,** from a price: `"18.00"` → `"1800"` (0.0018 USDC). */
export function dollarsToAmount(dollars: string): string {
  return centsToAmount(dollarsToCents(dollars));
}

/** The amount paid, in units, back to whole cents: `"1800"` → `1800`. Throws when it is not a whole number of cents. */
export function amountToCents(amount: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(amount)) refuse("not an amount in units", amount);
  const units = BigInt(amount);
  if (units % BigInt(UNITS_PER_CENT) !== 0n) refuse("not a whole number of cents", amount);
  const cents = units / BigInt(UNITS_PER_CENT);
  if (cents < 1n || cents > BigInt(MAX_CENTS)) refuse("not whole cents in range", amount);
  return Number(cents);
}

/** The amount paid, in units, back to the listed price's form: `"1800"` → `"18.00"`. */
export function amountToDollars(amount: string): Dollars {
  return centsToDollars(amountToCents(amount));
}

/** The amount paid, in units, as USDC for a person to read, with no trailing zeros: `"1800"` → `"0.0018"`. */
export function amountToUsdc(amount: string): string {
  if (!/^(?:0|[1-9][0-9]*)$/.test(amount)) refuse("not an amount in units", amount);
  const digits = amount.padStart(USDC.decimals + 1, "0");
  const whole = digits.slice(0, -USDC.decimals);
  const fraction = digits.slice(-USDC.decimals).replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

/**
 * The sentence the agreement's `demonstration` slot carries about the scale (design §3.8), for this price:
 * "Prices are real-life prices. In this demonstration each is paid at one millionth of a USDC for each cent, on a
 * test network: $18.00 is paid as 0.0018 USDC."
 */
export function priceScaleSentence(price: Dollars): string {
  return (
    "Prices are real-life prices. In this demonstration each is paid at one millionth of a USDC for each cent, on a " +
    `test network: $${price} is paid as ${amountToUsdc(dollarsToAmount(price))} USDC.`
  );
}

/**
 * The same sentence for pay later (design §3.9), whose price is owed rather than paid: "Prices are real-life prices. In
 * this demonstration each is paid at one millionth of a USDC for each cent, on a test network: $45.00 is owed as 0.0045
 * USDC."
 */
export function owedScaleSentence(price: Dollars): string {
  return (
    "Prices are real-life prices. In this demonstration each is paid at one millionth of a USDC for each cent, on a " +
    `test network: $${price} is owed as ${amountToUsdc(dollarsToAmount(price))} USDC.`
  );
}

/**
 * **The anchoring payment** of an offer paid later (Fisher, 2026-09-30: "the smallest possible payment so that the
 * transaction proof can be anchored on chain"; design §3.9): the token's smallest unit, 0.000001 USDC, paid with x402
 * `exact` whose nonce is the agreement's hash. It is not part of the price: the price is owed in full, as the agreement
 * says.
 */
export const ANCHOR_AMOUNT = "1" as const;

/** The anchoring payment, in USDC, as a person reads it. */
export const ANCHOR_USDC = "0.000001" as const;

/** The words every surface uses for the anchoring payment. */
export const ANCHOR_SENTENCE =
  "At purchase the buyer pays 0.000001 USDC, the smallest amount the token can move, whose nonce is the agreement's hash: it anchors the agreement on chain, and is not part of the price." as const;
