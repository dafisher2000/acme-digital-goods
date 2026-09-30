/**
 * `@demo-factory/interfaces`: every interface of demo-factory v4, as code (the plan's phase 0).
 *
 * One source of truth, Zod 4, yields the TypeScript types, the runtime validator (`check`, which runs in a Worker) and
 * the JSON Schema files in `schemas/` (see `validate.ts`). Each area is its own module, named for the design's section.
 */
export * from "./common.ts";
export * from "./validate.ts";
export * from "./demonstration.ts";
export * from "./network.ts";
export * from "./price.ts";
export * from "./services.ts";
export * from "./agreement-store.ts";
export * from "./x402.ts";
export * from "./facilitator.ts";
export * from "./business.ts";
export * from "./storefront.ts";
export * from "./agreement.ts";
export * from "./events.ts";
export * from "./negotiation.ts";
export * from "./checkout.ts";
export * from "./routes.ts";
export * from "./buyer.ts";
export * from "./template.ts";
export * from "./hosting.ts";
export * from "./kit.ts";
export { SCHEMAS, type SchemaName } from "./schemas.ts";
