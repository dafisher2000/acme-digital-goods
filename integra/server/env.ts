// The environment every part of the kit's server reads, and the one `KitContext` the router builds per request.
// The names are @demo-factory/interfaces' (KIT_BINDINGS, KIT_SECRETS, KIT_VARS); the types are Cloudflare's.
//
// Two secrets: `SELLER_CREDENTIAL`, the shared tenant's (design §12, step 4), and `RPC_URL`, the Base Sepolia node the
// app reads the chain through, whose URL carries a provider's key. Without `RPC_URL` the app reads the public endpoint.
import business from "integra:server/business";
import goodsFiles from "integra:server/goods";
import { PUBLIC_RPC_URL, STORE_NAME, type KitContext, type KitGoods, type KitStore } from "@demo-factory/interfaces";
import type { IntegraStore } from "./store/index.ts";

export interface Env {
  STORE: DurableObjectNamespace<IntegraStore>;
  AI: Ai;
  ASSETS: Fetcher;
  SELLER_CREDENTIAL: string;
  SELLER_MODEL: string;
  ANSWER_MODEL: string;
  RPC_URL?: string;
}

const MEDIA_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  html: "text/html; charset=utf-8",
  json: "application/json",
  csv: "text/csv; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  zip: "application/zip",
  epub: "application/epub+zip",
};

const goods: KitGoods = {
  get: (path) => goodsFiles[path] ?? null,
  mediaType: (path) => MEDIA_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream",
};

/**
 * A context for the app at `origin`, over `store`. The router passes the store's RPC stub; the store's own alarm passes
 * the store itself, so the checkout's steps run there with the same seams (design §3.4).
 */
export function contextFor(env: Env, origin: string, store: KitStore, waitUntil: (p: Promise<unknown>) => void): KitContext {
  return {
    business,
    goods,
    origin,
    host: new URL(origin).host,
    store,
    ai: env.AI as unknown as KitContext["ai"],
    assets: env.ASSETS,
    sellerCredential: env.SELLER_CREDENTIAL,
    settings: { sellerModel: env.SELLER_MODEL, answerModel: env.ANSWER_MODEL, rpcUrl: env.RPC_URL || PUBLIC_RPC_URL },
    waitUntil,
  };
}

/** The store's stub: its methods are called by Durable Object RPC, and `/api/events` is its `fetch`. */
export function storeStub(env: Env): DurableObjectStub<IntegraStore> {
  return env.STORE.get(env.STORE.idFromName(STORE_NAME));
}

export function kitContext(request: Request, env: Env, ctx: ExecutionContext): KitContext {
  const stub = storeStub(env);
  return contextFor(env, new URL(request.url).origin, stub as unknown as KitStore, (promise) => ctx.waitUntil(promise));
}
