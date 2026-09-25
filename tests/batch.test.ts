// Spec §11.2: batch extraction when a backlog builds up.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { ChorusRoom } from "../src/chorus.ts";
import { VirtualClock } from "../src/clock.ts";
import { defaultConfig } from "../src/config.ts";
import { HeuristicConfirmer } from "../src/confirm.ts";
import { ClaudeExtractor } from "../src/extract/claude.ts";
import type { LlmCall } from "../src/extract/llm.ts";
import { HeuristicExtractor } from "../src/extract/heuristic.ts";
import { ReplayTransport } from "../src/transport/replay.ts";

const payload = (action: string) => ({
  text: null, action, conditional: false, deadline: null, subject: null,
  predicate: null, polarity: null, conditions: null, hedged: null,
});

/** Answers batch requests by echoing one commitment per message; counts requests. */
function batchingClient(requests: Array<{ system: string; messages: number }>): Anthropic {
  return {
    beta: {
      messages: {
        parse: async (req: { system: string; messages: Array<{ content: string }> }) => {
          const input = JSON.parse(req.messages[0]!.content.split("\n\n")[0]!);
          const msgs: Array<{ index: number; text: string }> = input.messages ?? [{ index: 0, text: input.message.text }];
          requests.push({ system: req.system, messages: msgs.length });
          const events = (text: string) => [
            { type: "commitment", confidence: 0.95, target_agents: [], references: [], payload: payload(text.replace(/^I'll |\.$/g, "")) },
          ];
          const parsed = input.messages
            ? { results: msgs.map((m) => ({ index: m.index, events: events(m.text) })) }
            : { events: events(input.message.text) };
          return { content: [], stop_reason: "end_turn", stop_details: null, parsed_output: parsed, usage: { input_tokens: 1, output_tokens: 1 } };
        },
      },
    },
  } as unknown as Anthropic;
}

describe("batch extraction (§11.2)", () => {
  it("extracts a backlog in one call and applies messages in order", async () => {
    const requests: Array<{ system: string; messages: number }> = [];
    const calls: LlmCall[] = [];
    const clock = new VirtualClock();
    const transport = new ReplayTransport([{ id: "A", name: "Alice" }], () => clock.now());
    const room = new ChorusRoom({
      transport,
      extractor: new ClaudeExtractor({ client: batchingClient(requests), onCall: (c) => calls.push(c) }),
      fallbackExtractor: new HeuristicExtractor(),
      confirmer: new HeuristicConfirmer(),
      clock,
      config: defaultConfig,
    });
    await room.start();

    // Seven messages arrive before Chorus gets to any of them.
    const tasks = ["one", "two", "three", "four", "five", "six", "seven"].map((n) => transport.deliver("A", `I'll write section ${n}.`));
    await Promise.all(tasks);
    await room.idle();

    assert.equal(requests.length, 1, "one batched request");
    assert.equal(requests[0]!.messages, 7);
    assert.equal(calls[0]!.purpose, "batch_extraction");
    const actions = [...room.state.commitments.values()].map((c) => c.action);
    assert.deepEqual(actions, ["write section one", "write section two", "write section three", "write section four", "write section five", "write section six", "write section seven"]);
    assert.equal(room.state.lastProcessedSeq, 7);
    assert.equal(room.state.counters.get("extraction_batches"), 1);
    assert.equal(room.state.counters.get("extraction_backlog_max"), 7);
  });

  it("small backlogs still go one message at a time", async () => {
    const requests: Array<{ system: string; messages: number }> = [];
    const clock = new VirtualClock();
    const transport = new ReplayTransport([{ id: "A", name: "Alice" }], () => clock.now());
    const room = new ChorusRoom({
      transport,
      extractor: new ClaudeExtractor({ client: batchingClient(requests) }),
      confirmer: new HeuristicConfirmer(),
      clock,
      config: defaultConfig,
    });
    await room.start();
    await Promise.all(["a", "b", "c"].map((n) => transport.deliver("A", `I'll write part ${n}.`)));
    await room.idle();
    assert.deepEqual(requests.map((r) => r.messages), [1, 1, 1]);
  });
});
