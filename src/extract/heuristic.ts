// Deterministic rule-based extractor. It covers the phrasing in spec §12.2
// and the acceptance fixtures, needs no API key, and makes replays exactly
// reproducible. The Claude extractor (claude.ts) handles open-ended language.

import { event, type ExtractedEvent } from "../schemas/llm.ts";
import type { ExtractionContext, Extractor } from "./types.ts";

const HEDGES = /\b(i think|i believe|probably|maybe|perhaps|i guess|not sure|seems? (like|to))\b/i;
const CONDITIONAL_OFFER = /\b(if (nobody|no one|no-one|needed|necessary)|could|might|maybe|possibly)\b/i;
const COMMIT = /\b(?:i'll|i will|i'm going to|i am going to|let me|i'm on|i am on|i'll take)\b\s*(.*)$/i;
const CAPABILITY = /\bi can\b/i;
const STATUS =
  /^(?:(?:i'm|i am)\s+)?(?:still\s+)?(checking|looking into|investigating|working on|verifying|inspecting)\b\s*(.*)$/i;
const COMPLETION = /^(?:(?:i\s+)?(?:have\s+)?)(checked|verified|finished|completed|done|confirmed|looked into|investigated|inspected)\b[\s:,-]*(.*)$/i;
const WITHDRAW =
  /\b(i'll drop (mine|it|that)|dropping (mine|it|that)|never ?mind|i'll leave (it|that)|(?:\w+) has it|scratch that|i withdraw|i'll stand down)\b/i;
const ACK = /^(on it|got it|will do|ack(nowledged)?|i'll answer|i'll get back to you|sure[,.!]?$|accepted)\b/i;
const DECLINE = /\b(i can't (take|do) (it|this|that)|can't take (it|this|that)|i'm not able to|i won't be able to|i'll pass|pass on (it|this|that)|not me)\b/i;
const CORRECTION = /^(correction|actually|update)\b[\s:,-]*/i;
const UNTARGETED_REQUEST = /^(can|could|would|will)\s+(someone|anyone|somebody|anybody|one of you)\b/i;
const YES_NO = /^(yes|yeah|yep|no|nope)\b[\s.,!:-]*/i;
const DECISION =
  /^(?:decision|decided|agreed|final|consensus)\s*[:,-]\s*(.+)$|^(?:let's|let us|we'll|we will|we're going to)\s+(?:go with|use|pick|choose|stick with)\s+(.+)$|^(?:we're |we are )?going with\s+(.+)$/i;
const DEPENDENCY =
  /\b(?:i'm |i am |we're |we are )?(?:waiting (?:on|for)|blocked (?:on|by)|depend(?:s|ing)? on|can't (?:start|continue|proceed) until)\s+(.+)$/i;
const SHORT_ID = /\b([QCHDXKP]\d+)\b/g;
const QUOTED = /^(\w+\s+(said|says|thinks|claimed|claims)\b|"|>)/i;

const CONDITION_PATTERNS = [
  /\s+((?:with)?in the first [^,.;]+)$/i,
  /\s+((?:with)?in \d+ [^,.;]+)$/i,
  /\s+(within [^,.;]+)$/i,
  /\s+(after [^,.;]+)$/i,
  /\s+(before [^,.;]+)$/i,
  /\s+(during [^,.;]+)$/i,
  /\s+(for (?:the first )?\d+ [^,.;]+)$/i,
  /\s+(for (?:prepaid|monthly|annual|yearly|enterprise|free|paid) [^,.;]+)$/i,
  /\s+(on (?:the )?(?:free|paid|enterprise|pro) [^,.;]+)$/i,
  /\s+(when [^,.;]+)$/i,
];

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function stripEnd(s: string): string {
  return s.replace(/[.!?]+$/, "").trim();
}

function splitConditions(clause: string): { core: string; conditions: string[] } {
  const conditions: string[] = [];
  let core = clause;
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of CONDITION_PATTERNS) {
      const m = p.exec(core);
      if (m) {
        conditions.unshift(m[1]!.trim());
        core = core.slice(0, m.index).trim();
        changed = true;
      }
    }
  }
  return { core, conditions };
}

/**
 * Parse a declarative sentence into a claim: "X is/are (not) Y",
 * "X supports Y", "X does not support Y", "X is not available".
 */
export function parseClaim(sentence: string): ExtractedEvent | null {
  let s = stripEnd(sentence);
  if (!s || s.endsWith("?") || QUOTED.test(s)) return null;
  const hedged = HEDGES.test(s);
  s = s.replace(HEDGES, "").replace(/^[\s,]+/, "").trim();
  const { core, conditions } = splitConditions(s);

  // "X supports Y" / "X does not support Y" / "X doesn't support Y"
  let m = /^(.+?)\s+(does not|doesn't|do not|don't|cannot|can't)\s+(support|allow|offer|expose|provide|accept|handle)s?\s+(.+)$/i.exec(core);
  if (m) return claim(`${m[4]} ${m[1]}`, `${m[3]}ed`, "negative", conditions, hedged);
  m = /^(.+?)\s+(supports|allows|offers|exposes|provides|accepts|handles)\s+(.+)$/i.exec(core);
  if (m) return claim(`${m[3]} ${m[1]}`, m[2]!.replace(/s$/, "ed"), "positive", conditions, hedged);

  // "X is/are (not) Y"
  m = /^(.+?)\s+(is|are|was|were)\s+(not\s+|n't\s+)?(.+)$/i.exec(core.replace(/\b(is|are)n't\b/i, "$1 not"));
  if (m) {
    const subject = m[1]!;
    let predicate = m[4]!;
    let polarity: "positive" | "negative" = m[3] ? "negative" : "positive";
    if (/^(unsupported|unavailable|disabled|missing|broken)\b/i.test(predicate)) {
      polarity = polarity === "positive" ? "negative" : "positive";
      predicate = predicate.replace(/^un/i, "").replace(/^disabled/i, "enabled").replace(/^missing/i, "available");
    }
    // "No, streaming is not available" → subject shouldn't include the "no".
    const cleanSubject = subject.replace(YES_NO, "").trim();
    if (!cleanSubject || /^(it|this|that|there|i|we|you)$/i.test(cleanSubject)) return null;
    return claim(cleanSubject, predicate, polarity, conditions, hedged);
  }
  return null;
}

function claim(
  subject: string,
  predicate: string,
  polarity: "positive" | "negative",
  conditions: string[],
  hedged: boolean,
): ExtractedEvent {
  return event(
    "claim",
    {
      subject: subject.toLowerCase().replace(/^the\s+/, "").trim(),
      predicate: predicate.toLowerCase().trim(),
      polarity,
      conditions,
      hedged,
    },
    { confidence: hedged ? 0.8 : 0.93 },
  );
}

function leadingAddressee(sentence: string, roster: string[]): string | null {
  // "B, check X" / "@B please check X"
  const m = /^@?([\w-]+)[,:]\s+/.exec(sentence);
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  return roster.find((r) => r.toLowerCase() === name) ?? null;
}

function questionAddressee(sentence: string, roster: string[]): string | null {
  // "Can B check X?"
  const m = /^(?:can|could|would|will)\s+@?([\w-]+)\s+/i.exec(sentence);
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  return roster.find((r) => r.toLowerCase() === name) ?? null;
}

export class HeuristicExtractor implements Extractor {
  readonly name = "heuristic";

  async extract(text: string, ctx: ExtractionContext): Promise<ExtractedEvent[]> {
    const out: ExtractedEvent[] = [];
    const roster = ctx.roster;
    let isCorrection = false;

    for (const raw of sentences(text)) {
      let s = raw;
      if (CORRECTION.test(s)) {
        isCorrection = true;
        out.push(event("correction", {}, { confidence: 0.92 }));
        s = s.replace(CORRECTION, "");
        if (!s) continue;
      }

      const decision = DECISION.exec(s);
      if (decision) {
        const text = stripEnd(decision[1] ?? decision[2] ?? decision[3] ?? s);
        out.push(event("decision", { text }, { confidence: 0.9, references: [...text.matchAll(SHORT_ID)].map((m) => m[1]!) }));
        continue;
      }

      const dep = DEPENDENCY.exec(s);
      if (dep && !s.endsWith("?")) {
        const text = stripEnd(dep[1]!);
        out.push(
          event("dependency", { text }, {
            confidence: 0.9,
            references: [...s.matchAll(SHORT_ID)].map((m) => m[1]!),
            target_agents: roster.filter((r) => new RegExp(`\\b${r}\\b`, "i").test(text)),
          }),
        );
        continue;
      }

      if (WITHDRAW.test(s) || DECLINE.test(s)) {
        out.push(event("withdrawal", {}, { confidence: 0.9 }));
        continue;
      }
      if (ACK.test(s)) {
        out.push(event("acknowledgement", {}, { confidence: 0.9 }));
        continue;
      }

      // Questions and requests
      if (s.endsWith("?")) {
        const body = stripEnd(s);
        const target = questionAddressee(body, roster) ?? leadingAddressee(body, roster);
        if (UNTARGETED_REQUEST.test(body)) {
          out.push(event("request", { text: s }, { confidence: 0.93 }));
        } else if (target) {
          out.push(event("request", { text: s }, { confidence: 0.92, target_agents: [target] }));
        } else {
          out.push(event("question", { text: s }, { confidence: 0.94 }));
        }
        continue;
      }

      // "B, check X." — targeted imperative request
      const addressee = leadingAddressee(s, roster);
      if (addressee && !COMMIT.test(s)) {
        out.push(
          event("request", { text: stripEnd(s.replace(/^@?[\w-]+[,:]\s+/, "")) }, {
            confidence: 0.9,
            target_agents: [addressee],
          }),
        );
        continue;
      }

      // Commitments ("I'll check X") vs capability ("I can check X")
      const commit = COMMIT.exec(s);
      if (commit && !CAPABILITY.test(s.slice(0, commit.index + 1))) {
        const action = stripEnd(commit[1] ?? "").replace(/\s+too$/i, "") || stripEnd(s);
        const conditional = CONDITIONAL_OFFER.test(s.slice(0, commit.index)) || /\bcould\b/i.test(s);
        out.push(event("commitment", { action, conditional }, { confidence: conditional ? 0.8 : 0.93 }));
        continue;
      }
      if (/\b(if (nobody|no one)|i could)\b/i.test(s) && !CAPABILITY.test(s)) {
        const m = /\bi could\s+(.*)$/i.exec(s);
        out.push(
          event("commitment", { action: stripEnd(m?.[1] ?? s), conditional: true }, { confidence: 0.78 }),
        );
        continue;
      }

      const status = STATUS.exec(s);
      if (status) {
        out.push(event("status_update", { action: stripEnd(`${status[1]} ${status[2] ?? ""}`) }, { confidence: 0.88 }));
        continue;
      }

      const done = COMPLETION.exec(s);
      if (done) {
        out.push(event("completion", { action: stripEnd(done[2] ?? "") || null }, { confidence: 0.9 }));
        const rest = stripEnd(done[2] ?? "");
        const c = rest ? parseClaim(rest) : null;
        if (c) out.push(c);
        continue;
      }

      // "Yes. Refunds are supported." — answer marker, claim in same or next sentence
      const yn = YES_NO.exec(s);
      if (yn) {
        out.push(event("answer", {}, { confidence: 0.9 }));
        s = s.replace(YES_NO, "");
        if (!s) continue;
      }

      const c = parseClaim(s);
      if (c) {
        out.push(c);
        if (ctx.replyTo && !out.some((e) => e.type === "answer")) {
          out.push(event("answer", {}, { confidence: 0.85 }));
        }
      }
    }

    // A correction's claim replaces the author's earlier claim on that subject;
    // mark it so the engine can link them.
    if (isCorrection) {
      for (const e of out) if (e.type === "claim") e.references.push("correction");
    }
    return out;
  }
}
