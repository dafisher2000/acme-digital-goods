/**
 * The agreement store (design §12): it takes the appliance's signed `PUT /atr/<H>`, and answers the public
 * `GET /atr/<H>` with the exact bytes. It is not the archive: it keeps an agreement for 30 days.
 *
 * The PUT is the appliance's, and its shape is the appliance's (R1 §10):
 *
 * ```
 * PUT {endpoint without one trailing "/"}/{H}
 * content-type: application/json
 * webhook-id: {H}                       // "0x" + 64 lowercase hex
 * webhook-timestamp: {Unix seconds}
 * webhook-signature: v1,{base64( HMAC-SHA256(secret, "{H}.{timestamp}." + body) )}
 * body: the ATR's exact bytes
 * ```
 *
 * It is the Standard Webhooks scheme. The appliance follows no redirect, and counts only a 2xx as written. Its write
 * has 800 ms unless the tenant asks for more; v4's tenant asks for `STORAGE_WRITE_TIMEOUT_MS`. The whole `issue`, the
 * write inside it, has 1.8 s (R1 §9).
 *
 * The tenant document points both the storage `endpoint.url` and its `publicBase` at `AGREEMENT_STORE_BASE`, so the
 * appliance writes `<base>/<H>` and gives the buyer the link `<base>/<H>` (R1 §10).
 */
import { z } from "zod";
import { AtrHash } from "./common.ts";
import { SERVICE_ORIGINS } from "./services.ts";

/** The path prefix both routes share. */
export const ATR_PATH_PREFIX = "/atr" as const;

/**
 * The agreement store's base: the tenant's storage `endpoint.url` and its `publicBase` (design §12, step 3). An
 * agreement's link is `${AGREEMENT_STORE_BASE}/<H>`.
 */
export const AGREEMENT_STORE_BASE = `${SERVICE_ORIGINS.agreementStore}${ATR_PATH_PREFIX}` as const;

/** `/atr/<H>`. */
export function atrPath(h: AtrHash): string {
  return `${ATR_PATH_PREFIX}/${h}`;
}

/** The agreement's link: `<base>/<H>`. The appliance builds it the same way; the kit shows the link `issue` returned. */
export function atrLink(h: AtrHash, base: string = AGREEMENT_STORE_BASE): string {
  return `${base.replace(/\/$/, "")}/${h}`;
}

/** The path's pattern: `/atr/0x` and 64 lowercase hex. */
export const ATR_PATH = /^\/atr\/(0x[0-9a-f]{64})$/;

/** Reads H from a path, or `null` when the path is not `/atr/<H>`. */
export function hashFromAtrPath(pathname: string): AtrHash | null {
  const m = ATR_PATH.exec(pathname);
  return m ? (m[1] as AtrHash) : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The signed PUT
// ---------------------------------------------------------------------------------------------------------------------

/** The Standard Webhooks headers the appliance's PUT carries. */
export const WEBHOOK_HEADERS = {
  id: "webhook-id",
  timestamp: "webhook-timestamp",
  signature: "webhook-signature",
} as const;

/** How far `webhook-timestamp` may be from the store's clock, either way (design §12). */
export const WEBHOOK_TOLERANCE_SECONDS = 300 as const;

/** The largest ATR: 1 MiB. The appliance refuses a larger one before it writes (R1 §9, §10). */
export const MAX_ATR_BYTES = 1_048_576 as const;

/** What the tenant asks the appliance to give the store's write, in ms (design §12). The appliance's default is 800. */
export const STORAGE_WRITE_TIMEOUT_MS = 1500 as const;

/** How long `issue` has in all, the store's write inside it (R1 §9). */
export const ISSUE_DEADLINE_MS = 1800 as const;

/** How long the store keeps an agreement (design §12). */
export const ATR_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/**
 * The storage secret, as the tenant's `secrets.put` takes it and the store holds it: `whsec_` and the standard base64
 * of 24 to 64 random bytes (R1 §10; R5 §7). The HMAC key is the decoded bytes. The setup mints 32.
 */
export const StorageSecret = z.string().regex(/^whsec_(?:[A-Za-z0-9+/]{4}){8,22}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export type StorageSecret = z.infer<typeof StorageSecret>;

/** The bytes a new storage secret is minted from. */
export const STORAGE_SECRET_BYTES = 32 as const;

/**
 * The PUT's headers. `webhook-signature` is a space-separated list of `v1,<base64>`, any one of which may match.
 * `webhook-id` must equal H in the path.
 */
export const AtrPutHeaders = z.object({
  "webhook-id": AtrHash,
  "webhook-timestamp": z.string().regex(/^[0-9]{1,12}$/),
  "webhook-signature": z.string().regex(/^v1,[A-Za-z0-9+/]+={0,2}(?: v1,[A-Za-z0-9+/]+={0,2})*$/),
});
export type AtrPutHeaders = z.infer<typeof AtrPutHeaders>;

/**
 * What the signature is over: the UTF-8 of `"<webhook-id>.<webhook-timestamp>."`, then the body's exact bytes. The
 * signature is base64 of HMAC-SHA256 under the secret's decoded bytes.
 */
export function webhookSignedContent(id: string, timestamp: string, body: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(`${id}.${timestamp}.`);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

/** The PUT's answer when it is written, or was already kept: `204`, no body. The appliance discards the body. */
export const ATR_PUT_WRITTEN_STATUS = 204 as const;

// ---------------------------------------------------------------------------------------------------------------------
// The public GET
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The GET's headers, as the store answers them (`services/atr/src/index.ts`). The bytes are the ATR's exact bytes,
 * which are JSON, and never change under their hash.
 * - The buyer's gate fetches with `redirect: "manual"` and `Accept-Encoding: identity`, and declines any redirect, any
 *   `Content-Encoding`, and a fetch longer than 10 s or over 1 MiB (R2 §1). So the store answers `200` itself, and
 *   `no-transform` keeps Cloudflare from encoding the bytes.
 * - Any origin may read it: the proof page's browser, the buyer, `curl`.
 * - `etag` is `"<H>"`. The store answers `HEAD` too.
 */
export const ATR_GET_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "public, no-transform, max-age=3600",
  "access-control-allow-origin": "*",
} as const;

// ---------------------------------------------------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Every status the store answers, and when. A refusal's body is one line of `text/plain` for a person: the appliance
 * reads only the status, and counts only a 2xx as written (R1 §10).
 */
export const AGREEMENT_STORE_STATUSES = {
  written: 204, // PUT: written, or already kept under H
  found: 200, // GET or HEAD: the exact bytes
  badPath: 400, // the path's hash is not 0x and 64 lowercase hex
  hashMismatch: 400, // PUT: the body does not hash to H
  unsigned: 401, // PUT: a webhook header missing, webhook-id not H, the timestamp over 300 s away, or no signature verifies
  notFound: 404, // GET: nothing kept under H; or a path that is not /atr/<H>
  method: 405, // neither PUT, GET nor HEAD
  tooLarge: 413, // PUT: over 1 MiB
} as const;
