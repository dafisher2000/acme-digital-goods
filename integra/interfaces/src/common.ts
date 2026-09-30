/**
 * Primitives every interface shares: JSON, hashes, addresses, times, and the refusal body of v4's own services.
 */
import { z } from "zod";

/** Any JSON value (RFC 8259). */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export const Json: z.ZodType<Json> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(Json), z.record(z.string(), Json)]),
);

/** A JSON object. */
export type JsonObject = { [key: string]: Json };
export const JsonObject: z.ZodType<JsonObject> = z.record(z.string(), Json);

/**
 * An ATR's hash, H: SHA-256 over the ATR's exact bytes, as `0x` and 64 lowercase hex (R1 §3). The seller door writes
 * it lowercase, and the agreement store's `webhook-id` carries it so.
 */
export const AtrHash = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/)
  .meta({ description: "SHA-256 over the ATR's exact bytes: 0x and 64 lowercase hex." });
export type AtrHash = z.infer<typeof AtrHash>;

/** A SHA-256 digest written as `0x` and 64 lowercase hex, of something other than an ATR. */
export const Sha256Hex = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/)
  .meta({ description: "A SHA-256 digest: 0x and 64 lowercase hex." });
export type Sha256Hex = z.infer<typeof Sha256Hex>;

/** A 32-byte value, `0x` and 64 hex, either case: a transaction hash, a nonce, a salt. */
export const Bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export type Bytes32 = z.infer<typeof Bytes32>;

/** Any `0x` hex string of whole bytes, either case: a signature. */
export const Hex = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/);
export type Hex = z.infer<typeof Hex>;

/** An EVM address: `0x` and 40 hex, either case (a checksummed address is mixed case). */
export const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export type Address = z.infer<typeof Address>;

/** A transaction hash on the network. */
export const TransactionHash = Bytes32;
export type TransactionHash = Bytes32;

/** A decimal string of a uint256: the token's smallest units, as x402 carries every amount. */
export const Uint256String = z.string().regex(/^(?:0|[1-9][0-9]{0,77})$/);
export type Uint256String = z.infer<typeof Uint256String>;

/** A CAIP-2 network id, such as `eip155:84532`. */
export const Caip2 = z.string().regex(/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/);
export type Caip2 = z.infer<typeof Caip2>;

/** An absolute https URL. */
export const HttpsUrl = z.string().regex(/^https:\/\/[^\s]+$/).max(2048);
export type HttpsUrl = z.infer<typeof HttpsUrl>;

/** An absolute URL, http or https (a local `wrangler` run is http). */
export const WebUrl = z.string().regex(/^https?:\/\/[^\s]+$/).max(2048);
export type WebUrl = z.infer<typeof WebUrl>;

/** A time, as ISO 8601 in UTC with a `Z`: `2026-09-29T23:20:52.000Z`. */
export const IsoTime = z.iso.datetime();
export type IsoTime = z.infer<typeof IsoTime>;

/** Unix time in whole seconds. */
export const UnixSeconds = z.int().min(0);
export type UnixSeconds = z.infer<typeof UnixSeconds>;

/**
 * The refusal body every v4 service and the kit answer with, when they refuse: a code and one plain sentence. It
 * follows the seller door's `{code, sentence, correlationId}` (R1 §1), without the correlation id.
 */
export const Refusal = z.strictObject({
  code: z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+$/),
  sentence: z.string().min(1),
});
export type Refusal = z.infer<typeof Refusal>;
