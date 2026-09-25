// In-memory room state (hackathon profile, spec §7). Persistence plugs in
// behind this class later; everything here is plain data so it can be
// snapshotted as JSON (§69).

import type {
  Agent,
  Claim,
  Commitment,
  Conflict,
  Decision,
  Dependency,
  Handoff,
  FacilitationSession,
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
  handoff: "H",
  decision: "D",
  dependency: "P",
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
  readonly handoffs = new Map<string, Handoff>();
  readonly decisions = new Map<string, Decision>();
  readonly dependencies = new Map<string, Dependency>();
  readonly transitions: Transition[] = [];
  readonly posted: PostedIntervention[] = [];
  /** idempotency keys suppressed by `@chorus wrong` */
  readonly suppressedKeys = new Set<string>();
  /** first room index each candidate key was seen (policy queue TTL, §51) */
  readonly candidateFirstSeen = new Map<string, number>();
  /** facilitate-mode READY TO CLOSE already announced (§25) */
  completionAnnounced = false;
  /** coordination-complete as of the last commit; drives room.ready_to_close (§32) */
  readyToClose = false;
  /** operational counters for §59 metrics (LLM calls, failures, …) */
  readonly counters = new Map<string, number>();
  /** active chorus.watch / chorus.facilitate session (§43) */
  session: FacilitationSession | null = null;
  /** signed receipts issued in this room (§54) */
  readonly receipts: SignedReceiptRecord[] = [];

  /** number of non-Chorus messages seen (spec §11.1) */
  roomIndex = 0;
  /** highest transport sequence fully processed; the resume cursor (§70) */
  lastProcessedSeq = 0;
  private idCounters: Record<string, number> = { Q: 0, C: 0, K: 0, X: 0, H: 0, D: 0, P: 0 };

  constructor(mode: Mode) {
    this.mode = mode;
  }

  nextId(kind: ObjectKind): string {
    const p = PREFIX[kind];
    this.idCounters[p] = (this.idCounters[p] ?? 0) + 1;
    return `${p}${this.idCounters[p]}`;
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

  object(id: string): Question | Commitment | Claim | Conflict | Handoff | Decision | Dependency | undefined {
    return (
      this.questions.get(id) ??
      this.commitments.get(id) ??
      this.claims.get(id) ??
      this.conflicts.get(id) ??
      this.handoffs.get(id) ??
      this.decisions.get(id) ??
      this.dependencies.get(id)
    );
  }

  activeDecisions(): Decision[] {
    return [...this.decisions.values()].filter((d) => d.status === "active");
  }

  waitingDependencies(): Dependency[] {
    return [...this.dependencies.values()].filter((p) => p.status === "waiting");
  }

  pendingHandoffs(): Handoff[] {
    return [...this.handoffs.values()].filter((h) => h.status === "pending");
  }

  record(t: Transition): void {
    this.transitions.push(t);
  }

  /**
   * §65 retention: drop the text of messages older than the cutoff. The
   * message stubs (ID, sequence, author) stay so citations like #12 still
   * resolve. Returns how many were pruned.
   */
  prune(cutoffIso: string): number {
    let n = 0;
    for (const m of this.messages) {
      if (m.timestamp < cutoffIso && m.text !== "") {
        m.text = "";
        n++;
      }
    }
    return n;
  }

  count(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
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

  /** Plain-JSON snapshot of everything (spec §69). */
  toJSON(): RoomSnapshot {
    return {
      version: 1,
      mode: this.mode,
      chorusAgentId: this.chorusAgentId,
      roomIndex: this.roomIndex,
      lastProcessedSeq: this.lastProcessedSeq,
      counters: { ...this.idCounters },
      metricCounters: [...this.counters],
      session: this.session,
      receipts: this.receipts,
      completionAnnounced: this.completionAnnounced,
      readyToClose: this.readyToClose,
      agents: [...this.agents.values()],
      messages: this.messages,
      questions: [...this.questions.values()],
      commitments: [...this.commitments.values()],
      claims: [...this.claims.values()],
      conflicts: [...this.conflicts.values()],
      handoffs: [...this.handoffs.values()],
      decisions: [...this.decisions.values()],
      dependencies: [...this.dependencies.values()],
      transitions: this.transitions,
      posted: this.posted,
      suppressedKeys: [...this.suppressedKeys],
      candidateFirstSeen: [...this.candidateFirstSeen],
    };
  }

  static fromJSON(raw: unknown): RoomState {
    const j = raw as RoomSnapshot;
    if (j.version !== 1) throw new Error(`Unsupported room snapshot version ${String(j.version)}`);
    const s = new RoomState(j.mode);
    s.chorusAgentId = j.chorusAgentId;
    s.roomIndex = j.roomIndex;
    s.lastProcessedSeq = j.lastProcessedSeq;
    s.idCounters = { ...j.counters };
    for (const [k, v] of j.metricCounters ?? []) s.counters.set(k, v);
    s.session = j.session ?? null;
    s.receipts.push(...(j.receipts ?? []));
    s.completionAnnounced = j.completionAnnounced;
    s.readyToClose = j.readyToClose ?? false;
    for (const a of j.agents) s.agents.set(a.id, a);
    for (const m of j.messages) {
      s.messages.push(m);
      s.messageIds.add(m.id);
    }
    for (const q of j.questions) s.questions.set(q.id, q);
    for (const c of j.commitments) s.commitments.set(c.id, c);
    for (const k of j.claims) s.claims.set(k.id, k);
    for (const x of j.conflicts) s.conflicts.set(x.id, x);
    for (const h of j.handoffs) s.handoffs.set(h.id, h);
    for (const d of j.decisions ?? []) s.decisions.set(d.id, d);
    for (const p of j.dependencies ?? []) s.dependencies.set(p.id, p);
    s.transitions.push(...j.transitions);
    s.posted.push(...j.posted);
    for (const k of j.suppressedKeys) s.suppressedKeys.add(k);
    for (const [k, v] of j.candidateFirstSeen) s.candidateFirstSeen.set(k, v);
    return s;
  }
}

export interface SignedReceiptRecord {
  operation: string;
  body: Record<string, unknown>;
  sha256: string;
  signature: string;
  key_id: string;
  messageId?: string;
}

export interface RoomSnapshot {
  version: 1;
  mode: Mode;
  chorusAgentId: string | null;
  roomIndex: number;
  lastProcessedSeq: number;
  counters: Record<string, number>;
  metricCounters?: Array<[string, number]>;
  session?: FacilitationSession | null;
  receipts?: SignedReceiptRecord[];
  completionAnnounced: boolean;
  readyToClose?: boolean;
  agents: Agent[];
  messages: Message[];
  questions: Question[];
  commitments: Commitment[];
  claims: Claim[];
  conflicts: Conflict[];
  handoffs: Handoff[];
  /** absent in snapshots written before decisions existed */
  decisions?: Decision[];
  dependencies?: Dependency[];
  transitions: Transition[];
  posted: PostedIntervention[];
  suppressedKeys: string[];
  candidateFirstSeen: Array<[string, number]>;
}
