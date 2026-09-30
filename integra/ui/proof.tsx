// The proof page, `/proof/<H>` (design §8.3). It is addressed by H, and it measures what it claims in the browser: it
// hashes the bytes it was served before it draws the agreement, reads the chain itself from the public endpoint, and asks
// Integra's buyer service for its record under the hash the challenge advertised. Then it draws the three records, the
// buyer's, the appliance's and the seller's, side by side, each fact under the party that said it.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Agreement, EventEnvelope, ProofDocument, RunRecord } from "@demo-factory/interfaces";
import { DEFERRED_DEMONSTRATION_SENTENCE, DEMONSTRATION_SENTENCE } from "@demo-factory/interfaces/demonstration";
import { explorerTxUrl, NETWORK_NAME, PUBLIC_RPC_URL, USDC } from "@demo-factory/interfaces/network";
import { ANCHOR_AMOUNT } from "@demo-factory/interfaces/price";
import { WALLETS } from "@demo-factory/interfaces/services";
import { dollars, ORIGIN, shortHash, usdc, when } from "./lib.ts";
import { Timeline, type Row } from "./timeline.tsx";

const NO_RECORD = "Integra's buyer service has no record of this purchase."; // NO_RECORD_SENTENCE

type Measured<T> = { state: "waiting" } | { state: "done"; value: T } | { state: "failed"; why: string };

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return "0x" + [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(PUBLIC_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result as T;
}

type Receipt = { status: string; blockNumber: string; logs: { address: string; topics: string[]; data: string }[] } | null;

/** What the browser reads of the transaction: its block and status, where H is in it, and the USDC it moved to the treasury. */
type ChainRead = { block: number; ok: boolean; holds: { where: string; contract: string } | null; toTreasury: bigint | null };

/** keccak256("Transfer(address,address,uint256)"): the token's transfer event. */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

async function readChain(transaction: string, hash: string): Promise<ChainRead> {
  const receipt = await rpc<Receipt>("eth_getTransactionReceipt", [transaction]);
  if (!receipt) throw new Error("The chain has no receipt for it yet.");
  const needle = hash.slice(2).toLowerCase();
  const block = parseInt(receipt.blockNumber, 16);
  const ok = receipt.status === "0x1";
  const transfer = receipt.logs.find(
    (log) =>
      log.address.toLowerCase() === USDC.address.toLowerCase() &&
      log.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
      `0x${(log.topics[2] ?? "").slice(-40)}`.toLowerCase() === WALLETS.treasury.toLowerCase(),
  );
  const toTreasury = transfer ? BigInt(transfer.data === "0x" ? 0 : transfer.data) : null;
  for (const log of receipt.logs) {
    const topic = log.topics.findIndex((value) => value.toLowerCase().includes(needle));
    if (topic >= 0) return { block, ok, holds: { where: `topic ${topic}`, contract: log.address }, toTreasury };
    if (log.data.toLowerCase().includes(needle)) return { block, ok, holds: { where: "data", contract: log.address }, toTreasury };
  }
  return { block, ok, holds: null, toTreasury };
}

/** `data-from` and `data-seq` for a fact, from the event that carried it (design §2.5). */
function from(event: EventEnvelope | undefined) {
  return event ? ({ "data-from": event.side, "data-seq": event.seq } as const) : {};
}

const last = (events: EventEnvelope[], step: string) => events.findLast((event) => event.step === step);

function Section({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <section className="ik-section" id={id}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function ProofPage({ hash }: { hash: string }) {
  const [doc, setDoc] = useState<ProofDocument | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [atr, setAtr] = useState<Measured<{ computed: string; agreement: Agreement | null; bytes: number }>>({ state: "waiting" });
  const [buyer, setBuyer] = useState<Measured<RunRecord | null>>({ state: "waiting" });
  const [chain, setChain] = useState<Measured<ChainRead | null>>({ state: "waiting" });

  useEffect(() => {
    let live = true;
    fetch(`/proof/${hash}.json`)
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 404 ? "This app has no purchase under this hash." : `The app answered ${response.status}.`);
        return (await response.json()) as ProofDocument;
      })
      .then((body) => live && setDoc(body))
      .catch((error: unknown) => live && setFailure(error instanceof Error ? error.message : String(error)));
    return () => {
      live = false;
    };
  }, [hash]);

  // The browser hashes the bytes it was served, and draws the agreement only if they hash to H.
  useEffect(() => {
    let live = true;
    fetch(`/proof/${hash}/atr`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`The app answered ${response.status}.`);
        const bytes = await response.arrayBuffer();
        const computed = await sha256Hex(bytes);
        let agreement: Agreement | null = null;
        if (computed === hash) {
          try {
            agreement = JSON.parse(new TextDecoder().decode(bytes)) as Agreement;
          } catch {
            agreement = null;
          }
        }
        return { computed, agreement, bytes: bytes.byteLength };
      })
      .then((value) => live && setAtr({ state: "done", value }))
      .catch((error: unknown) => live && setAtr({ state: "failed", why: error instanceof Error ? error.message : String(error) }));
    return () => {
      live = false;
    };
  }, [hash]);

  useEffect(() => {
    if (!doc) return;
    let live = true;
    fetch(doc.buyerRecord)
      .then(async (response) => (response.status === 404 ? null : response.ok ? ((await response.json()) as RunRecord) : Promise.reject(new Error(`The buyer service answered ${response.status}.`))))
      .then((value) => live && setBuyer({ state: "done", value }))
      .catch((error: unknown) => live && setBuyer({ state: "failed", why: error instanceof Error ? error.message : String(error) }));
    const transaction = doc.purchase.transaction;
    if (!transaction) setChain({ state: "done", value: null });
    else
      readChain(transaction, hash)
        .then((value) => live && setChain({ state: "done", value }))
        .catch((error: unknown) => live && setChain({ state: "failed", why: error instanceof Error ? error.message : String(error) }));
    return () => {
      live = false;
    };
  }, [doc, hash]);

  const events = (doc?.events ?? []) as EventEnvelope[];
  const carried = useMemo(() => {
    const arrived = last(events, "payment/arrived");
    return typeof arrived?.data.carried === "string" ? arrived.data.carried : null;
  }, [events]);

  if (failure) {
    return (
      <main className="ik-page" data-integra-page="proof">
        <h1>Proof</h1>
        <p className="ik-error">{failure}</p>
      </main>
    );
  }
  if (!doc) {
    return (
      <main className="ik-page" data-integra-page="proof">
        <h1>Proof</h1>
        <p className="ik-wait">Reading the purchase…</p>
      </main>
    );
  }

  const { purchase, record } = doc;
  const agreementOk = atr.state === "done" && atr.value.computed === hash;
  const buyerRecord = buyer.state === "done" ? buyer.value : null;
  const buyerEvents = (buyerRecord?.events ?? []) as EventEnvelope[];
  const buyerCompared = buyerEvents.findLast((event) => event.step === "atr/compared");
  const buyerReceived = buyerEvents.findLast((event) => event.step === "delivery/received");
  const stateEvent = last(events, "checkout/state") ?? last(events, "checkout/opened");
  const issueEvent = last(events, "issue");
  const statusEvent = last(events, "status");
  const deliveryEvent = last(events, "delivery");
  const chainEvent = last(events, "chain/read") ?? last(events, "settle");
  const openedEvent = last(events, "checkout/opened");
  const deferred = purchase.deferred;

  const sideRows = (sides: string[]): Row[] => events.filter((event) => sides.includes(event.side)).map((event) => ({ stream: "app", event }));
  const delivery = purchase.delivery;
  const sentHash = delivery?.kind === "file" ? delivery.sha256 : null;
  const receivedHash = typeof buyerReceived?.data.sha256 === "string" ? buyerReceived.data.sha256 : null;

  return (
    <main className="ik-page ik-proof" data-integra-page="proof">
      <h1>Proof of a purchase</h1>
      <p className="ik-demo">{doc.demonstration}</p>

      <Section title="The headline">
        <p className="ik-headline" {...from(stateEvent)}>
          <strong>{purchase.headline}.</strong> {purchase.offerName}: listed {dollars(purchase.price.listed)}
          {purchase.price.agreed ? `, agreed ${dollars(purchase.price.agreed)}` : ""}
          {deferred
            ? `; ${dollars(deferred.owed)} owed, due ${when(deferred.due)}; the anchoring payment is ${usdc(purchase.amount)} on ${NETWORK_NAME}, and is not part of the price.`
            : `, paid ${usdc(purchase.amount)} on ${NETWORK_NAME}.`}
          {purchase.test ? " This was the test checkout." : ""}
        </p>
        {purchase.refusal ? <p className="ik-error" {...from(stateEvent)}>{purchase.refusal.sentence}</p> : null}
      </Section>

      {deferred ? (
        <Section title="Paid later" id="pay-later">
          <table className="ik-table" data-integra-pay-later>
            <tbody>
              <tr>
                <th>What is owed</th>
                <td {...from(openedEvent)}>
                  <strong>{dollars(deferred.owed)}</strong>
                  {purchase.price.agreed ? ", the price agreed in the negotiation" : ", the listed price"}: {usdc(deferred.amount)} at this demonstration&apos;s scale, to the seller&apos;s
                  treasury <code>{shortHash(WALLETS.treasury)}</code>.
                </td>
              </tr>
              <tr>
                <th>By when</th>
                <td {...from(openedEvent)}>
                  <strong>{when(deferred.due)}</strong>, {deferred.rule === "booking" ? "when the booked slot starts" : "the number of days after the purchase that the offer names"}.
                </td>
              </tr>
              <tr>
                <th>The anchor on chain</th>
                <td {...from(chainEvent)}>
                  {purchase.transaction ? (
                    <>
                      {usdc(purchase.amount)}, whose nonce is H:{" "}
                      {chain.state === "done" && chain.value
                        ? `${chain.value.holds ? "H is in the transaction" : "H is not in the transaction"}, in block ${chain.value.block}${
                            chain.value.toTreasury !== null ? `, which moved ${usdc(chain.value.toTreasury.toString())} to the treasury` : ""
                          }. `
                        : chain.state === "failed"
                          ? `the chain could not be read: ${chain.why} `
                          : "reading the chain… "}
                      <a href={explorerTxUrl(purchase.transaction)} target="_blank" rel="noreferrer">
                        Open it on the explorer
                      </a>
                    </>
                  ) : (
                    "No anchoring payment has been made."
                  )}
                </td>
              </tr>
            </tbody>
          </table>
          <p data-integra-inception-only>
            <strong>What is recorded, and what is not.</strong> {DEFERRED_DEMONSTRATION_SENTENCE} The anchoring payment of {usdc(ANCHOR_AMOUNT)} is not part of the price.
          </p>
        </Section>
      ) : null}

      <Section title="The agreement" id="agreement">
        {atr.state === "waiting" ? <p className="ik-wait">Hashing the bytes the app served…</p> : null}
        {atr.state === "failed" ? <p className="ik-error">The agreement could not be read: {atr.why}</p> : null}
        {atr.state === "done" && !agreementOk ? (
          <p className="ik-error">
            The bytes the app served hash to <code>{atr.value.computed}</code>, not to <code>{hash}</code>. The agreement is not drawn.
          </p>
        ) : null}
        {agreementOk && atr.state === "done" && atr.value.agreement ? <AgreementView agreement={atr.value.agreement} issue={issueEvent} /> : null}
        {agreementOk && atr.state === "done" && !atr.value.agreement ? <p className="ik-error">The bytes hash to H, but are not an agreement this page can read.</p> : null}
      </Section>

      <Section title="One value, three places">
        <table className="ik-table" data-integra-three-places>
          <tbody>
            <tr>
              <th>The agreement&apos;s hash, measured by this browser</th>
              <td>
                <code>{atr.state === "done" ? atr.value.computed : "…"}</code> {atr.state === "done" ? (agreementOk ? "Equals H." : "Does not equal H.") : ""}
              </td>
            </tr>
            <tr>
              <th>The value the payment carried, as the seller received it</th>
              <td {...from(last(events, "payment/arrived"))}>
                <code>{carried ?? "No payment has reached this app."}</code> {carried ? (carried === hash ? "Equals H." : "Does not equal H.") : ""}
              </td>
            </tr>
            <tr>
              <th>
                {purchase.payment === "authorise"
                  ? "The salt in the escrow's event, on the chain"
                  : purchase.payment === "deferred"
                    ? "The anchoring payment's nonce, on the chain"
                    : "The value on the chain"}
              </th>
              <td {...from(chainEvent)}>
                {chain.state === "waiting" ? "Reading the chain…" : null}
                {chain.state === "failed" ? `The chain could not be read: ${chain.why}` : null}
                {chain.state === "done" && !chain.value ? "No transaction is recorded for this purchase." : null}
                {chain.state === "done" && chain.value ? (
                  chain.value.holds ? (
                    <>
                      <code>{hash}</code> is in the transaction&apos;s {chain.value.holds.where}, from contract <code>{shortHash(chain.value.holds.contract)}</code>, in block {chain.value.block}
                      {chain.value.ok ? "" : " (the transaction failed)"}. Equals H.
                    </>
                  ) : (
                    <>The transaction is in block {chain.value.block}, and H is not in it.</>
                  )
                ) : null}{" "}
                {purchase.transaction ? (
                  <a href={explorerTxUrl(purchase.transaction)} target="_blank" rel="noreferrer">
                    Open it on the explorer
                  </a>
                ) : null}
              </td>
            </tr>
          </tbody>
        </table>
        {purchase.payment === "authorise" ? (
          <p className="ik-small">
            A holder of the agreement can confirm the hash from the salt. The chain alone does not reveal it. A promise to pay is authorised into escrow, and is never &quot;Paid&quot;.
            {purchase.capture ? ` Its capture is ${purchase.capture.state}, due ${purchase.capture.due}.` : ""}
            {purchase.capture?.transaction ? (
              <>
                {" "}
                <a href={explorerTxUrl(purchase.capture.transaction)} target="_blank" rel="noreferrer">
                  The capture on the explorer
                </a>
              </>
            ) : null}
          </p>
        ) : null}
      </Section>

      <Section title="Three records" id="records">
        <div className="ik-three">
          <div className="ik-record" data-integra-record="buyer">
            <h3>The buyer&apos;s</h3>
            {buyer.state === "waiting" ? <p className="ik-wait">Asking Integra&apos;s buyer service…</p> : null}
            {buyer.state === "failed" ? <p className="ik-error">The buyer service could not be asked: {buyer.why}</p> : null}
            {buyer.state === "done" && !buyer.value ? <p>{NO_RECORD}</p> : null}
            {buyerRecord ? (
              <>
                <p className="ik-small">
                  The hash was compared in {buyerRecord.comparedIn}. Its goal: &quot;{buyerRecord.goal}&quot; ({buyerRecord.door}, budget {dollars(buyerRecord.budget)}).
                </p>
                <Timeline rows={buyerEvents.map((event) => ({ stream: "buyer" as const, event }))} />
                {buyerRecord.result ? (
                  <p>
                    Outcome <strong>{buyerRecord.result.outcome}</strong>, {buyerRecord.result.signerCalls} signature{buyerRecord.result.signerCalls === 1 ? "" : "s"} made.
                    {buyerRecord.verdict ? ` The judge: ${buyerRecord.verdict.proves ? "proves" : "does not prove"} the scenario. ${buyerRecord.verdict.reasons.join(" ")}` : ""}
                  </p>
                ) : null}
              </>
            ) : null}
          </div>

          <div className="ik-record" data-integra-record="appliance">
            <h3>The appliance&apos;s</h3>
            {record ? (
              <div {...from(statusEvent)}>
                <p>
                  State <strong>{record.view.state}</strong>, expires {record.view.expiresAt}. This is the app&apos;s copy, taken {record.takenAt}; the appliance deletes a paid record about an
                  hour after it expires.
                </p>
                <p className="ik-small">What the appliance says it proves, word for word:</p>
                <pre>{JSON.stringify(record.view.proves, null, 2)}</pre>
                {record.view.settlement ? <pre>{JSON.stringify(record.view.settlement, null, 2)}</pre> : null}
              </div>
            ) : (
              <p className="ik-small">The app holds no copy of the appliance&apos;s record yet.</p>
            )}
            <Timeline rows={sideRows(["appliance"])} />
          </div>

          <div className="ik-record" data-integra-record="seller">
            <h3>The seller&apos;s</h3>
            <p className="ik-small">The app&apos;s own events for this purchase, with the rail&apos;s word as it received it.</p>
            <Timeline rows={sideRows(["seller", "chain"])} />
          </div>
        </div>
      </Section>

      <Section title="The delivery">
        {delivery ? (
          <div {...from(deliveryEvent)}>
            <DeliveryView delivery={delivery} />
            {sentHash ? (
              <p>
                Sent, hash <code>{sentHash}</code>.{" "}
                {receivedHash ? (
                  <>
                    The buyer received <code>{receivedHash}</code>: {receivedHash === sentHash ? "the same." : "not the same."}
                  </>
                ) : (
                  "The buyer's record has no hash of what it received."
                )}
              </p>
            ) : null}
          </div>
        ) : (
          <p>Nothing has been delivered.{purchase.test ? " The test checkout delivers nothing." : ""}</p>
        )}
      </Section>

      <Section title="Check it yourself">
        <ul className="ik-checks">
          <Check ok={atr.state === "done" ? agreementOk : null} text="The agreement's bytes, hashed in this browser, are H." />
          <Check ok={carried ? carried === hash : null} text="The payment the seller received carried H." event={last(events, "payment/arrived")} />
          <Check ok={chain.state === "done" && chain.value ? chain.value.holds !== null : null} text="The chain's transaction holds H." event={chainEvent} />
          <Check ok={chain.state === "done" && chain.value ? chain.value.ok : null} text="The transaction succeeded." event={chainEvent} />
          {deferred ? (
            <Check
              ok={chain.state === "done" && chain.value ? chain.value.toTreasury === BigInt(ANCHOR_AMOUNT) : null}
              text={`The anchoring payment moved ${usdc(ANCHOR_AMOUNT)} to the seller's treasury, and no more: the price is owed, not paid.`}
              event={chainEvent}
            />
          ) : null}
          <Check
            ok={buyerCompared ? buyerCompared.data.equal === true : null}
            text="The buyer fetched the agreement, hashed it, and found it equal to the hash the challenge advertised."
            event={buyerCompared}
          />
          <Check ok={sentHash && receivedHash ? sentHash === receivedHash : null} text="What the buyer received is what the seller sent." event={buyerReceived} />
        </ul>
        <p className="ik-small">The same checks, as commands:</p>
        <pre className="ik-code">{`# the agreement's bytes hash to H (expect ${hash.slice(2)})
curl -s ${ORIGIN}/proof/${hash}/atr | sha256sum

# what the app says of the purchase
curl -s ${ORIGIN}/proof/${hash}.json | jq '.purchase | {state, headline, transaction}'
${deferred ? `
# pay later: what is owed, and when, as the agreement says
curl -s ${ORIGIN}/proof/${hash}/atr | jq '.deferred | {owed, due, anchor}'
` : ""}
# the chain, read from the public endpoint: is H in the transaction's logs?
${
  purchase.transaction
    ? `curl -s -X POST ${PUBLIC_RPC_URL} -H 'content-type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["${purchase.transaction}"]}' \\
  | jq '.result.status, (.result.logs | tostring | ascii_downcase | contains("${hash.slice(2)}"))'`
    : "# no transaction is recorded for this purchase"
}

# the buyer service's record
curl -s ${doc.buyerRecord} | jq '{comparedIn, result, verdict}'`}</pre>
      </Section>

      <Section title="The receipt">
        <p>
          A receipt of this page, with the demonstration sentence: <em>{DEMONSTRATION_SENTENCE}</em>
        </p>
        <button type="button" className="ik-button" onClick={() => window.print()}>
          Print or save as PDF
        </button>
        <p className="ik-small">
          The agreement&apos;s exact bytes: <a href={`/proof/${hash}/atr`}>/proof/{shortHash(hash)}/atr</a>.
        </p>
      </Section>
    </main>
  );
}

