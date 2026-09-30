// RFC 8785, the JSON Canonicalization Scheme, carried by the kit (design §13, row 6).
//
// Row 6, found out on 2026-09-30: lcp's `canonicalJson` is exported from its root only, and a Worker built on lcp's root
// does not build under wrangler's bundler (seven of its optional chain libraries are unresolved). Under Vite it builds only
// because Vite stubs each missing library with a module that throws, and it adds about 1.2 MB. So the kit is built on
// lcp's `x402`, `evm` and `discovery` entry points (94 KiB), and carries this function, written to lcp's rules: members
// sorted by their UTF-16 code units, recursively; primitives written as `JSON.stringify` writes them; a refusal for
// anything nested deeper than 64 levels, any number that is not finite, and any unpaired surrogate.

/** The deepest nesting lcp's `canonicalJson` accepts. */
const MAX_DEPTH = 64;

const UNPAIRED = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function str(s: string): string {
  if (UNPAIRED.test(s)) throw new RangeError("RFC 8785: a string holds an unpaired surrogate");
  return JSON.stringify(s);
}

function write(v: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new RangeError(`RFC 8785: nested deeper than ${MAX_DEPTH}`);
  if (v === null || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "string") return str(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new RangeError("RFC 8785: a number that is not finite");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map((x) => write(x, depth + 1)).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    // JavaScript's default sort compares UTF-16 code units, which is RFC 8785's order.
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${str(k)}:${write(o[k], depth + 1)}`).join(",")}}`;
  }
  throw new TypeError(`RFC 8785: not a JSON value (${typeof v})`);
}

/** The RFC 8785 form of a JSON value. Throws on a value lcp's `canonicalJson` refuses. */
export function canonicalJson(value: unknown): string {
  return write(value, 1);
}

/** The RFC 8785 form's UTF-8 bytes: what the MCP door commits to as the body of `POST /buy/<offer>` (design §3.2). */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}
