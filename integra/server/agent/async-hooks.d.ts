// The one Node module the agent door uses, which Workers serve under `nodejs_compat`: the starter's server is typed
// with the Workers types only, so its shape is declared here, as Node documents it.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => R): R;
    getStore(): T | undefined;
  }
}
