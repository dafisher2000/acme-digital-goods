// A booking offer's slots (design §5, business.ts `DeliversBooking`): the `times` on the `days`, in `timezone`, from
// today to `ahead` days on, each as the UTC instant it starts. The store's `supply` and `claimAndTake` take the free
// ones from `slotsOf`, and delivery reads the one a checkout took.
import type { Delivers, IsoTime, Weekday } from "@demo-factory/interfaces";

type Booking = Extract<Delivers, { kind: "booking" }>;

const WEEKDAYS: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface Wall {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
}

function partsIn(timeZone: string, instant: number): Wall & { weekday: Weekday } {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(instant))) p[part.type] = part.value;
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    hh: Number(p.hour),
    mm: Number(p.minute),
    weekday: p.weekday!.slice(0, 3).toLowerCase() as Weekday,
  };
}

/** The UTC instant (ms) at which the wall clock of `timeZone` reads `w`. */
function wallToInstant(timeZone: string, w: Wall): number {
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm);
  // The zone's offset at that instant, found by reading the zone's clock at a first guess, twice for a change of offset.
  let guess = asUtc;
  for (let i = 0; i < 2; i++) {
    const seen = partsIn(timeZone, guess);
    const offset = Date.UTC(seen.y, seen.m - 1, seen.d, seen.hh, seen.mm) - guess;
    guess = asUtc - offset;
  }
  return guess;
}

/** Every slot of the offer from `now` to `ahead` days on, in order, as ISO UTC times. */
export function slotsOf(delivers: Booking, now: number = Date.now()): IsoTime[] {
  const today = partsIn(delivers.timezone, now);
  const out: IsoTime[] = [];
  for (let day = 0; day <= delivers.ahead; day++) {
    const date = new Date(Date.UTC(today.y, today.m - 1, today.d + day));
    const weekday = WEEKDAYS[date.getUTCDay()]!;
    if (!delivers.days.includes(weekday)) continue;
    for (const time of delivers.times) {
      const [hh, mm] = time.split(":").map(Number) as [number, number];
      const start = wallToInstant(delivers.timezone, {
        y: date.getUTCFullYear(),
        m: date.getUTCMonth() + 1,
        d: date.getUTCDate(),
        hh,
        mm,
      });
      if (start > now) out.push(new Date(start).toISOString() as IsoTime);
    }
  }
  return [...new Set(out)].sort();
}
