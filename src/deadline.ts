// Deadline parsing (spec §10.2, §16.2). Commitments and handoffs expire only
// when a deadline was actually stated in the room; this turns the stated
// phrase into an absolute time relative to the message.

const RELATIVE = /\b(?:in|within)\s+(\d+|an?|one|two|five|ten|fifteen|thirty)\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\b/i;
const CLOCK = /\b(?:by|before|until|at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*(utc|z))?\b/gi;
const WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, five: 5, ten: 10, fifteen: 15, thirty: 30 };

export interface ParsedDeadline {
  deadline: string; // ISO 8601
  /** the text with the deadline phrase removed */
  rest: string;
}

/**
 * Find a deadline in `text` relative to `at` (the message time). Accepts an
 * ISO timestamp (from an LLM), "in 10 minutes", "within 2 hours",
 * "by 14:30", "by 3pm", "before 15:00 UTC". Clock times are UTC and roll to
 * the next day if already past.
 */
export function parseDeadline(text: string | null | undefined, at: Date): ParsedDeadline | null {
  if (!text) return null;
  const iso = Date.parse(text);
  if (/^\d{4}-\d{2}-\d{2}T/.test(text.trim()) && !Number.isNaN(iso)) {
    return { deadline: new Date(iso).toISOString(), rest: "" };
  }

  const rel = RELATIVE.exec(text);
  if (rel) {
    const n = /^\d+$/.test(rel[1]!) ? Number(rel[1]) : (WORDS[rel[1]!.toLowerCase()] ?? 1);
    const unit = rel[2]!.toLowerCase()[0];
    const ms = unit === "s" ? n * 1000 : unit === "m" ? n * 60_000 : n * 3_600_000;
    return { deadline: new Date(at.getTime() + ms).toISOString(), rest: strip(text, rel.index, rel[0].length) };
  }

  for (const clock of text.matchAll(CLOCK)) {
    let hour = Number(clock[1]);
    const minute = clock[2] ? Number(clock[2]) : 0;
    const ampm = clock[3]?.toLowerCase();
    // "at 3" alone is too ambiguous (could be "at 3 endpoints"): need :mm or
    // am/pm. Skip it and keep looking for a later, clearer deadline.
    if (!clock[2] && !ampm) continue;
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) continue;
    const d = new Date(at);
    d.setUTCHours(hour, minute, 0, 0);
    if (d.getTime() <= at.getTime()) d.setUTCDate(d.getUTCDate() + 1);
    return { deadline: d.toISOString(), rest: strip(text, clock.index, clock[0].length) };
  }
  return null;
}

function strip(text: string, index: number, length: number): string {
  return (text.slice(0, index) + text.slice(index + length)).replace(/\s{2,}/g, " ").replace(/\s+([.,!?])/g, "$1").trim();
}
