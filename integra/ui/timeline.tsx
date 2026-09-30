// A list of events, each one a fact under the party that said it: every row carries `data-from` (the event's side) and
// `data-seq` (its number in its stream), as the Studio's check reads them (design §2.5).
import type { EventEnvelope } from "@demo-factory/interfaces";
import { clock, SIDE_NAMES, type StreamName } from "./lib.ts";

export type Row = { stream: StreamName; event: EventEnvelope };

export function Timeline({ rows }: { rows: Row[] }) {
  return (
    <ol className="ik-timeline">
      {rows.map(({ stream, event }) => (
        <li key={`${stream}-${event.seq}`} className="ik-event" data-from={event.side} data-seq={event.seq} data-stream={stream}>
          <span className={`ik-chip ik-side-${event.side}`}>{SIDE_NAMES[event.side]}</span>
          <span className="ik-text">{event.text}</span>
          <span className="ik-meta">
            <code>{event.step}</code> · {event.source} · {clock(event.t)}
          </span>
          {event.step === "agent/decision" && typeof event.data.reason === "string" ? (
            <span className="ik-reason">Reason: {event.data.reason}</span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** Two streams as one list, by the time each event was said. */
export function interleave(buyer: EventEnvelope[], app: EventEnvelope[]): Row[] {
  const rows: Row[] = [
    ...buyer.map((event) => ({ stream: "buyer" as const, event })),
    ...app.map((event) => ({ stream: "app" as const, event })),
  ];
  return rows.sort((a, b) => a.event.t.localeCompare(b.event.t) || a.event.seq - b.event.seq);
}
