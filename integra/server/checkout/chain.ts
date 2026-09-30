// The app's own reads of Base Sepolia (design §3.4, step 7; §3.6): the payment through lcp's `status`, and for Buy now
// its `recover` too; for a promise to pay, the escrow's salt beside H; and the capture. lcp ships no JSON-RPC client, so
// the `EvmReader` is the kit's, over the node named by `RPC_URL` (a secret: its URL carries a provider's key).
import { AUTH_CAPTURE_ESCROW, NETWORK, USDC, type AtrHash, type PaymentPayload } from "@demo-factory/interfaces";
import { PAYMENT_AUTHORIZED_TOPIC, ReaderError, TRANSFER_TOPIC, type EvmReader, type Hex } from "@integraledger/lcp/evm";
import { authCaptureEip3009, exactEip3009 } from "@integraledger/lcp/x402";

/**
 * keccak256("PaymentCaptured(bytes32,uint256,uint256,address)"): the escrow's event for a capture, as the deployed v1.1
 * escrow emits it, with the fee in basis points as a `uint256` (read from capture 0x9fd3ef1f…96ded1 on Base Sepolia).
 */
export const PAYMENT_CAPTURED_TOPIC = "0xac1e0db1957daedbc6944bcb4c8dc947ff8101d710671ac2ec26309f7f38d58e" as const;

const HEX = /^0x[0-9a-fA-F]*$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function hexOf(v: unknown, what: string): Hex {
  if (typeof v !== "string" || !HEX.test(v)) throw new ReaderError("malformed", `${what} is not hex`);
  return v as Hex;
}
function quantityOf(v: unknown, what: string): bigint {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]+$/.test(v)) throw new ReaderError("malformed", `${what} is not a quantity`);
  return BigInt(v);
}
function addressOf(v: unknown, what: string): Hex {
  if (typeof v !== "string" || !ADDRESS.test(v)) throw new ReaderError("malformed", `${what} is not an address`);
  return v as Hex;
}

let rpcId = 0;

/** An `EvmReader` for lcp's reads, over one JSON-RPC endpoint on Base Sepolia. */
export function evmReader(rpcUrl: string): EvmReader {
  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
        signal: AbortSignal.timeout(8_000),
      });
    } catch (e) {
      throw new ReaderError("transport", `${method}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw new ReaderError("transport", `${method}: HTTP ${res.status}`);
    const body = (await res.json().catch(() => null)) as { result?: unknown; error?: { message?: string } } | null;
    if (!body || body.error) throw new ReaderError("transport", `${method}: ${body?.error?.message ?? "no answer"}`);
    return body.result ?? null;
  }
  return {
    network: NETWORK,
    async receipt(tx) {
      const r = await rpc("eth_getTransactionReceipt", [tx]);
      if (r === null) return null;
      if (!isObject(r) || !Array.isArray(r["logs"])) throw new ReaderError("malformed", "a receipt with no logs");
      return {
        status: quantityOf(r["status"], "the receipt's status") === 1n ? 1 : 0,
        blockNumber: quantityOf(r["blockNumber"], "the receipt's block number"),
        logs: (r["logs"] as unknown[]).map((l) => {
          if (!isObject(l) || !Array.isArray(l["topics"])) throw new ReaderError("malformed", "a log with no topics");
          return {
            address: addressOf(l["address"], "a log's address"),
            topics: (l["topics"] as unknown[]).map((t) => hexOf(t, "a log's topic")),
            data: hexOf(l["data"], "a log's data"),
          };
        }),
      };
    },
    async blockNumber(tag) {
      const b = await rpc("eth_getBlockByNumber", [tag, false]);
      if (!isObject(b)) throw new ReaderError("malformed", `no ${tag} block`);
      return quantityOf(b["number"], `the ${tag} block's number`);
    },
    async transaction(tx) {
      const t = await rpc("eth_getTransactionByHash", [tx]);
      if (t === null) return null;
      if (!isObject(t)) throw new ReaderError("malformed", "a transaction that is not an object");
      return {
        from: addressOf(t["from"], "the transaction's sender"),
        to: t["to"] === null ? null : addressOf(t["to"], "the transaction's recipient"),
        input: hexOf(t["input"], "the transaction's input"),
      };
    },
    async call(to, data, block) {
      return hexOf(await rpc("eth_call", [{ to, data }, `0x${block.toString(16)}`]), "the call's return data");
    },
  };
}

/** lcp's refusals that say the node could not answer, or had no receipt yet: they disprove nothing. */
const UNREAD = new Set(["evm/unreadable", "evm/not-found", "evm/wrong-reader"]);

/**
 * What the app's own read of a payment found. `failed` only when a mined receipt disproves it: reverted, or without
 * the log that carries H. A read the node could not answer is `pending`, never `failed`.
 */
export type PaymentRead =
  | { state: "settled"; finality: string; block: string; recovered?: AtrHash; salt?: string; paymentId?: string }
  | { state: "pending"; why: string }
  | { state: "failed"; why: string };

