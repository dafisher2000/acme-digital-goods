/**
 * v4's own services (design §12), their names, and the one shared tenant they serve.
 *
 * Ruled by Fisher, 2026-09-29 (late), on call 2: the one-time setup, with the names `atr.`, `buyer.` and
 * `x402.demos.integraledger.net`. Ruled on the appliance: shared, in connector mode, on the shared tenant.
 */

/** The agreement store, the buyer service and the facilitator: each a Worker of its own, at its own host (call 2). */
export const SERVICE_HOSTS = {
  agreementStore: "atr.demos.integraledger.net",
  buyer: "buyer.demos.integraledger.net",
  facilitator: "x402.demos.integraledger.net",
} as const;

/** Each service's origin. */
export const SERVICE_ORIGINS = {
  agreementStore: `https://${SERVICE_HOSTS.agreementStore}`,
  buyer: `https://${SERVICE_HOSTS.buyer}`,
  facilitator: `https://${SERVICE_HOSTS.facilitator}`,
} as const;

/**
 * The shared tenant's one resource, which every app issues under (design §3.3, step 4; §12, step 3). A connector-only
 * resource: it has no `front`, so it needs no decision seam (R1 §2).
 */
export const TENANT_RESOURCE = "demo" as const;

/**
 * The two pairings the resource serves (design §12, step 3; R1 §2), by scheme: x402 `exact` and x402 `auth-capture`,
 * both by EIP-3009 on Base Sepolia. `pairingOf` names each way an offer is paid (design §2.6) to its pairing.
 */
export const PAIRINGS = {
  exact: "x402/exact/eip155/eip3009",
  authCapture: "x402/auth-capture/eip155/eip3009",
} as const;
export type Pairing = (typeof PAIRINGS)[keyof typeof PAIRINGS];

/**
 * The pairing of each way an offer is paid: `now` and `deferred` (pay later, whose anchoring payment is an ordinary
 * `exact` transfer, design §3.9) are `exact`; `authorise` (the escrow's authorise now, collect later, §3.6) is
 * `auth-capture`.
 */
export function pairingOf(payment: "now" | "authorise" | "deferred"): Pairing {
  return payment === "authorise" ? PAIRINGS.authCapture : PAIRINGS.exact;
}

/** The appliance's seller door, which every app calls in connector mode (R1 §1; its `openapi.json` is public). */
export const SELLER_DOOR_URL = "https://appliance-seller.integraledger.net" as const;

/**
 * v4's three wallets, as the one-time setup minted them on 2026-09-29 (design §12, step 1; their public addresses
 * are in `/srv/integra/state/v4/2026-09-29-wallet-addresses.txt`). Each key is a secret of the one Worker that uses it.
 * - `treasury`: receives every payment. It is every option's `payTo`, and a promise to pay's `feeRecipient`.
 * - `buyer`: the shared buyer wallet, which signs only inside the buyer service's `pay` (call 6).
 * - `facilitator`: the facilitator's wallet. It pays the gas, and is every promise to pay's `captureAuthorizer`.
 */
export const WALLETS = {
  treasury: "0x4F098166790DeaBb92c2Ef4516D8C1ab88A12C6B",
  buyer: "0x322649AebaBe9EDdAc283cEA2641F9b279492c2E",
  facilitator: "0x5635F3146757a5ff300E0FcAfd20776aF2FBd716",
} as const;
