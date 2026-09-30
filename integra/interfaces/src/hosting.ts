/**
 * The hosting (design §12, call 10; the plan's phase 2): publish an app, get its address.
 *
 * Ruled on call 10: Integra hosts every demo a person publishes, unlisted, at `<slug>.<domain>`, and publishing again
 * from its project updates it. Ruled on call 1: the domain is `demos.integraledger.net`, beside `atr.`, `buyer.` and
 * `x402.` (and v3's `services.` and `facilitator.`), whose names no demo may take.
 *
 * Whether it runs on Workers for Platforms or on Dynamic Workers is found out first in phase 2 (design §13, row 13).
 * The interface does not change with the choice: both take a Worker's modules and its static assets.
 *
 * - `POST /publish`: the Studio sends the app's build and its `src/`, over its service binding to the hosting's
 *   `Publisher` entrypoint (`HOSTING_PUBLISHER`) and nowhere else: the hosting's public address refuses it
 *   (`hosting/studio-only`), since a publish puts Worker code on the company's zone. The first publish of a project
 *   picks its slug; every later one updates the same demo. The hosting keeps `src/`, so a new kit can rebuild every
 *   hosted demo with no model call (call 10), and so the gallery can show a demo's source and remix it (phase 4).
 * - `GET /apps/<slug>`: a hosted demo's record, public.
 * - The hosting gives each demo the kit's bindings and the seller credential itself (`KIT_ENV`); nothing the Studio
 *   sends carries a secret.
 * - `GET /apps/<slug>/src`: a hosted demo's latest `src/`, the files it was published with (`HostedSource`), public, for
 *   the gallery's source link and for Remix (phase 4).
 * - Listing in the gallery is Integra's own act, a command run from the repository with Integra's Cloudflare token
 *   (`pnpm gallery list <slug>`), which writes the listing to the hosting's KV namespace (`GALLERY`). There is no route
 *   that lists or unlists. `GET /gallery` answers the listed demos, each with its last batch of scenario runs.
 */
import { z } from "zod";
import { HttpsUrl, IsoTime } from "./common.ts";

/** The domain previews and hosted demos live under (call 1). */
export const DEMOS_DOMAIN = "demos.integraledger.net" as const;

/** The hosting's entrypoint the Studio's service binding names: the only way in for `POST /publish`. */
export const HOSTING_PUBLISHER = "Publisher" as const;

/** Names under the domain that no demo or preview may take. */
export const RESERVED_SLUGS = ["atr", "buyer", "x402", "services", "facilitator"] as const;

/**
 * Every name under the domain that is another Worker's custom domain, as read from the zone on 2026-09-30: v4's
 * services and v3's (`RESERVED_SLUGS`), v3's Studio, and v3's demos; and, by `TAKEN_PATTERN`, every v3 draft,
 * `draft-<n>`, including any v3's Studio makes later. Cloudflare treats a custom domain as the origin behind any route
 * that matches its host, so the wildcard route `*.demos.integraledger.net/*` reaches the front first for these as well
 * (measured). The front hands each to its own Worker untouched, and no demo may take one: ask `isTakenName`.
 */
export const TAKEN_NAMES = [
  ...RESERVED_SLUGS,
  "studio",
  "ashcombe-mill",
  "fernhill-insurance",
  "furrow-frost",
  "kestrel-physiotherapy",
  "kestrel-pictures",
  "oakmoss-tea-co",
  "wren-translate",
] as const;

/** v3's drafts, `draft-01` to `draft-24` today, each its own custom domain. */
export const TAKEN_PATTERN = /^draft-\d+$/;

/** Whether a name under the domain is another Worker's (`TAKEN_NAMES`, `TAKEN_PATTERN`). */
export function isTakenName(label: string): boolean {
  return (TAKEN_NAMES as readonly string[]).includes(label) || TAKEN_PATTERN.test(label);
}

/** A preview's host is `<project id>.demos.integraledger.net`, its project id being `s` + 16 hex. No demo takes one. */
export const PREVIEW_LABEL = /^s[0-9a-f]{16}$/;

/** The one label of a host directly under the domain, lowercased, or null for any other host. */
export function demosLabel(host: string): string | null {
  const h = host.toLowerCase().replace(/\.$/, "");
  const suffix = `.${DEMOS_DOMAIN}`;
  if (!h.endsWith(suffix)) return null;
  const label = h.slice(0, -suffix.length);
  return /^[a-z0-9-]{1,63}$/.test(label) ? label : null;
}

/** A slug: one DNS label, lowercase. */
export const Slug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
export type Slug = z.infer<typeof Slug>;

/** A hosted demo's address: `https://<slug>.demos.integraledger.net/`, at the root of its own host. */
export function hostedUrl(slug: string): string {
  return `https://${slug}.${DEMOS_DOMAIN}/`;
}

/** A project in the Studio: one app. */
export const ProjectId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export type ProjectId = z.infer<typeof ProjectId>;

