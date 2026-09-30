// RFC 8785 (JSON Canonicalization Scheme), for the two things the agent door writes in that form (design §3.2, §9):
// the body a `buy` or `test_buy` call stands for, and an offer's terms, whose SHA-256 `/terms.md` names.
//
// lcp's `canonicalJson` is in its root only, and its root needs its optional chain libraries at build (design §13,
// row 6). So the door carries the function, as that row allows. It is the same rule as lcp's `core.ts`: members
// sorted by their UTF-16 code units, recursively; every primitive written as `JSON.stringify` writes it, which is
// RFC 8785's number form for any finite number.
import type { Json } from "@demo-factory/interfaces";

/** The RFC 8785 form of a JSON value. Throws on a value that is not JSON (a non-finite number, an unpaired surrogate). */
export function canonicalJson(value: Json): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new RangeError("not JSON: a non-finite number");
    if (typeof value === "string" && !value.isWellFormed()) throw new RangeError("not JSON: an unpaired surrogate");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${canonicalJson(k)}:${canonicalJson(value[k] as Json)}`).join(",")}}`;
}

/** SHA-256 of bytes, as `0x` and 64 lowercase hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<`0x${string}`> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  let hex = "0x";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return hex as `0x${string}`;
}

export const utf8 = new TextEncoder();
