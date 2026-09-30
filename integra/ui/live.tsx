// The live purchase (design §8.4, §10.2): the page instructs Integra's buyer service directly, then follows the buyer's
// stream from that service and the app's own `/api/events`, and draws the events the two share. `/watch/<run>` draws
// the same for a run the page did not start, such as one of the Studio's "Run the scenarios".
import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import type { EventEnvelope, PublicOffer, RunCreated, RunRecord } from "@demo-factory/interfaces";
import { SERVICE_ORIGINS } from "@demo-factory/interfaces/services";
import { business } from "integra:business";
import { dollars, joinedApp, ORIGIN, usdc, useEventStream, when, withEvent } from "./lib.ts";
import { interleave, Timeline } from "./timeline.tsx";

/** What the live purchase shows: an agent buying, two agents negotiating, or an agent at the test checkout (§6). */
export type Scenario = "buy" | "negotiate" | "test";

function goalOf(offer: PublicOffer, scenario: Scenario) {
  const base = `Buy "${offer.name}" from ${business.name}, listed at ${dollars(offer.price)}.`;
  const later = offer.payment === "deferred" ? " It is paid later: only the anchoring payment is made now, and the price is owed." : "";
  return scenario === "negotiate" ? `${base} Try to negotiate the price below the listed price first, then buy.${later}` : `${base} ${later ? later.trim() : "Pay the listed price."}`;
}

/** A run's addresses at the buyer service, for a run this page did not start. */
const addressesOf = (run: string): RunCreated => ({
  run: run as RunCreated["run"],
  events: `${SERVICE_ORIGINS.buyer}/runs/${run}/events`,
  record: `${SERVICE_ORIGINS.buyer}/runs/${run}`,
});

/** `data-from`, `data-seq` and `data-stream` for a fact, from the event that carried it (design §2.5). */
const fromEvent = (event: EventEnvelope | undefined, stream: "buyer" | "app") =>
  event ? ({ "data-from": event.side, "data-seq": event.seq, "data-stream": stream } as const) : {};

const LEDES: Record<Scenario, string> = { buy: "An agent buys", negotiate: "Two agents negotiate", test: "An agent tries the test checkout for" };

/**
 * One purchase, live. With `run`, it follows that run from where it is; without, it starts one for the offer, as the
 * browser's own instruction to the buyer.
 */
