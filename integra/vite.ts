// The kit's build plug-in (design §2.2). It serves four virtual modules and makes four refusals:
//
//   integra:server/business   src/business.json, checked, `limits` included. The Worker's only.
//   integra:server/goods      every file of src/goods/, as bytes inside the Worker. The Worker's only.
//   integra:business          src/business.json with every `limits` taken out (`publicBusiness`). The page's.
//   integra:ui                the kit's storefront pieces, and only those (design §2.3): <Buy> and <Purchases>.
//
//   - business.json is checked against the schema, and against the rules that span fields, at every build;
//   - every file business.json names must exist in src/goods/;
//   - a page that imports business.json itself is refused (rule 3), and so is one that imports a file of src/goods/,
//     which would put it among the static files anyone can fetch (rule 2);
//   - the page's build is refused if any file of it holds a seller's limit;
//   - the server's two modules are refused to the page's build, so the limits and the goods cannot reach a browser.
//
// It also writes the page's head from the business: its title, its description and its product JSON-LD (design §9).
//
// In development, the modules made from business.json and src/goods/ are always made from the files as they are when a
// request is answered, whatever order the files were written in (`fresh`). A build reports the files of src/ that
// nothing uses (`unused`).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Plugin, ViteDevServer } from "vite";
import {
  BUSINESS_MODULE,
  FRESH_LOG,
  SERVER_MODULES,
  UNUSED_REPORT,
  checkBusiness,
  describeProblems,
  goodsFilesOf,
  publicBusiness,
  type Business,
} from "@demo-factory/interfaces";
import { productJsonLdText } from "./server/agent/jsonld.ts";

const UI_MODULE = "integra:ui" as const;
const VIRTUAL = new Set<string>([SERVER_MODULES.business, SERVER_MODULES.goods, BUSINESS_MODULE, UI_MODULE]);
/** The modules made from business.json and src/goods/, by their ids in a module graph. */
const MADE = [SERVER_MODULES.business, SERVER_MODULES.goods, BUSINESS_MODULE].map((name) => "\0" + name);

const here = path.dirname(fileURLToPath(import.meta.url));
/** The interfaces' sources, found through the workspace package, wherever the app is built from. */
const interfacesSrc = path.dirname(createRequire(import.meta.url).resolve("@demo-factory/interfaces"));

