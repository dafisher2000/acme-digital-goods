/**
 * Every schema that has a JSON Schema file in `schemas/`, by the file's name. `scripts/write-schemas.ts` writes
 * `schemas/<name>.schema.json` for each, and nothing else.
 */
import type { z } from "zod";
import { Agreement, AgreementContent } from "./agreement.ts";
import { AtrPutHeaders, StorageSecret } from "./agreement-store.ts";
import {
  AtrCheckArgs,
  AtrConfirmArgs,
  AtrFinishArgs,
  CheckAgreementResult,
  CheckoutRef,
  PayResult,
  RunCreated,
  RunRecord,
  RunRequest,
  StartCheckoutArgs,
  StartCheckoutResult,
} from "./buyer.ts";
import { Business } from "./business.ts";
import { AuthoriseOption, BuyPaid, BuyRequest, BuyToolArgs, GetPurchaseArgs, NowOption, Purchase } from "./checkout.ts";
import { AtrHash, Refusal } from "./common.ts";
import { EventEnvelope } from "./events.ts";
import { CaptureRequest, CaptureResponse, FacilitatorHealth } from "./facilitator.ts";
import { HostedApp, PublishRequest } from "./hosting.ts";
import { NegotiateAnswer, NegotiateBody, NegotiateRequest } from "./negotiation.ts";
import { Dollars } from "./price.ts";
import {
  GetTermsArgs,
  HealthAnswer,
  LegalContextDocument,
  ProofDocument,
  PurchasesAnswer,
  RecordView,
  UcpProfile,
} from "./routes.ts";
import { PublicBusiness } from "./storefront.ts";
import {
  FacilitatorRequest,
  McpPaymentRequiredResult,
  PaymentPayload,
  PaymentRequired,
  PaymentRequiredWithLegalContext,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "./x402.ts";

export const SCHEMAS = {
  // shared
  "atr-hash": AtrHash,
  refusal: Refusal,
  dollars: Dollars,
  // business.json and the storefront (design §2.3, §2.6)
  business: Business,
  "integra-business": PublicBusiness,
  // the agreement (§4)
  "agreement-content": AgreementContent,
  agreement: Agreement,
  // the event envelope (§8.2)
  event: EventEnvelope,
  // the checkout (§3), over HTTP and MCP
  "checkout.buy-request": BuyRequest,
  "checkout.buy-tool-args": BuyToolArgs,
  "checkout.now-option": NowOption,
  "checkout.authorise-option": AuthoriseOption,
  "checkout.buy-paid": BuyPaid,
  "checkout.purchase": Purchase,
  "checkout.get-purchase-args": GetPurchaseArgs,
  // negotiation (§7)
  "negotiation.request": NegotiateRequest,
  "negotiation.body": NegotiateBody,
  "negotiation.answer": NegotiateAnswer,
  // the kit's other routes (§2.4, §8, §9)
  "kit.purchases": PurchasesAnswer,
  "kit.proof": ProofDocument,
  "kit.record-view": RecordView,
  "kit.health": HealthAnswer,
  "kit.ucp-profile": UcpProfile,
  "kit.legal-context": LegalContextDocument,
  "kit.get-terms-args": GetTermsArgs,
  // x402 v2, as published
  "x402.payment-required": PaymentRequired,
  "x402.payment-required-with-legal-context": PaymentRequiredWithLegalContext,
  "x402.payment-payload": PaymentPayload,
  "x402.settle-response": SettleResponse,
  "x402.verify-response": VerifyResponse,
  "x402.facilitator-request": FacilitatorRequest,
  "x402.supported": SupportedResponse,
  "x402.mcp-payment-required-result": McpPaymentRequiredResult,
  // the facilitator (§12)
  "facilitator.capture-request": CaptureRequest,
  "facilitator.capture-response": CaptureResponse,
  "facilitator.health": FacilitatorHealth,
  // the agreement store (§12)
  "agreement-store.put-headers": AtrPutHeaders,
  "agreement-store.storage-secret": StorageSecret,
  // the buyer service (§10.1, §10.6)
  "buyer.run-request": RunRequest,
  "buyer.run-created": RunCreated,
  "buyer.run-record": RunRecord,
  "buyer.atr-confirm-args": AtrConfirmArgs,
  "buyer.atr-finish-args": AtrFinishArgs,
  "buyer.atr-check-args": AtrCheckArgs,
  "buyer.start-checkout-args": StartCheckoutArgs,
  "buyer.start-checkout-result": StartCheckoutResult,
  "buyer.checkout-ref": CheckoutRef,
  "buyer.check-agreement-result": CheckAgreementResult,
  "buyer.pay-result": PayResult,
  // the hosting (§12, call 10)
  "hosting.publish-request": PublishRequest,
  "hosting.app": HostedApp,
} as const satisfies Record<string, z.ZodType>;

export type SchemaName = keyof typeof SCHEMAS;
