// v4's facilitator (design §12; `facilitator.ts` in @demo-factory/interfaces): x402's `/verify` and `/settle`, and its
// own `/capture` of a promise to pay. Any origin may call it, with no credential.
import {
  FACILITATOR_ROUTES,
  FACILITATOR_URL,
  NETWORK,
  X402_VERSION,
  type CaptureResponse,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
  type VerifyResponse,
} from "@demo-factory/interfaces";

export type Reached<T> = { ok: true; body: T; ms: number } | { ok: false; why: string; ms: number };

async function post<T>(path: string, body: unknown, timeoutMs: number): Promise<Reached<T>> {
  const started = Date.now();
  try {
    const res = await fetch(`${FACILITATOR_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    const ms = Date.now() - started;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, why: `the facilitator answered ${res.status} with no JSON: ${text.slice(0, 200)}`, ms };
    }
    // x402's facilitators answer a refused payment with a body of the same shape, whatever the status.
    if (typeof parsed !== "object" || parsed === null) return { ok: false, why: `the facilitator answered ${res.status}: ${text.slice(0, 200)}`, ms };
    return { ok: true, body: parsed as T, ms };
  } catch (e) {
    return { ok: false, why: `the facilitator did not answer ${path}: ${e instanceof Error ? e.message : String(e)}`, ms: Date.now() - started };
  }
}

const request = (paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements) => ({
  x402Version: X402_VERSION,
  paymentPayload,
  paymentRequirements,
});

/** `/verify`: read-only (x402 core §7.1). */
export const verify = (payment: PaymentPayload, requirements: PaymentRequirements) =>
  post<VerifyResponse>(FACILITATOR_ROUTES.verify.path, request(payment, requirements), 20_000);

/**
 * `/settle`: `exact` is transferred; `auth-capture` is authorised into the escrow. A receipt the facilitator cannot
 * establish in its own wait is `settlement_pending`, with the transaction.
 */
export const settle = (payment: PaymentPayload, requirements: PaymentRequirements) =>
  post<SettleResponse>(FACILITATOR_ROUTES.settle.path, request(payment, requirements), 60_000);

/** `/capture`: the whole of a payment this facilitator authorised, named by its `authorize` transaction (design §3.6). */
export const capture = (transaction: string) =>
  post<CaptureResponse>(FACILITATOR_ROUTES.capture.path, { network: NETWORK, transaction }, 60_000);
