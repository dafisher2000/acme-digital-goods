// A seam whose owner fills it in phase 1 throws this, so that nothing pretends to work before it does.
export function notBuilt(what: string): never {
  throw new Error(`${what}: not built yet (phase 1)`);
}
