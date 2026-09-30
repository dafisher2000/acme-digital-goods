/**
 * x402 version 2, as published (`x402-foundation/x402`, `specs/x402-specification-v2.md`, last changed 2026-08-31;
 * `specs/transports-v2/http.md` and `mcp.md`; `specs/schemes/auth-capture/scheme_auth_capture_evm.md` v1.1; R3 §1–§2).
 * These are the published wire shapes, and nothing of v4's own.
 *
 * Objects received from others are read loosely: a member x402 does not name is kept, not refused, because x402 is
 * extended by adding members. The two options v4 itself issues are in `checkout.ts`.
 */
import { z } from "zod";
import { Address, AtrHash, Bytes32, Caip2, Hex, HttpsUrl, JsonObject, Uint256String } from "./common.ts";

export const X402_VERSION = 2 as const;

// ---------------------------------------------------------------------------------------------------------------------
// Core types (core spec §5)
// ---------------------------------------------------------------------------------------------------------------------

/** `ResourceInfo`: the protected resource (core §5.1.2). Other members are kept (the auth-capture example adds `method`). */
export const ResourceInfo = z.looseObject({
  url: z.string().min(1).max(2048),
  description: z.string().optional(),
  mimeType: z.string().optional(),
  serviceName: z.string().regex(/^[ -~]{1,32}$/).optional(),
  tags: z.array(z.string().regex(/^[ -~]{1,32}$/)).max(5).optional(),
  iconUrl: z.string().regex(/^https?:\/\//).max(2048).optional(),
});
export type ResourceInfo = z.infer<typeof ResourceInfo>;

/** One extension's value: `{info, schema}`, where `schema` is the JSON Schema of `info` (core §5.1.2). */
export const Extension = z.looseObject({ info: JsonObject, schema: JsonObject });
export type Extension = z.infer<typeof Extension>;

/** The `extensions` map: extension id → `{info, schema}`. x402 keeps no register of ids (R3 §2). */
export const Extensions = z.record(z.string(), Extension);
export type Extensions = z.infer<typeof Extensions>;

/** `PaymentRequirements`, any scheme (core §5.1.2). `extra`'s reserved keys are `assetTransferMethod` and `paymentFlow`. */
export const PaymentRequirements = z.looseObject({
  scheme: z.string().min(1),
  network: Caip2,
  amount: Uint256String,
  asset: z.string().min(1),
  payTo: z.string().min(1),
  maxTimeoutSeconds: z.int().positive(),
  extra: JsonObject.optional(),
});
export type PaymentRequirements = z.infer<typeof PaymentRequirements>;

/** `PaymentRequired`: the challenge (core §5.1). lcp's `advertise` allows at most 32 options (R1 §3). */
export const PaymentRequired = z.looseObject({
  x402Version: z.literal(X402_VERSION),
  error: z.string().optional(),
  resource: ResourceInfo,
  accepts: z.array(PaymentRequirements).min(1).max(32),
  extensions: Extensions.optional(),
});
export type PaymentRequired = z.infer<typeof PaymentRequired>;

/** `PaymentPayload`: the payment (core §5.2). `payload` is the scheme's. */
export const PaymentPayload = z.looseObject({
  x402Version: z.literal(X402_VERSION),
  resource: ResourceInfo.optional(),
  accepted: PaymentRequirements,
  payload: JsonObject,
  extensions: Extensions.optional(),
});
export type PaymentPayload = z.infer<typeof PaymentPayload>;

/** `SettleResponse` (core §5.3). `transaction` is `""` when nothing was broadcast, and never empty on `settlement_pending`. */
export const SettleResponse = z.looseObject({
  success: z.boolean(),
  errorReason: z.string().optional(),
  payer: z.string().optional(),
  transaction: z.string(),
  network: Caip2,
  amount: Uint256String.optional(),
  extensions: Extensions.optional(),
});
export type SettleResponse = z.infer<typeof SettleResponse>;

/** `VerifyResponse` (core §5.4). */
export const VerifyResponse = z.looseObject({
  isValid: z.boolean(),
  invalidReason: z.string().optional(),
  payer: z.string().optional(),
  extensions: Extensions.optional(),
  extra: JsonObject.optional(),
});
export type VerifyResponse = z.infer<typeof VerifyResponse>;

/**
 * The error codes of the core spec (§9). A facilitator or a scheme may add its own, such as auth-capture's
 * `invalid_auth_capture_evm_*`, so an `errorReason` is read as any string.
 */
export const X402_ERROR_REASONS = [
  "insufficient_funds",
  "invalid_exact_evm_payload_authorization_valid_after",
  "invalid_exact_evm_payload_authorization_valid_before",
  "invalid_exact_evm_payload_authorization_value_mismatch",
  "invalid_exact_evm_payload_signature",
  "invalid_exact_evm_payload_recipient_mismatch",
  "invalid_network",
  "invalid_payload",
  "invalid_payment_requirements",
  "invalid_scheme",
  "unsupported_scheme",
  "invalid_x402_version",
  "invalid_transaction_state",
  "unexpected_verify_error",
  "unexpected_settle_error",
  "settlement_pending",
] as const;
export type X402ErrorReason = (typeof X402_ERROR_REASONS)[number];

/** The one non-terminal settle error: broadcast, not yet confirmed. Its `transaction` is never empty (core §9). */
export const SETTLEMENT_PENDING = "settlement_pending" as const;

// ---------------------------------------------------------------------------------------------------------------------
// EIP-3009 payloads, as `exact` and `auth-capture` carry them on EVM
// ---------------------------------------------------------------------------------------------------------------------

/** The EIP-3009 authorization: every member a string (core §5.2.2; lcp `Eip3009Authorization`). */
export const Eip3009Authorization = z.looseObject({
  from: Address,
  to: Address,
  value: Uint256String,
  validAfter: z.string().regex(/^[0-9]{1,20}$/),
  validBefore: z.string().regex(/^[0-9]{1,20}$/),
  nonce: Bytes32,
});
export type Eip3009Authorization = z.infer<typeof Eip3009Authorization>;

/**
 * `exact` on EVM by EIP-3009: `TransferWithAuthorization` to `payTo`. For the pairing `x402/exact/eip155/eip3009`,
 * `authorization.nonce` is H (R1 §4).
 */
export const ExactEip3009Payload = z.looseObject({ signature: Hex, authorization: Eip3009Authorization });
export type ExactEip3009Payload = z.infer<typeof ExactEip3009Payload>;

/**
 * `auth-capture` on EVM by EIP-3009: `ReceiveWithAuthorization` to the escrow's token collector, with `salt`, and
 * `saltNonce` when bound (auth-capture EVM binding, "Client payment payload"). For the pairing
 * `x402/auth-capture/eip155/eip3009`, `salt` is H when unbound (R1 §4).
 */
export const AuthCaptureEip3009Payload = z.looseObject({
  signature: Hex,
  authorization: Eip3009Authorization,
  salt: Bytes32,
  saltNonce: Bytes32.optional(),
});
export type AuthCaptureEip3009Payload = z.infer<typeof AuthCaptureEip3009Payload>;

/** `extra` of an `exact` option on EVM by EIP-3009: the token's EIP-712 domain. */
export const ExactEip3009Extra = z.looseObject({
  name: z.string().min(1),
  version: z.string().min(1),
  assetTransferMethod: z.literal("eip3009").optional(),
});
export type ExactEip3009Extra = z.infer<typeof ExactEip3009Extra>;

/** `extra` of an `auth-capture` option on EVM (auth-capture EVM binding, "`extra` fields"). */
export const AuthCaptureExtra = z.looseObject({
  name: z.string().min(1),
  version: z.string().min(1),
  authCaptureEscrow: Address.optional(),
  captureAuthorizer: Address,
  receiverAuthorizer: Address.optional(),
  policy: Address.optional(),
  captureDeadline: z.int().min(0).max(2 ** 48 - 1),
  refundDeadline: z.int().min(0).max(2 ** 48 - 1),
  feeRecipient: Address,
  minFeeBps: z.int().min(0).max(10_000),
  maxFeeBps: z.int().min(0).max(10_000),
  paymentFlow: z.enum(["escrow", "authorization"]).optional(),
  captureMode: z.enum(["sync", "deferred"]).optional(),
  operatorType: z.enum(["delegated", "custom"]).optional(),
  assetTransferMethod: z.enum(["eip3009", "permit2"]).optional(),
});
export type AuthCaptureExtra = z.infer<typeof AuthCaptureExtra>;

// ---------------------------------------------------------------------------------------------------------------------
// The legal-context extension: Integra's own, allowed by x402 (R3 §2), placed by lcp's `advertise` (R1 §3)
// ---------------------------------------------------------------------------------------------------------------------

/** The extension's key in `extensions`. */
export const LEGAL_CONTEXT = "legalContext" as const;

/** `extensions.legalContext.info`: the ATR's hash H and its link (R1 §3, the carrier `legalContext`). */
export const LegalContextInfo = z.looseObject({
  type: z.literal("sha256"),
  value: AtrHash,
  legalContextUrl: HttpsUrl,
});
export type LegalContextInfo = z.infer<typeof LegalContextInfo>;

/** `extensions.legalContext.schema`, as lcp 0.2.0 writes it (`LEGAL_CONTEXT_SCHEMA`, lcp `src/x402.ts`). */
export const LEGAL_CONTEXT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    type: { const: "sha256" },
    value: { type: "string", pattern: "^0x[0-9a-f]{64}$" },
    legalContextUrl: { type: "string", pattern: "^https://" },
  },
  required: ["type", "value", "legalContextUrl"],
} as const;

