/**
 * The runtime validator, and the JSON Schema text, from the one source of truth.
 *
 * **The choice: Zod 4.** Each interface is written once, as a Zod schema. From it come:
 * - the TypeScript type, by `z.infer`;
 * - the runtime validator, `check` below. Zod 4 compiles nothing where code generation is forbidden: it tests for
 *   Cloudflare's runtime (`navigator.userAgent`) and for a working `new Function`, and otherwise interprets the schema.
 *   So it runs inside a Worker, where `eval` and `new Function` throw;
 * - the JSON Schema, by `z.toJSONSchema`, as draft 2020-12. The files in `schemas/` are written from it by
 *   `pnpm --filter @demo-factory/interfaces schemas`, and `jsonSchema()` gives the same text at run time.
 *
 * Zod 4 schemas are also Standard Schema with JSON Schema (`~standard.validate` and `~standard.jsonSchema`), which is
 * what the MCP SDK's `registerTool` takes for a tool's input. So a tool's schema here is the tool's schema there.
 *
 * The rule that keeps the three the same: no schema here uses a refinement or a transform, which JSON Schema cannot say.
 * A rule that spans fields, such as "the lowest price is below the price", is a named function beside its schema.
 */
import { z } from "zod";

/** Where a value failed, as a JSON Pointer (RFC 6901), and why. */
export interface Problem {
  path: string;
  message: string;
}

/** A value checked against a schema: the value as the type, or every problem found. */
export type Checked<T> = { ok: true; value: T } | { ok: false; problems: Problem[] };

function pointer(path: readonly PropertyKey[]): string {
  return path.map((p) => "/" + String(p).replaceAll("~", "~0").replaceAll("/", "~1")).join("");
}

/** Checks a value against a schema. Never throws. */
export function check<S extends z.ZodType>(schema: S, value: unknown): Checked<z.output<S>> {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    problems: result.error.issues.map((issue) => ({ path: pointer(issue.path), message: issue.message })),
  };
}

/** The problems as lines a person or a model can read: `/offers/0/price: Invalid string: must match pattern …`. */
export function describeProblems(problems: readonly Problem[]): string {
  return problems.map((p) => `${p.path || "/"}: ${p.message}`).join("\n");
}

/** A schema as JSON Schema, draft 2020-12, for the input side (what a writer of the JSON must write). */
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-2020-12", io: "input", unrepresentable: "throw" }) as Record<
    string,
    unknown
  >;
}
