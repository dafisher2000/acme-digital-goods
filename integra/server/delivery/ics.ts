// The `.ics` file of a booking (RFC 5545): one VEVENT, in UTC.
const stamp = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const text = (s: string) => s.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/[;,]/g, (c) => `\\${c}`);

export function icsOf(b: { reference: string; host: string; summary: string; start: string; end: string; description: string; url: string }): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Integra demo factory//booking//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${b.reference}@${b.host}`,
    `DTSTAMP:${stamp(b.start)}`,
    `DTSTART:${stamp(b.start)}`,
    `DTEND:${stamp(b.end)}`,
    `SUMMARY:${text(b.summary)}`,
    `DESCRIPTION:${text(`${b.description} Reference ${b.reference}. For demonstration only.`)}`,
    `URL:${b.url}`,
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}
