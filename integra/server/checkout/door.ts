// The appliance's seller door (R1): `issue`, `claim`, `report` and `status`, with the shared tenant's credential. Every
// call is built with fresh headers and no `Origin`, which the door refuses before anything else (R1 §1, §11).
import { SELLER_DOOR_URL, type Refusal } from "@demo-factory/interfaces";
import type {
  ClaimRequest,
  ClaimResponse,
  IssueRequest,
  IssueResponse,
  RecordView,
  ReportRequest,
} from "@integraledger/agentic-connectors";

export type DoorAnswer<T> =
  | { ok: true; status: number; body: T; ms: number }
  | { ok: false; status: number; refusal: Refusal; ms: number };

const CODE = /^[a-z0-9-]+\/[a-z0-9-]+$/;

/** A refusal as the door wrote it; an edge code outside the door's table (`at-capacity`, …) is named `edge/<code>`. */
function refusalOf(status: number, parsed: unknown, text: string): Refusal {
  const r = (parsed ?? {}) as { code?: unknown; sentence?: unknown };
  const raw = typeof r.code === "string" ? r.code : "";
  const code = CODE.test(raw) ? raw : /^[a-z0-9-]+$/.test(raw) ? `edge/${raw}` : `door/http-${status}`;
  const sentence = typeof r.sentence === "string" && r.sentence ? r.sentence : text.slice(0, 300) || `The seller door answered ${status}.`;
  return { code, sentence };
}

async function call<T>(credential: string, method: "GET" | "POST", path: string, body: unknown, timeoutMs: number): Promise<DoorAnswer<T>> {
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${SELLER_DOOR_URL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${credential}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const sentence = `The seller door did not answer ${method} ${path}: ${e instanceof Error ? e.message : String(e)}`;
    return { ok: false, status: 503, refusal: { code: "door/unreachable", sentence }, ms: Date.now() - started };
  }
  const text = await res.text();
  const ms = Date.now() - started;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Kept as text, for the refusal's sentence.
  }
  if (res.ok) return { ok: true, status: res.status, body: parsed as T, ms };
  return { ok: false, status: res.status, refusal: refusalOf(res.status, parsed, text), ms };
}

/** `issue` answers within 1.8 s or `503 issue/deadline` (R1 §9). */
export const issue = (credential: string, req: IssueRequest) =>
  call<IssueResponse>(credential, "POST", "/issue", req, 5_000);

export const claim = (credential: string, req: ClaimRequest) => call<ClaimResponse>(credential, "POST", "/claim", req, 10_000);

/** `200` read settled and paid; `202` settling, which is final for the seller (R1 §5). */
export const report = (credential: string, req: ReportRequest) => call<RecordView>(credential, "POST", "/report", req, 10_000);

export const status = (credential: string, h: string) => call<RecordView>(credential, "GET", `/status/${h}`, undefined, 10_000);
