// Spec §43 paid operations with SharedNet credits.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChorusRoom } from "../src/chorus.ts";
import { VirtualClock } from "../src/clock.ts";
import { defaultConfig, type ChorusConfig } from "../src/config.ts";
import { HeuristicConfirmer } from "../src/confirm.ts";
import { HeuristicExtractor } from "../src/extract/heuristic.ts";
import { verifyReceipt } from "../src/receipts.ts";
import { ReplayTransport } from "../src/transport/replay.ts";
import { SharedNetTransport } from "../src/transport/sharednet.ts";

const paidConfig: ChorusConfig = {
  ...defaultConfig,
  mode: "assist",
  operations: { ...defaultConfig.operations, requirePayment: true },
};

async function setup() {
  const clock = new VirtualClock();
  const transport = new ReplayTransport([{ id: "A", name: "Alice" }, { id: "B", name: "Bob" }], () => clock.now());
  const room = new ChorusRoom({
    transport,
    extractor: new HeuristicExtractor(),
    confirmer: new HeuristicConfirmer(),
    clock,
    config: paidConfig,
  });
  await room.start();
  const say = async (agent: string, text: string) => {
    await transport.deliver(agent, text);
    await room.idle();
  };
  const wait = async (seconds: number) => {
    clock.advanceSeconds(seconds);
    await room.tick();
    await room.idle();
  };
  const lastReply = () => transport.sent.at(-1)!.text;
  const memo = () => /--memo (chorus:ord_[0-9a-f]+)/.exec(lastReplyWith("costs"))![1]!;
  const lastReplyWith = (s: string) => [...transport.sent].reverse().find((m) => m.text.includes(s))!.text;
  return { room, transport, clock, say, wait, lastReply, memo };
}

describe("paid operations (§43)", () => {
  it("quotes a price, starts a watch when paid, and cites the payment in the receipt", async () => {
    const { room, transport, say, wait, lastReply, memo } = await setup();
    await say("A", "@chorus watch 20");
    assert.match(lastReply(), /^A 20-minute watch costs 4 credits \(order ord_[0-9a-f]{12}\)\.\nPay with: pay chorus 4 --memo chorus:ord_/);
    assert.equal(room.state.mode, "assist", "nothing starts before payment");

    await wait(20);
    assert.equal(room.state.session, null);

    transport.pay("A", 4, memo());
    await wait(20);
    assert.match(lastReply(), /^Payment received for ord_[0-9a-f]+ \(txn_1, 4 credits\)\. Watching this room for 20 minutes/);
    assert.equal(room.state.mode, "facilitate");
    assert.equal(room.state.session!.payment!.transferId, "txn_1");

    await wait(20 * 60);
    const receipt = room.state.receipts.at(-1)!;
    assert.equal(receipt.body.chorus_operation, "watch_session");
    assert.deepEqual(receipt.body.payment, { transfer_id: "txn_1", amount: 4, from_principal_id: "p_A" });
    assert.equal(verifyReceipt(receipt, room.signer.publicKeyPem), true);
    assert.equal(room.state.mode, "assist");
  });

  it("ignores underpayment, the wrong memo, and payments made before the order", async () => {
    const { room, transport, say, wait, memo } = await setup();
    transport.pay("A", 5, "chorus:ord_000000000000"); // before any order, wrong memo
    await say("A", "@chorus facilitate");
    const m = memo();
    transport.pay("A", 4, m); // costs 5
    transport.pay("A", 5, "for chorus"); // wrong memo
    await wait(20);
    assert.equal(room.state.session, null);
    assert.equal(room.state.orders[0]!.status, "awaiting_payment");
    transport.pay("B", 5, m); // anyone may pay for the room
    await wait(20);
    const session = () => room.state.session; // a fresh read, not narrowed by the assert above
    assert.equal(session()?.kind, "facilitate");
    assert.equal(room.state.orders[0]!.payment!.fromPrincipalId, "p_B");
  });

  it("uses each transfer at most once", async () => {
    const { room, transport, say, wait, memo } = await setup();
    await say("A", "@chorus replay");
    const first = memo();
    transport.pay("A", 3, first);
    await wait(20);
    assert.equal(room.state.orders[0]!.status, "paid");
    await say("B", "@chorus replay");
    // Replaying the same transfer again cannot pay the second order.
    assert.equal(room.state.orders[1]!.status, "awaiting_payment");
    await wait(20);
    assert.equal(room.state.orders[1]!.status, "awaiting_payment");
    assert.equal(room.state.usedTransfers.size, 1);
  });

  it("a paid replay posts a signed analysis naming the payment", async () => {
    const { room, transport, say, wait, lastReply, memo } = await setup();
    await say("A", "@chorus replay");
    transport.pay("A", 3, memo());
    await wait(20);
    assert.match(lastReply(), /^Payment received for ord_[0-9a-f]+ \(txn_1, 3 credits\)\.\n\nPost-room analysis:/);
    const receipt = room.state.receipts.at(-1)!;
    assert.equal(receipt.body.chorus_operation, "post_room_analysis");
    assert.equal((receipt.body.payment as { transfer_id: string }).transfer_id, "txn_1");
  });

  it("unpaid orders expire", async () => {
    const { room, transport, say, wait, memo } = await setup();
    await say("A", "@chorus facilitate");
    const m = memo();
    await wait(16 * 60);
    assert.equal(room.state.orders[0]!.status, "expired");
    transport.pay("A", 5, m);
    await wait(20);
    assert.equal(room.state.session, null, "a late payment does not start an expired order");
  });

  it("receipt, status and the other free commands never ask for payment", async () => {
    const { transport, say } = await setup();
    await say("A", "@chorus receipt");
    assert.match(transport.sent.at(-1)!.text, /RECEIPT facilitation_snapshot/);
  });
});

describe("SharedNet payments", () => {
  it("reads transfers received by Chorus's principal and explains how to pay", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/instances/current")) {
        return new Response(JSON.stringify({ instance: { id: "i_chorus" }, principal: { id: "p_chorus" } }));
      }
      if (u.includes("/credits/transfers")) {
        return new Response(
          JSON.stringify({
            items: [
              { id: "txn_in", from_principal_id: "p_bob", to_principal_id: "p_chorus", amount: 4, memo: "chorus:ord_abc", room_id: "rom_x", created_at: "2026-01-01T00:01:00Z" },
              { id: "txn_out", from_principal_id: "p_chorus", to_principal_id: "p_bob", amount: 1, memo: null, room_id: null, created_at: "2026-01-01T00:02:00Z" },
            ],
          }),
        );
      }
      // The wait loop: hang until close() aborts the request.
      return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }) as typeof fetch;
    try {
      const t = new SharedNetTransport({ baseUrl: "https://example.test", roomId: "rom_x", token: "sni_test" });
      await t.connect();
      const got = await t.payments.receivedTransfers();
      assert.deepEqual(got.map((x) => x.id), ["txn_in"]);
      assert.equal(got[0]!.memo, "chorus:ord_abc");
      assert.equal(t.payments.howToPay(4, "chorus:ord_abc"), "npx -y sharednet@latest pay i_chorus 4 --memo chorus:ord_abc --room");
      await t.close();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
