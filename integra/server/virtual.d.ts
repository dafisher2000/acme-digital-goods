// The server's virtual modules, served by the kit's build plug-in (SERVER_MODULES in @demo-factory/interfaces).
declare module "integra:server/business" {
  const business: import("@demo-factory/interfaces").Business;
  export default business;
}

declare module "integra:server/goods" {
  const goods: Record<string, Uint8Array>;
  export default goods;
}
