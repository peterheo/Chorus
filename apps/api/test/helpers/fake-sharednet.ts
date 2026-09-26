import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeMessage {
  id: string;
  sequence: number;
  senderPrincipalId: string;
  senderMemberId: string;
  content: string;
}

interface FakeRoom {
  seatToken: string;
  messages: FakeMessage[];
  /** Every `after` value the watcher polled with, in order. */
  polls: number[];
}

/**
 * A fixture-driven stand-in for the SharedNet contract Chorus relies on (spec D3.7):
 * `GET /api/v1/rooms/{id}/wait?after=N` with a bearer seat token, returning `{items, next_cursor, has_more}`
 * where every item carries server-assigned sender fields and a strictly increasing sequence.
 */
export class FakeSharedNet {
  readonly rooms = new Map<string, FakeRoom>();
  /** When set, every wait answers with this HTTP status (e.g. 401 to simulate a revoked seat). */
  failWith: number | undefined;
  /** When true, items are returned without sender fields (a contract violation). */
  breakContract = false;
  private server: Server | undefined;
  private nextId = 1;
  url = '';

  addRoom(roomId: string, seatToken: string): void {
    this.rooms.set(roomId, { seatToken, messages: [], polls: [] });
  }

  /** Posts a message as the SharedNet server would: it assigns id and sequence, never the sender. */
  post(
    roomId: string,
    message: { memberId: string; principalId: string; content: string; sequence?: number },
  ): FakeMessage {
    const room = this.rooms.get(roomId);
    if (room === undefined) throw new Error(`unknown fake room ${roomId}`);
    const sequence = message.sequence ?? (room.messages.at(-1)?.sequence ?? 0) + 1;
    const posted: FakeMessage = {
      id: `msg_${String(this.nextId++)}`,
      sequence,
      senderPrincipalId: message.principalId,
      senderMemberId: message.memberId,
      content: message.content,
    };
    room.messages.push(posted);
    room.messages.sort((a, b) => a.sequence - b.sequence);
    return posted;
  }

  polls(roomId: string): number[] {
    return this.rooms.get(roomId)?.polls ?? [];
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const match = /^\/api\/v1\/rooms\/([^/]+)\/wait$/.exec(url.pathname);
      const room =
        match?.[1] === undefined ? undefined : this.rooms.get(decodeURIComponent(match[1]));
      if (room === undefined) {
        res.writeHead(404).end();
        return;
      }
      if (this.failWith !== undefined) {
        res.writeHead(this.failWith).end();
        return;
      }
      if (req.headers.authorization !== `Bearer ${room.seatToken}`) {
        res.writeHead(401).end();
        return;
      }
      const after = Number(url.searchParams.get('after') ?? '0');
      room.polls.push(after);
      const reply = () => {
        const items = room.messages
          .filter((m) => m.sequence > after)
          .map((m) =>
            this.breakContract
              ? { id: m.id, sequence: m.sequence, content: m.content }
              : {
                  id: m.id,
                  room_id: 'x',
                  sequence: m.sequence,
                  sender_principal_id: m.senderPrincipalId,
                  sender_instance_id: m.senderMemberId,
                  sender: { member_id: m.senderMemberId, kind: 'guest', name: 'n' },
                  content: m.content,
                  created_at: new Date().toISOString(),
                },
          );
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ items, next_cursor: items.at(-1)?.sequence ?? null, has_more: false }),
        );
      };
      if (room.messages.some((m) => m.sequence > after)) {
        reply();
        return;
      }
      // Nothing new: hold briefly like the real long-poll, then answer with an empty page.
      const timer = setTimeout(reply, 60);
      req.on('close', () => {
        clearTimeout(timer);
      });
    });
    this.server = server;
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    this.url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.server?.close(() => {
        resolve();
      });
    });
  }
}