const word = (data: Hex, i: number): string => `0x${data.slice(2 + i * 64, 2 + (i + 1) * 64)}`;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Reads the payment's settlement transaction.
 * - Buy now: lcp's `status` with the payment's read keys, then `recover`, which must give back H.
 * - A promise to pay: lcp's `status` (the escrow's `PaymentAuthorized` under the payment's id), then the salt from that
 *   log's `PaymentInfo`, set beside H. The chain alone does not reveal H; the salt is what a holder of H compares.
 */
export async function readPayment(payment: PaymentPayload, h: AtrHash, transaction: string, reader: EvmReader): Promise<PaymentRead> {
  const tx = transaction as Hex;
  if (payment.accepted.scheme === "exact") {
    const ref = await exactEip3009.reference(payment);
    if ("code" in ref) return { state: "failed", why: `the payment's read keys: ${ref.code}` };
    const st = await exactEip3009.status({ ...ref, transaction: tx, h: h as Hex }, reader);
    if (st.state !== "settled") return st;
    const recovered = await exactEip3009.recover({ network: NETWORK, asset: USDC.address, transaction: tx }, reader);
    if (typeof recovered !== "string") {
      // A node that could not answer, or has not yet seen the receipt, disproves nothing: the read is pending.
      if (UNREAD.has(recovered.code)) return { state: "pending", why: `recover: ${recovered.code}` };
      return { state: "failed", why: `recover: ${recovered.code}` };
    }
    if (recovered !== h) return { state: "failed", why: `recover gave ${recovered}, not H` };
    return { state: "settled", finality: st.finality, block: st.blockNumber.toString(), recovered };
  }
  const ref = await authCaptureEip3009.reference(payment);
  if ("code" in ref) return { state: "failed", why: `the payment's read keys: ${ref.code}` };
  const st = await authCaptureEip3009.status({ ...ref, transaction: tx }, reader);
  if (st.state !== "settled") return st;
  const paymentId = ref.bindingLog?.value;
  let receipt;
  try {
    receipt = await reader.receipt(tx);
  } catch (e) {
    return { state: "pending", why: `the receipt, for the salt: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (receipt === null) return { state: "pending", why: "the receipt, for the salt: not-found" };
  const log = receipt.logs.find(
    (l) =>
      same(l.address, AUTH_CAPTURE_ESCROW.authCaptureEscrow) &&
      same(l.topics[0] ?? "", PAYMENT_AUTHORIZED_TOPIC) &&
      paymentId !== undefined &&
      same(l.topics[1] ?? "", paymentId),
  );
  // PaymentAuthorized(bytes32 indexed paymentInfoHash, PaymentInfo paymentInfo, uint256 amount, address tokenCollector):
  // PaymentInfo's twelve words are inline, and the salt is its last.
  const salt = log ? word(log.data, 11) : undefined;
  if (salt === undefined) return { state: "failed", why: "no PaymentAuthorized log under the payment's id" };
  if (!same(salt, h)) return { state: "failed", why: `the escrow's salt ${salt} is not H` };
  return { state: "settled", finality: st.finality, block: st.blockNumber.toString(), salt: salt.toLowerCase(), ...(paymentId ? { paymentId } : {}) };
}

/** The payment's id in the escrow: the `PaymentAuthorized` log's first topic, from the payment's read keys. */
export async function paymentIdOf(payment: PaymentPayload): Promise<string | null> {
  const ref = await authCaptureEip3009.reference(payment);
  return "code" in ref ? null : (ref.bindingLog?.value ?? null);
}

export type CaptureRead =
  | { state: "collected"; block: string; amount: string }
  | { state: "pending"; why: string }
  | { state: "failed"; why: string };

/**
 * Reads a capture transaction: it succeeded, the escrow emitted `PaymentCaptured` under the payment's id, and USDC moved
 * the amount to the treasury.
 */
export async function readCapture(p: { transaction: string; paymentId: string; payTo: string; amount: string }, reader: EvmReader): Promise<CaptureRead> {
  let receipt;
  try {
    receipt = await reader.receipt(p.transaction as Hex);
  } catch (e) {
    return { state: "pending", why: e instanceof Error ? e.message : String(e) };
  }
  if (receipt === null) return { state: "pending", why: "not-found" };
  if (receipt.status !== 1) return { state: "failed", why: "reverted" };
  const captured = receipt.logs.some(
    (l) => same(l.address, AUTH_CAPTURE_ESCROW.authCaptureEscrow) && same(l.topics[0] ?? "", PAYMENT_CAPTURED_TOPIC) && same(l.topics[1] ?? "", p.paymentId),
  );
  if (!captured) return { state: "failed", why: "no PaymentCaptured log under the payment's id" };
  const paid = receipt.logs.find(
    (l) =>
      same(l.address, USDC.address) &&
      same(l.topics[0] ?? "", TRANSFER_TOPIC) &&
      same(`0x${(l.topics[2] ?? "").slice(-40)}`, p.payTo) &&
      BigInt(l.data === "0x" ? 0 : l.data) === BigInt(p.amount),
  );
  if (!paid) return { state: "failed", why: "no transfer of the amount to the treasury" };
  return { state: "collected", block: receipt.blockNumber.toString(), amount: p.amount };
}