/** Every file under `dir`, as its path from `dir` with `/`, sorted; none when `dir` is absent. */
function walk(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, `${prefix}${name}/`));
    else out.push(`${prefix}${name}`);
  }
  return out;
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function integra(): Plugin {
  let root = process.cwd();
  let businessFile = "";
  let goodsDir = "";

  /**
   * The files the modules made from business.json and src/goods/ are made from, as they are on disk now: each file's
   * size and time of change. Two stamps differ when any of them was written, added or removed.
   */
  function stamp(): string {
    const of = (file: string) => {
      try {
        const s = statSync(file);
        return `${s.size}:${s.mtimeMs}`;
      } catch {
        return "none";
      }
    };
    return [of(businessFile), ...walk(goodsDir).map((file) => `${file}=${of(path.join(goodsDir, file))}`)].join("|");
  }
  /** For each such module, per environment: the stamp of the files its latest load began reading, failed or not. */
  const loaded = new Map<string, string>();
  /** The stamp each was last made to load again for, so that one change is acted on once. */
  const renewed = new Map<string, string>();
  const key = (environment: string, id: string) => `${environment}\n${id}`;

  /**
   * Every module made from business.json and src/goods/ whose latest load read files other than those on disk now is
   * made to load again, in every environment, before the request that asked goes on.
   *
   * Vite reloads them on each write it is told of, and that alone can leave the Worker on old files, measured in the
   * Studio's candle studio (turn 8): business.json written, naming a goods file written 2.3 s later, and the Worker kept
   * failing on the missing file until the next write. Vite gives three ways for it: a write that lands while one of these
   * modules is loading is taken as a reload, so the load's result from the old files is kept (Vite keeps a result unless
   * the module was invalidated other than by a hot update); a failed load leaves the modules that import it failed in the
   * Worker's module runner, which answers with that failure for as long as their transforms stay cached; and a write the
   * watcher does not report is never acted on. Checked here instead, each request is answered from the files as they are.
   * Invalidated not as a hot update, so that a load still running from the old files is not kept either.
   */
  function fresh(server: ViteDevServer): void {
    const now = stamp();
    for (const environment of Object.values(server.environments)) {
      const graph = environment.moduleGraph;
      const stale = MADE.flatMap((id) => {
        const mod = graph.getModuleById(id);
        if (mod === undefined) return [];
        const k = key(environment.name, id);
        const last = loaded.get(k);
        if (last === undefined || last === now || renewed.get(k) === now) return [];
        renewed.set(k, now);
        return [mod];
      });
      if (stale.length === 0) continue;
      // Kept from files since changed: what Vite would have answered with. (Otherwise a hot update is already on its way.)
      const kept = stale.filter((mod) => mod.transformResult !== null).map((mod) => mod.id!.slice(1));
      const seen = new Set<(typeof stale)[number]>();
      for (const mod of stale) graph.invalidateModule(mod, seen, Date.now(), false);
      // A page open on the preview is reloaded; the Worker takes the modules again at its next import, this request's.
      if (environment.name === "client" && kept.length > 0) environment.hot.send({ type: "full-reload", path: "*" });
      if (kept.length > 0) {
        const line = `integra: ${kept.join(", ")} (${environment.name}) had been made from files since changed, and are made again`;
        server.config.logger.info(line, { timestamp: true });
        mkdirSync(path.join(root, path.dirname(FRESH_LOG)), { recursive: true });
        appendFileSync(path.join(root, FRESH_LOG), `${new Date().toISOString()} ${line}\n`);
      }
    }
  }

  /** `src/business.json`, checked, or the build stops with every problem found. */
  function business(context: { error(message: string): never }): Business {
    if (!existsSync(businessFile)) context.error(`integra: ${businessFile} does not exist.`);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(businessFile, "utf8"));
    } catch (e) {
      context.error(`integra: business.json is not JSON: ${(e as Error).message}`);
    }
    const checked = checkBusiness(raw);
    if (!checked.ok) context.error(`integra: business.json is not valid:\n${describeProblems(checked.problems)}`);
    const goods = new Set(walk(goodsDir));
    const missing = goodsFilesOf(checked.value).filter((file) => !goods.has(file));
    if (missing.length > 0) context.error(`integra: business.json names files that are not in src/goods/: ${missing.join(", ")}`);
    return checked.value;
  }

  return {
    name: "integra",
    enforce: "pre",

    // The page imports a few constants of the interfaces (the demonstration sentence, the price scale, the network and
    // the services' addresses) from their own modules: the interfaces' barrel would put every schema, business.ts among
    // them, in the page's files. Its types are imported from the barrel, and are erased.
    config() {
      return {
        resolve: {
          alias: [
            {
              find: /^@demo-factory\/interfaces\/(demonstration|network|price|services)$/,
              replacement: path.join(interfacesSrc, "$1.ts"),
            },
          ],
        },
      };
    },

    configResolved(config) {
      root = config.root;
      businessFile = path.join(root, "src", "business.json");
      goodsDir = path.join(root, "src", "goods");
    },

    buildStart() {
      business(this); // the check at every build (design §2.2)
      this.addWatchFile(businessFile);
    },

    async resolveId(source, importer, options) {
      if (VIRTUAL.has(source)) {
        if (source === UI_MODULE) return path.join(here, "ui", "index.ts");
        // The server's modules are the Worker's only: the page's build, and the dev page, never get them.
        if ((source === SERVER_MODULES.business || source === SERVER_MODULES.goods) && this.environment.name === "client") {
          this.error(`integra: ${source} is the server's, and a page may not import it (design §2.2).`);
        }
        return "\0" + source;
      }
      const bare = source.replace(/[?#].*$/, "");
      // The plug-in's own modules depend on business.json and the goods (`load`), and are not pages.
      if (importer && !importer.startsWith("\0integra:") && (/(^|\/)business\.json$/.test(bare) || /(^|\/)goods\//.test(bare))) {
        const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
        const id = resolved?.id.replace(/[?#].*$/, "");
        if (id === businessFile) {
          this.error(
            `integra: ${path.relative(root, importer)} imports business.json. A page gets the business from "${BUSINESS_MODULE}", which has no limits (design §2.2, rule 3).`,
          );
        }
        if (id && id.startsWith(goodsDir + path.sep) && this.environment.name === "client") {
          this.error(
            `integra: ${path.relative(root, importer)} imports ${path.relative(root, id)}. src/goods/ is delivered by the server after payment, never among the static files (design §2.2, rule 2).`,
          );
        }
      }
      return null;
    },

    // Before the dev server answers any request, the modules made from business.json and src/goods/ are made from the
    // files as they are (`fresh`). A stat of each: about a dozen files.
    configureServer(server) {
      server.middlewares.use((_request, _response, next) => {
        try {
          fresh(server);
        } catch (e) {
          server.config.logger.error(`integra: ${(e as Error).message}`);
        }
        next();
      });
    },

    load(id) {
      if (!id.startsWith("\0integra:")) return null;
      const name = id.slice(1);
      // What this load reads, stamped before it reads it: a write while it reads makes the stamp old, not the module.
      if (MADE.includes(id)) loaded.set(key(this.environment.name, id), stamp());
      // Each module made from business.json depends on it, so a write to it reloads the page and the Worker.
      this.addWatchFile(businessFile);
      const value = business(this);
      if (name === SERVER_MODULES.business) return `export default ${JSON.stringify(value)};`;
      if (name === BUSINESS_MODULE) return `export const business = ${JSON.stringify(publicBusiness(value))};`;
      if (name === SERVER_MODULES.goods) {
        const entries = walk(goodsDir).map((file) => {
          const full = path.join(goodsDir, file);
          this.addWatchFile(full);
          return `  ${JSON.stringify(file)}: bytes(${JSON.stringify(readFileSync(full).toString("base64"))}),`;
        });
        return [
          `const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));`,
          `export default {`,
          ...entries,
          `};`,
        ].join("\n");
      }
      return null;
    },

    // In development, a write to business.json or to any file of src/goods/ reloads every module made from them, in the
    // page and in the Worker. A file added to src/goods/ is in no module's graph yet, so the modules are named here: the
    // model may write business.json before the file it names.
    //
    // A module of the storefront that was removed is not hot-updated: Vite would fetch it again, get the page's HTML in
    // its place, and log "Failed to reload" for a page the app no longer has. Its importers were changed by the same
    // reply, which the Studio applies to the app at once (a page that still imports it is what the Studio's check finds).
    hotUpdate({ type, file, modules }) {
      if (type === "delete" && file.startsWith(path.join(root, "src") + path.sep) && file !== businessFile && !file.startsWith(goodsDir + path.sep)) return [];
      if (file !== businessFile && !file.startsWith(goodsDir + path.sep)) return;
      const made = [...VIRTUAL].flatMap((name) => this.environment.moduleGraph.getModuleById("\0" + name) ?? []);
      return [...new Set([...modules, ...made])];
    },

    transformIndexHtml: {
      order: "pre",
      handler(html) {
        const pub = publicBusiness(business(this as unknown as { error(message: string): never }));
        const head =
          `<title>${escapeHtml(pub.name)}</title>\n    <meta name="description" content="${escapeHtml(pub.line)}" />\n` +
          `    <script type="application/ld+json">${productJsonLdText(pub)}</script>`;
        return html.replace(/<title>[^<]*<\/title>/, head);
      },
    },

    // The seller's limits never reach a browser (rule 3): the page's build is refused if any file of it holds one.
    generateBundle(_options, bundle) {
      if (this.environment.name !== "client") return;
      const value = business(this);
      const secrets = value.offers.flatMap((offer) => (offer.limits ? [offer.limits.lowest] : []));
      for (const file of Object.values(bundle)) {
        const text = file.type === "chunk" ? file.code : typeof file.source === "string" ? file.source : "";
        if (/"limits"\s*:|\blimits\s*:\s*\{/.test(text) || secrets.some((lowest) => text.includes(`"lowest":"${lowest}"`))) {
          this.error(`integra: ${file.fileName} holds a seller's limit, and would reach a browser (design §2.2, rule 3).`);
        }
      }

      // The files of src/ that nothing uses, reported beside the build for the Studio's check, and said here.
      const reached = [...this.getModuleIds()].map((id) => id.replace(/[?#].*$/, ""));
      const unused = unusedFiles(root, value, reached);
      mkdirSync(path.join(root, path.dirname(UNUSED_REPORT)), { recursive: true });
      writeFileSync(path.join(root, UNUSED_REPORT), JSON.stringify({ unused }, null, 2) + "\n");
      if (unused.length > 0) this.warn(`integra: nothing in the app uses ${unused.join(", ")}.`);
    },
  };
}

/**
 * A file of src/ that a page or style names by a relative path, or by `/src/…`: an import (`import type` too), a
 * dynamic import, a style's `@import` or `url(…)`.
 */
const REFERENCE = /(?:\bfrom\s*|\bimport\s*\(?\s*|@import\s+(?:url\(\s*)?|\burl\(\s*|\brequire\(\s*)["'`]?((?:\.{1,2}|\/src)\/[^"'`)\s?#;]+)/g;
const TEXT = /\.(?:[cm]?[jt]sx?|css)$/;
const RESOLVE = ["", ".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts", "/index.jsx", "/index.js"];

/**
 * The files of `src/` that nothing uses, as paths from the app's root. Used are:
 * - every file of `src/` in the page's build: what `src/App.tsx`, which the kit's shell imports, reaches by its imports,
 *   pictures and styles among them;
 * - every file such a file names by path, and so on from those: a module imported only for its types, which the build
 *   erases, and a file a style names in `url(…)`;
 * - by the kit's convention: `src/business.json`, which the kit reads; each file of `src/goods/` that business.json
 *   names, which the server delivers; `src/theme.css`, the look, which the Look panel writes; and a `.d.ts` file, which
 *   only declares types.
 * Everything else is unused: a page no route reaches, a file of `src/goods/` no offer delivers, a note.
 */
export function unusedFiles(root: string, business: Business, reached: string[]): string[] {
  const src = path.join(root, "src");
  const all = walk(src).map((file) => path.join(src, file));
  const used = new Set<string>([path.join(src, "business.json"), path.join(src, "theme.css"), ...goodsFilesOf(business).map((file) => path.join(src, "goods", file))]);
  for (const file of all) if (file.endsWith(".d.ts")) used.add(file);
  const inside = (file: string) => file.startsWith(src + path.sep) && existsSync(file) && statSync(file).isFile();
  const queue = [...reached.filter(inside), ...[...used].filter(inside)];
  const scanned = new Set<string>();
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (scanned.has(file)) continue;
    scanned.add(file);
    used.add(file);
    if (!TEXT.test(file)) continue;
    for (const m of readFileSync(file, "utf8").matchAll(REFERENCE)) {
      const named = m[1]!.startsWith("/src/") ? path.join(root, m[1]!) : path.resolve(path.dirname(file), m[1]!);
      const found = RESOLVE.map((ext) => named + ext).find(inside);
      if (found !== undefined && !scanned.has(found)) queue.push(found);
    }
  }
  return all.filter((file) => !used.has(file)).map((file) => path.relative(root, file).split(path.sep).join("/"));
}
