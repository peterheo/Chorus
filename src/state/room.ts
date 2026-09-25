// In-memory room state (hackathon profile, spec §7). Persistence plugs in
// behind this class later; everything here is plain data so it can be
// snapshotted as JSON (§69).

import type {
  Agent,
  Claim,
  Commitment,
  Conflict,
  Message,
  ObjectKind,
  PostedIntervention,
  Question,
  Transition,
} from "./types.ts";
import type { Mode } from "../config.ts";

const PREFIX: Record<ObjectKind, string> = {
  question: "Q",
  commitment: "C",
  claim: "K",
  conflict: "X",
};

export class RoomState {
  mode: Mode;
  chorusAgentId: string | null = null;

  readonly agents = new Map<string, Agent>();
  readonly messages: Message[] = [];
  readonly messageIds = new Set<string>();
  readonly questions = new Map<string, Question>();
  readonly commitments = new Map<string, Commitment>();
  readonly claims = new Map<string, Claim>();
  readonly conflicts = new Map<string, Conflict>();
  readonly transitions: Transition[] = [];
  readonly posted: PostedIntervention[] = [];
  /** idempotency keys suppressed by `@chorus wrong` */
  readonly suppressedKeys = new Set<string>();

  /** number of non-Chorus messages seen (spec §11.1) */
  roomIndex = 0;
  private counters: Record<string, number> = { Q: 0, C: 0, K: 0, X: 0 };

  constructor(mode: Mode) {
    this.mode = mode;
  }

  nextId(kind: ObjectKind): string {
    const p = PREFIX[kind];
    this.counters[p] = (this.counters[p] ?? 0) + 1;
    return `${p}${this.counters[p]}`;
  }

  message(id: string): Message | undefined {
    return this.messages.find((m) => m.id === id);
  }

  agentName(id: string): string {
    return this.agents.get(id)?.displayName ?? id;
  }

  /** "#12" citation for a message ID (spec §28). */
  cite(messageId: string): string {
    const m = this.message(messageId);
    return m ? `#${m.seq}` : "#?";
  }

  object(id: string): Question | Commitment | Claim | Conflict | undefined {
    return (
      this.questions.get(id) ?? this.commitments.get(id) ?? this.claims.get(id) ?? this.conflicts.get(id)
    );
  }

  record(t: Transition): void {
    this.transitions.push(t);
  }

  openQuestions(): Question[] {
    return [...this.questions.values()].filter((q) => q.status === "open" || q.status === "acknowledged");
  }

  activeCommitments(): Commitment[] {
    return [...this.commitments.values()].filter((c) =>
      ["proposed", "accepted", "in_progress", "blocked"].includes(c.status),
    );
  }

  activeClaims(): Claim[] {
    return [...this.claims.values()].filter((k) => k.status === "active");
  }

  unresolvedConflicts(): Conflict[] {
    return [...this.conflicts.values()].filter((x) => x.status === "candidate" || x.status === "confirmed");
  }

  snapshot(): unknown {
    return {
      mode: this.mode,
      roomIndex: this.roomIndex,
      counters: this.counters,
      questions: [...this.questions.values()],
      commitments: [...this.commitments.values()],
      claims: [...this.claims.values()],
      conflicts: [...this.conflicts.values()],
    };
  }
}
