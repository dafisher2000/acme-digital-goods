/**
 * A template (design §11): a kind of business, and the scenarios it offers. One file each, `templates/<id>.ts`, whose
 * default export is a `Template`. The Studio opens on them; the person fills the blanks, and the filled prompt is the
 * project's first turn. The project keeps the template's id, and "Run the scenarios" runs the template's scenarios.
 */
import { z } from "zod";
import { DELIVERY_KINDS } from "./business.ts";
import { Scenario } from "./buyer.ts";

/** A template's id: lowercase words joined by "-". It names the file and the cover. */
export const TemplateId = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
  .max(32)
  .meta({ description: "A template's id: lowercase words joined by '-'." });
export type TemplateId = z.infer<typeof TemplateId>;

/** One blank the person fills in. The prompt names it as `{{id}}`. */
export const Blank = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(32),
  label: z.string().min(1).max(60),
  hint: z.string().max(160).optional().meta({ description: "One line under the field, saying what to write." }),
  example: z.string().min(1).max(200).meta({ description: "A plausible answer. It is the field's starting value, so a person may press on." }),
});
export type Blank = z.infer<typeof Blank>;

const PLACEHOLDER = /\{\{([a-z][a-z0-9-]*)\}\}/g;

/** The scenarios every template offers (design §11). */
export const ALWAYS: readonly Scenario[] = ["buy-now", "test-checkout"];

export const Template = z
  .strictObject({
    id: TemplateId,
    title: z.string().min(1).max(60),
    line: z.string().min(1).max(160).meta({ description: "One line that says what kind of business it is." }),
    cover: z
      .string()
      .regex(/^templates\/covers\/[a-z0-9-]+\.webp$/)
      .meta({ description: "The picture of the template's app, made by the bench: templates/covers/<id>.webp." }),
    blanks: z.array(Blank).min(1).max(8),
    offers: z.array(z.enum(DELIVERY_KINDS)).min(1).meta({ description: "The kinds of offer it may use (design §5)." }),
    scenarios: z.array(Scenario).min(2).meta({ description: "Buy now and the test checkout always, and what the table of §11 adds." }),
    prompt: z.string().min(1).max(4000).meta({ description: "The business, in words, with {{blank}} where the person's answers go." }),
  })
  .superRefine((t, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (t.cover !== `templates/covers/${t.id}.webp`) fail(`the cover of "${t.id}" is templates/covers/${t.id}.webp`);
    if (new Set(t.offers).size !== t.offers.length) fail("a kind of offer is named once");
    if (new Set(t.scenarios).size !== t.scenarios.length) fail("a scenario is named once");
    for (const s of ALWAYS) if (!t.scenarios.includes(s)) fail(`every template offers ${s}`);
    if (new Set(t.blanks.map((b) => b.id)).size !== t.blanks.length) fail("a blank is named once");
    const used = new Set([...t.prompt.matchAll(PLACEHOLDER)].map((m) => m[1]!));
    for (const b of t.blanks) if (!used.has(b.id)) fail(`the prompt never uses the blank "${b.id}"`);
    for (const u of used) if (!t.blanks.some((b) => b.id === u)) fail(`the prompt names "{{${u}}}", which is no blank`);
    if (t.scenarios.includes("promise-to-pay") && !t.offers.some((k) => k === "booking" || k === "order"))
      fail("a promise to pay needs a kind of offer that is collected later: booking or order");
  })
  .meta({ id: "Template", description: "A kind of business, and the scenarios it offers (design §11)." });
export type Template = z.infer<typeof Template>;

/** What an app must hold so that a scenario can run against it: the words the first turn gives the model. */
export const SCENARIO_NEEDS: Record<Scenario, string> = {
  "buy-now": 'at least one offer with "payment": "now"',
  "test-checkout": "at least one offer, whose test checkout the kit serves",
  negotiate: 'at least one offer open to negotiation: it has "limits": {"lowest": …}, below its price',
  "promise-to-pay":
    'at least one offer with "payment": "authorise" (authorise now, collect later: the whole price held in escrow when bought, and collected collectAfterMinutes after), with a collectAfterMinutes and no limits',
  "pay-later":
    'at least one offer with "payment": "deferred" (pay later: the price owed, due when its "due" says; at purchase only 0.000001 USDC is paid, which anchors the agreement on chain), with its "due": {"kind": "booking"} for a booking paid on the day, or {"kind": "days", "days": …}',
};

/** The blanks' answers, keyed by blank id. */
export type Answers = Record<string, string>;

/** The answers with every blank filled: the person's, or else the blank's own example. A blank left empty is its example. */
export function answersOf(t: Template, given: Record<string, unknown>): Answers {
  const out: Answers = {};
  for (const b of t.blanks) {
    const v = given[b.id];
    out[b.id] = typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, 200) : b.example;
  }
  return out;
}

/**
 * The project's first turn: the template's prompt with its blanks filled, then what the app must offer so that the
 * template's scenarios can run: its kinds of offer, and a line for each scenario.
 */
export function firstTurn(t: Template, given: Record<string, unknown>): string {
  const a = answersOf(t, given);
  const business = t.prompt.replace(PLACEHOLDER, (_, id: string) => a[id] ?? "");
  const kinds = t.offers.map((k) => `"${k}"`).join(", ");
  return `${business}

Build this business's app, replacing the example whole.

The app is one of Integra's template "${t.title}". Its offers deliver only these kinds: ${kinds}; use each of them at least once. Its scenarios will be run against the app, one by one, so the app must hold:
${t.scenarios.map((s) => `- ${s}: ${SCENARIO_NEEDS[s]}`).join("\n")}${t.scenarios.includes("negotiate") ? "" : "\nNo offer is open to negotiation: none has limits."}`;
}
