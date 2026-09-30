// The storefront's view of `integra:ui` (design §2.3): the kit's two pieces, and no more. The kit's build plug-in serves
// the module; a page that imports from it type-checks against this.
declare module "integra:ui" {
  export { Buy, Purchases } from "./index.ts";
}
