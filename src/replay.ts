// Replay harness (spec §47, §58): feeds a fixture through a real ChorusRoom
// with a virtual clock, simulating ticks at every tick_seconds boundary.

import { ChorusRoom, type ChorusEvent } from "./chorus.ts";
import { VirtualClock } from "./clock.ts";
import { defaultConfig, type ChorusConfig } from "./config.ts";
import { HeuristicConfirmer, type Confirmer } from "./confirm.ts";
import { HeuristicExtractor } from "./extract/heuristic.ts";
import type { Extractor } from "./extract/types.ts";
import { FixtureSchema, ReplayTransport, parseOffset, type Fixture } from "./transport/replay.ts";
import type { ExternalRoomMessage } from "./transport/types.ts";

export interface ReplayOptions {
  extractor?: Extractor;
  confirmer?: Confirmer;
  config?: ChorusConfig;
}

export interface TraceLine {
  t: number; // seconds from fixture start
  event: ChorusEvent;
}

export interface ReplayResult {
  room: ChorusRoom;
  transport: ReplayTransport;
  trace: TraceLine[];
  /** unsolicited interventions and command replies, in order */
  posted: Array<{ type: string; text: string; seq: number; t: number }>;
}

export function loadFixture(json: unknown): Fixture {
  return FixtureSchema.parse(json);
}

export async function replay(fixtureInput: Fixture | unknown, opts: ReplayOptions = {}): Promise<ReplayResult> {
  const fixture = FixtureSchema.parse(fixtureInput);
  const start = new Date("2026-01-01T00:00:00.000Z");
  const clock = new VirtualClock(start);
  const base = opts.config ?? defaultConfig;
  const config: ChorusConfig = { ...base, mode: fixture.mode ?? base.mode };
  const elapsed = () => (clock.now().getTime() - start.getTime()) / 1000;

  const transport = new ReplayTransport(
    fixture.agents.map((a) => ({ id: a.id, name: a.display_name ?? a.id })),
    () => clock.now(),
  );
  const trace: TraceLine[] = [];
  const posted: ReplayResult["posted"] = [];
  const room = new ChorusRoom({
    transport,
    extractor: opts.extractor ?? new HeuristicExtractor(),
    confirmer: opts.confirmer ?? new HeuristicConfirmer(),
    clock,
    config,
    onEvent: (event) => {
      trace.push({ t: elapsed(), event });
      if (event.kind === "posted") {
        const [type = "", ...rest] = event.detail.split("\n");
        posted.push({ type, text: rest.join("\n"), seq: event.seq ?? 0, t: elapsed() });
      }
    },
  });
  await room.start();

  const tickMs = config.tickSeconds * 1000;
  let nextTick = start.getTime() + tickMs;
  const advanceTo = async (ms: number) => {
    while (nextTick <= ms) {
      clock.set(new Date(nextTick));
      await room.tick();
      await room.idle();
      nextTick += tickMs;
    }
    if (ms > clock.now().getTime()) clock.set(new Date(ms));
  };

  const spacing = parseOffset(fixture.default_spacing ?? "+5s");
  const delivered: ExternalRoomMessage[] = [];
  let at = start.getTime() - spacing;
  for (const m of fixture.messages) {
    at = m.t ? start.getTime() + parseOffset(m.t) : at + spacing;
    await advanceTo(at);
    const replyTo = m.reply_to !== undefined ? delivered[m.reply_to]?.id : undefined;
    const ext = await transport.deliver(m.agent, m.text, replyTo);
    delivered.push(ext);
    await room.idle();
    if (m.deliver_twice) {
      await transport.redeliver(ext);
      await room.idle();
    }
  }
  if (fixture.advance_clock_to) await advanceTo(start.getTime() + parseOffset(fixture.advance_clock_to));
  await room.idle();
  return { room, transport, trace, posted };
}

export function formatTrace(r: ReplayResult): string {
  const lines: string[] = [];
  for (const { t, event } of r.trace) {
    const stamp = `t=+${t.toFixed(0)}s`.padEnd(9);
    const seq = event.seq !== undefined ? `#${event.seq}`.padEnd(5) : "     ";
    const body = event.detail.split("\n");
    lines.push(`${stamp} ${seq} ${event.kind.toUpperCase().padEnd(10)} ${body[0]}`);
    for (const extra of body.slice(1)) lines.push(`${" ".repeat(27)}│ ${extra}`);
  }
  return lines.join("\n");
}