/** A challenge that carries the legal context: what every v4 checkout sends, and what the buyer reads. */
export const PaymentRequiredWithLegalContext = PaymentRequired.extend({
  extensions: z.looseObject({ [LEGAL_CONTEXT]: z.looseObject({ info: LegalContextInfo, schema: JsonObject }) }),
});
export type PaymentRequiredWithLegalContext = z.infer<typeof PaymentRequiredWithLegalContext>;

// ---------------------------------------------------------------------------------------------------------------------
// The facilitator's API (core §7)
// ---------------------------------------------------------------------------------------------------------------------

/** `POST /verify` and `POST /settle` take the same body (core §7.1, §7.2). */
export const FacilitatorRequest = z.looseObject({
  x402Version: z.literal(X402_VERSION),
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
});
export type FacilitatorRequest = z.infer<typeof FacilitatorRequest>;

/** One kind a facilitator supports (core §7.3). */
export const SupportedKind = z.looseObject({
  x402Version: z.literal(X402_VERSION),
  scheme: z.string().min(1),
  network: Caip2,
  extra: JsonObject.optional(),
});
export type SupportedKind = z.infer<typeof SupportedKind>;

/** `GET /supported` (core §7.3): the kinds, the extensions, and the signers by CAIP-2 pattern (`"eip155:*"`). */
export const SupportedResponse = z.looseObject({
  kinds: z.array(SupportedKind),
  extensions: z.array(z.string()),
  signers: z.record(z.string(), z.array(z.string())),
});
export type SupportedResponse = z.infer<typeof SupportedResponse>;