export function LivePurchase({ offer, scenario, run }: { offer: PublicOffer; scenario: Scenario; run?: string }) {
  const [created, setCreated] = useState<RunCreated | null>(run ? addressesOf(run) : null);
  const [failure, setFailure] = useState<string | null>(null);
  const [buyer, setBuyer] = useState<EventEnvelope[]>([]);
  const [app, setApp] = useState<EventEnvelope[]>([]);
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [appOpen, setAppOpen] = useState(run !== undefined);
  const started = useRef(false);

  // One run for each opening of the dialog: the browser instructs the buyer, and the demo's server is not in between.
  useEffect(() => {
    if (run || started.current) return;
    started.current = true;
    fetch(`${SERVICE_ORIGINS.buyer}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seller: ORIGIN, goal: goalOf(offer, scenario), budget: offer.price, offer: offer.id, door: "http" }),
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body?.sentence ? `${body.sentence}${body.code ? ` (${body.code})` : ""}` : `The buyer service answered ${response.status}.`);
        setCreated(body as RunCreated);
        setAppOpen(true);
      })
      .catch((error: unknown) => setFailure(error instanceof Error ? error.message : String(error)));
  }, [offer, scenario, run]);

  useEventStream(created?.events ?? null, (event) => setBuyer((list) => withEvent(list, event)));
  useEventStream(appOpen ? "/api/events?after=0" : null, (event) => setApp((list) => withEvent(list, event)));

  const finished = buyer.some((event) => event.step === "run/finished");
  useEffect(() => {
    if (!finished || !created) return;
    fetch(created.record)
      .then((response) => response.json())
      .then((body: RunRecord) => setRecord(body))
      .catch(() => undefined);
    const stop = setTimeout(() => setAppOpen(false), 10_000); // the app's stream stays open only while a purchase runs
    return () => clearTimeout(stop);
  }, [finished, created]);

  const mine = joinedApp(buyer, app);
  const issue = mine.find((event) => event.step === "issue");
  const hash = typeof issue?.data.atrHash === "string" ? issue.data.atrHash : record?.result?.advertised;
  const opened = mine.find((event) => event.step === "checkout/opened");
  const challenge = buyer.find((event) => event.step === "challenge/read");
  const agreed = mine.find((event) => event.step === "negotiation/agreed");
  const ended = buyer.find((event) => event.step === "run/finished");
  // What was paid, from the seller's opening of the checkout, or else from the challenge as the buyer read it.
  const paid =
    typeof opened?.data.amount === "string"
      ? { amount: opened.data.amount, at: fromEvent(opened, "app") }
      : typeof challenge?.data.amount === "string"
        ? { amount: challenge.data.amount, at: fromEvent(challenge, "buyer") }
        : null;
  // Pay later (design §3.9): what is owed, and by when, as the seller opened the checkout; else as the buyer read the
  // agreement it checked.
  const owed = (() => {
    const o = opened?.data.owed as { price?: unknown; due?: unknown } | undefined;
    if (opened && typeof o?.price === "string" && typeof o.due === "string") return { price: o.price, due: o.due, at: fromEvent(opened, "app") };
    const terms = buyer.find((event) => event.step === "atr/deferred");
    if (terms && typeof terms.data.owed === "string" && typeof terms.data.due === "string") return { price: terms.data.owed, due: terms.data.due, at: fromEvent(terms, "buyer") };
    return null;
  })();

  return (
    <div className="ik-live" data-integra-live>
      <p className="ik-lede">
        {scenario === "buy" && buyer.some((event) => event.step === "negotiation/round") ? LEDES.negotiate : LEDES[scenario]} <strong>{offer.name}</strong>. The buyer is Integra&apos;s, at <code>{SERVICE_ORIGINS.buyer.replace("https://", "")}</code>. Its
        events and this app&apos;s own are drawn as they arrive.
      </p>
      <p className="ik-price" data-integra-price>
        Listed price <strong>{dollars(offer.price)}</strong>
        {agreed && typeof agreed.data.amount === "string" ? (
          <>
            {" "}
            · agreed <strong {...fromEvent(agreed, "app")}>{dollars(agreed.data.amount)}</strong>
          </>
        ) : null}
        {paid ? (
          <>
            {" "}
            · paid <strong {...paid.at}>{usdc(paid.amount)}</strong>
            {offer.payment === "deferred" ? ", the anchoring payment, which is not part of the price" : ""}
          </>
        ) : null}
        {owed ? (
          <>
            {" "}
            · owed later <strong {...owed.at}>{dollars(owed.price)}, due {when(owed.due)}</strong>
          </>
        ) : null}
      </p>
      {failure ? <p className="ik-error">The buyer could not start: {failure}</p> : null}
      {!created && !failure ? <p className="ik-wait">Starting the buyer…</p> : null}
      <Timeline rows={interleave(buyer, mine)} />
      {created && !finished ? <p className="ik-wait">Following the purchase…</p> : null}
      {record?.result ? (
        <div className="ik-outcome" {...fromEvent(ended, "buyer")}>
          <strong>Outcome: {record.result.outcome}.</strong>{" "}
          {record.verdict ? (
            <span>
              The judge says this run {record.verdict.proves ? "proves" : "does not prove"} its scenario: {record.verdict.reasons.join(" ")}
            </span>
          ) : null}
        </div>
      ) : null}
      {hash ? (
        <p>
          <Link className="ik-button" href={`/proof/${hash}`}>
            Open the proof of this purchase
          </Link>
        </p>
      ) : null}
    </div>
  );
}

/**
 * `/watch/<run>`: one run of Integra's buyer against this app, followed live as "Watch an agent buy" draws it, for a
 * run this page did not start. The run is read first, for its offer and whether it is at the test checkout.
 */
export function WatchPage({ run }: { run: string }) {
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(addressesOf(run).record)
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body?.sentence ?? `The buyer service answered ${response.status}.`);
        if (live) setRecord(body as RunRecord);
      })
      .catch((error: unknown) => live && setFailure(error instanceof Error ? error.message : String(error)));
    return () => {
      live = false;
    };
  }, [run]);

  const offer = record?.offer ? business.offers.find((candidate) => candidate.id === record.offer) : undefined;
  return (
    <main className="ik-page" data-integra-page="watch">
      <h1>Integra&apos;s buyer, live</h1>
      {failure ? <p className="ik-error">This run could not be read: {failure}</p> : null}
      {!record && !failure ? <p className="ik-wait">Reading the run…</p> : null}
      {record && record.seller !== ORIGIN ? (
        <p className="ik-error">
          This run bought from another demo, at <code>{record.seller}</code>.
        </p>
      ) : record && !offer ? (
        <p className="ik-error">This run names no offer of {business.name}.</p>
      ) : record && offer ? (
        <LivePurchase offer={offer} scenario={record.test ? "test" : "buy"} run={run} />
      ) : null}
    </main>
  );
}