function Check({ ok, text, event }: { ok: boolean | null; text: string; event?: EventEnvelope }) {
  return (
    <li className={ok === null ? "ik-check-wait" : ok ? "ik-check-ok" : "ik-check-bad"} {...from(event)}>
      <span className="ik-check-mark">{ok === null ? "Not measured" : ok ? "Holds" : "Does not hold"}</span> {text}
    </li>
  );
}

function AgreementView({ agreement, issue }: { agreement: Agreement; issue: EventEnvelope | undefined }) {
  const { seller, offer, terms, order, deferred, negotiation, delivers, demonstration } = agreement;
  return (
    <article className="ik-agreement" {...from(issue)} data-integra-agreement>
      <h3>Between the seller and the buyer</h3>
      <p>
        <strong>{seller.name}</strong> (<a href={seller.web}>{seller.web}</a>, {seller.contact}) sells to the agent that pays the amount below.
      </p>
      <h3>What is sold</h3>
      <p>
        <strong>{offer.name}.</strong> {offer.about} Listed at {dollars(offer.price)} {offer.currency}.
      </p>
      <h3>The price</h3>
      {deferred ? (
        <>
          <p>
            Listed {dollars(order.price.listed)}
            {order.price.agreed ? `, agreed ${dollars(order.price.agreed)}` : ""}. <strong>Paid later:</strong> {dollars(deferred.owed.price)} owed, due {when(deferred.due.at)}, to be paid as{" "}
            {deferred.owed.usdc} USDC to <code>{shortHash(deferred.owed.to)}</code> on {deferred.owed.network}. {demonstration.prices}
          </p>
          <p>
            Paid at purchase: {order.paid.usdc} USDC ({order.paid.amount} unit) on {order.paid.network}, the anchoring payment, which is not part of the price.
          </p>
          <p className="ik-small">In the agreement&apos;s own words: {deferred.words}</p>
        </>
      ) : (
        <p>
          Listed {dollars(order.price.listed)}
          {order.price.agreed ? `, agreed ${dollars(order.price.agreed)}` : ""}. Paid {order.paid.usdc} USDC ({order.paid.amount} units) on {order.paid.network}. {demonstration.prices}
        </p>
      )}
      {negotiation ? (
        <>
          <h3>The negotiation</h3>
          <ol>
            {negotiation.rounds.map((round) => (
              <li key={round.round}>
                Round {round.round}, the {round.by}: {dollars(round.amount)}. {round.text}
              </li>
            ))}
          </ol>
        </>
      ) : null}
      <h3>The terms</h3>
      <dl>
        {Object.entries(terms.offer).map(([heading, text]) => (
          <div key={heading}>
            <dt>{heading}</dt>
            <dd>{text}</dd>
          </div>
        ))}
      </dl>
      <p className="ik-small">
        The business&apos;s terms document: <a href={terms.document.url}>{terms.document.url}</a>, hash <code>{terms.document.sha256}</code>.
      </p>
      {Object.keys(order.with).length > 0 ? (
        <>
          <h3>What the buyer gave</h3>
          <dl>
            {Object.entries(order.with).map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : null}
      <h3>What will be delivered</h3>
      <p>
        {delivers.kind === "file" ? (
          <>
            The file <strong>{delivers.name}</strong>, {delivers.size} bytes, hash <code>{delivers.sha256}</code>.
          </>
        ) : (
          <>
            A {delivers.kind}, read at <a href={delivers.url}>{delivers.url}</a>.
          </>
        )}{" "}
        {demonstration.delivery}
      </p>
      <h3>What the demonstration does not do</h3>
      <p>
        {demonstration.sentence} {demonstration.collection ?? ""} {demonstration.deferred ?? ""}
      </p>
    </article>
  );
}

function DeliveryView({ delivery }: { delivery: NonNullable<ProofDocument["purchase"]["delivery"]> }) {
  switch (delivery.kind) {
    case "file":
      return (
        <p>
          A file, {delivery.name} ({delivery.mediaType}), {delivery.size} bytes.
        </p>
      );
    case "booking":
      return (
        <p>
          A booking, reference <strong>{delivery.reference}</strong>, {delivery.start} to {delivery.end} ({delivery.timezone}). <a href={delivery.url}>Read it again</a>.
        </p>
      );
    case "access":
      return (
        <div>
          <p>A pass, good until {delivery.until}, for:</p>
          <ul>
            {delivery.files.map((file) => (
              <li key={file.url}>
                {file.name} (<code>{file.url}</code>, with the pass)
              </li>
            ))}
          </ul>
        </div>
      );
    case "answer":
      return (
        <div>
          <p>An answer, done after the payment (<a href={delivery.url}>read it again</a>):</p>
          <blockquote>{delivery.text}</blockquote>
        </div>
      );
    case "order":
      return (
        <p>
          Order <strong>{delivery.number}</strong>: {delivery.items.map((item) => `${item.quantity} × ${item.name}`).join(", ")}. {delivery.note} <a href={delivery.url}>Its state</a>.
        </p>
      );
  }
}