// ---------------------------------------------------------------------------------------------------------------------
// Over HTTP (transports-v2/http.md)
// ---------------------------------------------------------------------------------------------------------------------

/** The three headers, each base64 of the JSON object. */
export const X402_HEADERS = {
  paymentRequired: "PAYMENT-REQUIRED",
  paymentSignature: "PAYMENT-SIGNATURE",
  paymentResponse: "PAYMENT-RESPONSE",
} as const;

/**
 * HTTP statuses: payment required 402, invalid payment 400, payment failed 402, server error 500, success 200
 * (transports-v2/http.md). `202`, for a payment sent and not yet confirmed, is v3's convention and the design's
 * choice, and no standard's (design §3.5).
 */
export const X402_HTTP_STATUS = {
  paymentRequired: 402,
  invalidPayment: 400,
  paymentFailed: 402,
  serverError: 500,
  success: 200,
  pending: 202,
} as const;

/** Standard padded base64 (RFC 4648 §4) of the UTF-8 of `JSON.stringify(value)`: a header's value. */
export function encodeX402Header(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * A header's value back to JSON. Either base64 alphabet, padded or not, as the appliance's own door reads it (R1 §3).
 * Throws when it is not base64 of UTF-8 JSON.
 */
export function decodeX402Header(value: string): unknown {
  let b64 = value.trim().replaceAll("-", "+").replaceAll("_", "/");
  while (b64.length % 4 !== 0) b64 += "=";
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
}

// ---------------------------------------------------------------------------------------------------------------------
// Over MCP (transports-v2/mcp.md, last changed 2026-02-03; R3 §1)
// ---------------------------------------------------------------------------------------------------------------------

/** The `_meta` keys: the payment on the call's `params`, the receipt on the result. */
export const X402_MCP_META = {
  payment: "x402/payment",
  paymentResponse: "x402/payment-response",
} as const;

/** A tool's resource URL, by the specification's convention: `mcp://tool/<name>`. */
export function mcpToolResourceUrl(tool: string): string {
  return `mcp://tool/${tool}`;
}

/** A text content block of a tool result. */
export const McpTextContent = z.looseObject({ type: z.literal("text"), text: z.string() });
export type McpTextContent = z.infer<typeof McpTextContent>;

/**
 * Payment required, over MCP: a tool **result** with `isError: true`, the `PaymentRequired` in `structuredContent`,
 * and the same as a JSON string in `content[0].text`. Both are required. A payment that fails, or fails to settle, is
 * answered in the same form, with the reason in `error`. `resultType: "complete"` is MCP 2026-07-28's, which the x402
 * document predates (design §3.5).
 */
export const McpPaymentRequiredResult = z.looseObject({
  isError: z.literal(true),
  structuredContent: PaymentRequired,
  content: z.tuple([McpTextContent], McpTextContent),
  resultType: z.literal("complete"),
});
export type McpPaymentRequiredResult = z.infer<typeof McpPaymentRequiredResult>;
