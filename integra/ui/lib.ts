// What the kit's pages share: the money as a person reads it, the event streams, and the join of two streams.
import { useEffect, useRef } from "react";
import type { EventEnvelope } from "@demo-factory/interfaces";
import { amountToUsdc } from "@demo-factory/interfaces/price";

export const ORIGIN = window.location.origin;

/** The amount paid, in USDC, as a person reads it: `"1800"` → `"0.0018 USDC"`. */
export const usdc = (amount: string) => `${amountToUsdc(amount)} USDC`;

/** `"18.00"` → `"$18.00"`. */
export const dollars = (price: string) => `$${price}`;

/** An instant as a person reads it, the same in every browser: "6 Oct 2026, 09:00 UTC". */
export const when = (iso: string) =>
  `${new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" })} UTC`;

/** When pay later's price is due, by the offer's rule (design §3.9). */
export function dueRule(due: { kind: "booking" } | { kind: "days"; days: number }): string {
  return due.kind === "booking" ? "when the booked slot starts" : `${due.days} day${due.days === 1 ? "" : "s"} after the purchase`;
}

export function shortHash(hash: string) {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

export function clock(t: string) {
  return new Date(t).toLocaleTimeString([], { hour12: false });
}

/** Follows a server-sent stream. The browser takes it up again from the last `id`, which is the event's `seq`. */
export function useEventStream(url: string | null, onEvent: (event: EventEnvelope) => void) {
  const latest = useRef(onEvent);
  latest.current = onEvent;
  useEffect(() => {
    if (!url) return;
    const source = new EventSource(url);
    source.onmessage = (message) => {
      try {
        latest.current(JSON.parse(message.data) as EventEnvelope);
      } catch {
        /* a frame that is not an event is not drawn */
      }
    };
    return () => source.close();
  }, [url]);
}

/** Adds an event to a stream's list: once for each `seq`, in order. */
export function withEvent(list: EventEnvelope[], event: EventEnvelope): EventEnvelope[] {
  if (list.some((known) => known.seq === event.seq)) return list;
  return [...list, event].sort((a, b) => a.seq - b.seq);
}

const KEYS = ["negotiation", "advertised", "atrHash", "checkout"] as const;

const idsOf = (event: EventEnvelope) =>
  KEYS.flatMap((key) => {
    const value = event.data[key];
    return typeof value === "string" ? [value] : [];
  });

/**
 * The app's events that belong to a run (design §10.2). The two streams are joined on what both sides saw: first the
 * negotiation's id, then the hash the challenge advertised. The buyer's events name both. An app event that carries
 * either joins the run, and brings in the other ids it carries (its checkout, H), so that the events before the
 * challenge and the events after it are the same purchase.
 */
export function joinedApp(buyer: EventEnvelope[], app: EventEnvelope[]): EventEnvelope[] {
  const keys = new Set<string>();
  for (const event of buyer) {
    for (const key of ["negotiation", "advertised"] as const) {
      const value = event.data[key];
      if (typeof value === "string") keys.add(value);
    }
  }
  if (keys.size === 0) return [];
  const taken = new Set<number>();
  for (let pass = 0; pass < 3; pass++) {
    for (const event of app) {
      if (taken.has(event.seq)) continue;
      const ids = idsOf(event);
      if (ids.some((id) => keys.has(id))) {
        taken.add(event.seq);
        ids.forEach((id) => keys.add(id));
      }
    }
  }
  return app.filter((event) => taken.has(event.seq));
}

/** Which of the two streams an event came from, for its `data-stream`. */
export type StreamName = "buyer" | "app";

export const SIDE_NAMES = { buyer: "Buyer", seller: "Seller", appliance: "Appliance", chain: "Chain" } as const;
