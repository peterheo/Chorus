// Layer 1 (spec §46): exactly what an extractor returns. snake_case, agent
// *names* as written, no IDs. The payload is a closed object with nullable
// fields rather than a free-form record so it works with structured outputs.

import { z } from "zod";

export const EventTypeSchema = z.enum([
  "question",
  "request",
  "commitment",
  "handoff",
  "acknowledgement",
  "answer",
  "decision",
  "dependency",
  "status_update",
  "completion",
  "claim",
  "disagreement",
  "correction",
  "withdrawal",
]);
export type EventType = z.infer<typeof EventTypeSchema>;

export const PayloadSchema = z.object({
  /** question / request: the question in canonical form */
  text: z.string().nullable(),
  /** commitment / completion / status_update / withdrawal: the work */
  action: z.string().nullable(),
  conditional: z.boolean().nullable(),
  deadline: z.string().nullable(),
  /** claim */
  subject: z.string().nullable(),
  predicate: z.string().nullable(),
  polarity: z.enum(["positive", "negative"]).nullable(),
  conditions: z.array(z.string()).nullable(),
  hedged: z.boolean().nullable(),
});
export type Payload = z.infer<typeof PayloadSchema>;

export const ExtractedEventSchema = z.object({
  type: EventTypeSchema,
  confidence: z.number().min(0).max(1),
  target_agents: z.array(z.string()),
  references: z.array(z.string()),
  payload: PayloadSchema,
});
export type ExtractedEvent = z.infer<typeof ExtractedEventSchema>;

export const ExtractionResultSchema = z.object({
  events: z.array(ExtractedEventSchema),
});
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

export const emptyPayload: Payload = {
  text: null,
  action: null,
  conditional: null,
  deadline: null,
  subject: null,
  predicate: null,
  polarity: null,
  conditions: null,
  hedged: null,
};

export function event(
  type: EventType,
  payload: Partial<Payload>,
  opts: { confidence?: number; target_agents?: string[]; references?: string[] } = {},
): ExtractedEvent {
  return {
    type,
    confidence: opts.confidence ?? 0.9,
    target_agents: opts.target_agents ?? [],
    references: opts.references ?? [],
    payload: { ...emptyPayload, ...payload },
  };
}

/** Stage-2 confirmation verdicts for duplicate (§18) and conflict (§22) checks. */
export const DuplicateVerdictSchema = z.object({
  verdict: z.enum(["same", "overlapping", "different"]),
  confidence: z.number().min(0).max(1),
});
export type DuplicateVerdict = z.infer<typeof DuplicateVerdictSchema>;

export const ConflictVerdictSchema = z.object({
  verdict: z.enum(["conflict", "not_conflict", "unclear"]),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});
export type ConflictVerdict = z.infer<typeof ConflictVerdictSchema>;
