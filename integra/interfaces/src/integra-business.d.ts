// The storefront's view of `integra:business` (design §2.3), which the kit's build plug-in serves from
// `business.json` with every `limits` taken out. A storefront's tsconfig lists this file in `types`, or a file of the
// app references it: `/// <reference types="@demo-factory/interfaces/integra-business" />`.
declare module "integra:business" {
  export const business: import("@demo-factory/interfaces").PublicBusiness;
}