/** A file, as a path and its bytes in base64. */
export const FileEntry = z.strictObject({
  path: z.string().regex(/^(?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_.@-]+$/).max(512),
  base64: z.string(),
});
export type FileEntry = z.infer<typeof FileEntry>;

/** One module of the app's Worker, as its build wrote it. */
export const WorkerModule = z.strictObject({
  name: z.string().min(1).max(512),
  type: z.enum(["esm", "cjs", "text", "data", "json", "wasm", "sourcemap"]),
  base64: z.string(),
});
export type WorkerModule = z.infer<typeof WorkerModule>;

/** `POST /publish`'s body: the app, built, and its source. */
export const PublishRequest = z.strictObject({
  project: ProjectId,
  slug: Slug.optional().meta({ description: "Asked for on the first publish; the business's name, as a slug, when absent." }),
  build: z.strictObject({
    mainModule: z.string().min(1),
    modules: z.array(WorkerModule).min(1),
    assets: z.array(FileEntry).meta({ description: "The static assets, by path from the root of the site." }),
    compatibilityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    compatibilityFlags: z.array(z.string()),
  }),
  src: z.array(FileEntry).min(1).meta({ description: "The app's src/, by path within it." }),
});
export type PublishRequest = z.infer<typeof PublishRequest>;

/** A hosted demo. `listed` is true only for the gallery's, which Integra lists itself. */
export const HostedApp = z.strictObject({
  slug: Slug,
  url: HttpsUrl,
  project: ProjectId,
  version: z.int().min(1),
  publishedAt: IsoTime,
  listed: z.boolean(),
});
export type HostedApp = z.infer<typeof HostedApp>;

/** `POST /publish` answers `200` with the hosted demo; `GET /apps/<slug>` answers the same. */
export const PublishAnswer = HostedApp;
export type PublishAnswer = HostedApp;

/** `GET /apps/<slug>/src`: the `src/` the demo's latest version was published with, each file by its path within `src/`. */
export const HostedSource = z.strictObject({
  slug: Slug,
  version: z.int().min(1),
  files: z.array(FileEntry).min(1),
});
export type HostedSource = z.infer<typeof HostedSource>;

/** One scenario's run against the demo's published address, as the gallery keeps it. */
export const GalleryRun = z.strictObject({
  scenario: z.enum(["buy-now", "test-checkout", "negotiate", "promise-to-pay", "pay-later"]),
  offer: z.strictObject({ id: z.string(), name: z.string(), kind: z.string(), price: z.string(), payment: z.string() }).nullable(),
  run: z.string().nullable().meta({ description: "The buyer service's run id; null when no offer allows the scenario." }),
  verdict: z.enum(["proves", "does-not-prove", "not-run"]),
  reasons: z.array(z.string()),
  outcome: z.string().nullable(),
  transaction: z.strictObject({ hash: z.string(), url: HttpsUrl }).nullable(),
  capture: z.strictObject({ hash: z.string(), url: HttpsUrl }).nullable(),
  proof: HttpsUrl.nullable(),
  record: HttpsUrl.nullable().meta({ description: "The buyer service's record of the run." }),
});
export type GalleryRun = z.infer<typeof GalleryRun>;

/** A listed demo, as the command writes it and the hosting answers it: what it sells, and its last batch of runs. */
export const Listing = z.strictObject({
  slug: Slug,
  name: z.string(),
  line: z.string(),
  template: z.string().nullable().meta({ description: "The template its project began from; null for a demo made by Integra from its own words." }),
  listedAt: IsoTime,
  offers: z.array(z.strictObject({ name: z.string(), kind: z.string(), price: z.string(), payment: z.string() })),
  batch: z
    .strictObject({ at: IsoTime, address: HttpsUrl, runs: z.array(GalleryRun) })
    .nullable()
    .meta({ description: "The last batch of scenario runs, against the demo's published address; a listing keeps its last." }),
});
export type Listing = z.infer<typeof Listing>;

/** `GET /gallery`: every listed demo, by slug. */
export const GalleryAnswer = z.strictObject({ demos: z.array(Listing) });
export type GalleryAnswer = z.infer<typeof GalleryAnswer>;

export const HOSTING_ROUTES = {
  publish: { method: "POST", path: "/publish" },
  app: { method: "GET", path: "/apps/:slug" },
  source: { method: "GET", path: "/apps/:slug/src" },
  gallery: { method: "GET", path: "/gallery" },
} as const;

export const HOSTING_REFUSALS = {
  "hosting/malformed": { status: 400, sentence: "The request is not a PublishRequest." },
  "hosting/slug-taken": { status: 409, sentence: "Another project's demo has this slug." },
  "hosting/slug-reserved": { status: 409, sentence: "This name is reserved under the domain." },
  "hosting/studio-only": { status: 403, sentence: "A demo is published only through Integra's Studio." },
  "hosting/not-found": { status: 404, sentence: "No demo is hosted at this slug." },
} as const satisfies Record<string, { status: number; sentence: string }>;
export type HostingRefusalCode = keyof typeof HOSTING_REFUSALS;
