/**
 * v4's facilitator (design §12), at `x402.demos.integraledger.net`: x402's `/verify` and `/settle` for `exact` and
 * `auth-capture` on Base Sepolia, `/supported`, and the capture from the escrow, on request. It settles and captures
 * only to the treasury, and pays gas from a wallet of its own. v3's `services/facilitator` is the example (R5 §3).
 *
 * `/verify`, `/settle` and `/supported` are x402's own (core spec §7), so their bodies are `x402.ts`'s. Any origin may
 * call any route, with no credential (R5 §3; design §15).
 *
 * **The capture.** The kit's promise to pay is an `auth-capture` option with `operatorType` `"delegated"` and no
 * `receiverAuthorizer`: the facilitator's wallet is the operator, and the salt is H, unbound. The published binding
 * says of that case: *"`"delegated"` is authorize-only: the facilitator may relay `authorize`, but MUST reject
 * `charge` and `payload.type` of `"capture"`, `"void"`, or `"refund"`. Later lifecycle operations run out of band under
 * the operator's own rules"*, and such an option's `captureMode` MUST be `"deferred"` (auth-capture EVM binding,
 * "Operator types" and "`extra` fields"). So the capture is the facilitator's own route, `POST /capture`, as v3's
 * was (design §3.6).
 */
import { z } from "zod";
import { Address, Caip2, TransactionHash, Uint256String } from "./common.ts";
import { NETWORK } from "./network.ts";
import { SERVICE_ORIGINS } from "./services.ts";
import {
  FacilitatorRequest,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
  type SupportedKind,
} from "./x402.ts";

export const FACILITATOR_URL = SERVICE_ORIGINS.facilitator;

/** The facilitator's routes. */
export const FACILITATOR_ROUTES = {
  supported: { method: "GET", path: "/supported" },
  verify: { method: "POST", path: "/verify" },
  settle: { method: "POST", path: "/settle" },
  capture: { method: "POST", path: "/capture" },
  health: { method: "GET", path: "/health" },
} as const;

/** The kinds v4's facilitator supports: `exact` and `auth-capture`, on Base Sepolia, x402 version 2. */
export const FACILITATOR_KINDS = [
  { x402Version: 2, scheme: "exact", network: NETWORK },
  { x402Version: 2, scheme: "auth-capture", network: NETWORK },
] as const satisfies readonly SupportedKind[];

/** `POST /verify`: read-only; commits nothing, writes nothing on chain (core §7.1). */
export const VerifyRequest = FacilitatorRequest;
export type VerifyRequest = FacilitatorRequest;
export { VerifyResponse };

/**
 * `POST /settle`. For `exact`, it calls USDC's `transferWithAuthorization`. For `auth-capture`, it calls the escrow's
 * `authorize`: the payment is held in escrow, and captured later by `POST /capture`. When it cannot establish the
 * receipt in its own wait, it answers `success: false` with `errorReason: "settlement_pending"` and the broadcast
 * transaction (core §9).
 */
export const SettleRequest = FacilitatorRequest;
export type SettleRequest = FacilitatorRequest;
export { SettleResponse };

/** `GET /supported`: `FACILITATOR_KINDS`, no extensions, and the facilitator's wallet under `"eip155:*"`. */
export { SupportedResponse };

/**
 * `POST /capture`: capture, in full, a payment this facilitator authorized into the escrow. `transaction` is the
 * `authorize` transaction its `/settle` answered. It reads the escrow's `PaymentAuthorized` log from that
 * transaction's receipt, and captures only when the operator is its own wallet, the token is USDC and the receiver is
 * the treasury. The fee is the payment's `minFeeBps`, to the payment's fee receiver; the kit sets both fee rates to 0,
 * with the treasury as receiver (design §3.3, §3.6).
 */
export const CaptureRequest = z.strictObject({
  network: z.literal(NETWORK),
  transaction: TransactionHash,
});
export type CaptureRequest = z.infer<typeof CaptureRequest>;

/**
 * The capture's answer, in the form of a `SettleResponse`, with the amount captured. A capture that the escrow would
 * refuse (already captured, voided, or past its deadline) is `success: false` with `invalid_transaction_state`; an
 * `authorize` transaction with no `PaymentAuthorized` log is `authorization_not_found`; a payment whose operator,
 * token or receiver is not the facilitator's own, USDC and the treasury is `invalid_payment_requirements`. A capture
 * broadcast and not yet confirmed is `settlement_pending`, with its transaction.
 */
export const CaptureResponse = z.looseObject({
  success: z.boolean(),
  errorReason: z.string().optional(),
  transaction: z.string(),
  network: Caip2,
  payer: Address.optional(),
  amount: Uint256String.optional(),
});
export type CaptureResponse = z.infer<typeof CaptureResponse>;

/** The capture's own error reason, beside x402's: no `PaymentAuthorized` log in the named transaction. */
export const AUTHORIZATION_NOT_FOUND = "authorization_not_found" as const;

/** `GET /health`: whether the Worker answers, with the facilitator's wallet. */
export const FacilitatorHealth = z.strictObject({
  ok: z.literal(true),
  service: z.literal("facilitator"),
  network: z.literal(NETWORK),
  signer: Address,
});
export type FacilitatorHealth = z.infer<typeof FacilitatorHealth>;
