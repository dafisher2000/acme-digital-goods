// The app's server: it hands every request to the kit (design §2.1), and exports the store's Durable Object class.
import { handle } from "./integra/server/index.ts";
import type { Env } from "./integra/server/env.ts";

export { IntegraStore } from "./integra/server/store/index.ts";

export default {
  fetch: handle,
} satisfies ExportedHandler<Env>;
