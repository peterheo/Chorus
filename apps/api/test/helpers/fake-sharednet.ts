import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeMessage {
  id: string;
  sequence: number;
  senderPrincipalId: string;
  senderMemberId: string;
  senderName: string;
  senderAgentId?: string | null;
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
export interface FakeSeat {
  token: string;
  memberId: string;
  principalId: string;
}

export class FakeSharedNet {
  readonly rooms = new Map<string, FakeRoom>();
  /** invite token -> the room it opens and the seat a join with it yields. */
  readonly invites = new Map<string, { roomId: string; seat: FakeSeat }>();
  /** Seat identities served by `GET /api/v1/instances/current`, by member token. */
  readonly identities = new Map<string, FakeSeat>();
  /** Every join request the server saw (invite tokens are NOT recorded in the clear). */
  joins: { roomId: string; bodyName: unknown; runtimeKind: unknown }[] = [];
  /** Tamper with the join / instance responses to exercise contract failures. */
  joinResponse: ((body: Record<string, unknown>) => unknown) | undefined;
  instanceResponse: ((body: Record<string, unknown>) => unknown) | undefined;
  /** When set, joins answer with this HTTP status. */
  joinFailWith: number | undefined;
  /** When set, every wait answers with this HTTP status (e.g. 401 to simulate a revoked seat). */
  failWith: number | undefined;
  /** When set, conversation message reads answer with this HTTP status. */
  messagesFailWith: number | undefined;
  /** When true, conversation message items omit the sender contract. */
  breakMessagesContract = false;
  /** Every conversation message page requested by a client. */
  readonly messageRequests: {
    roomId: string;
    after: number;
    limit: number;
    order: string | null;
  }[] = [];
  /** When true, items are returned without sender fields (a contract violation). */
  breakContract = false;
  private server: Server | undefined;
  private nextId = 1;
  url = '';

  addRoom(roomId: string, seatToken: string): void {
    this.rooms.set(roomId, { seatToken, messages: [], polls: [] });
  }

  /** Registers an invite: joining `roomId` with it yields `seat`, whose token then opens the room. */
  addInvite(roomId: string, invite: string, seat: FakeSeat): void {
    this.invites.set(invite, { roomId, seat });
    this.identities.set(seat.token, seat);
    const room = this.rooms.get(roomId);
    if (room === undefined)
      this.rooms.set(roomId, { seatToken: seat.token, messages: [], polls: [] });
    else room.seatToken = seat.token;
  }

  /** Posts a message as the SharedNet server would: it assigns id and sequence, never the sender. */
  post(
    roomId: string,
    message: {
      memberId: string;
      principalId: string;
      content: string;
      name?: string;
      sequence?: number;
      agentId?: string;
    },
  ): FakeMessage {
    const room = this.rooms.get(roomId);
    if (room === undefined) throw new Error(`unknown fake room ${roomId}`);
    const sequence = message.sequence ?? (room.messages.at(-1)?.sequence ?? 0) + 1;
    const posted: FakeMessage = {
      id: `msg_${String(this.nextId++)}`,
      sequence,
      senderPrincipalId: message.principalId,
      senderMemberId: message.memberId,
      senderName: message.name ?? 'n',
      senderAgentId: message.agentId ?? null,
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
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      if (req.method === 'GET' && url.pathname === '/api/v1/instances/current') {
        const seat = bearer === undefined ? undefined : this.identities.get(bearer);
        if (seat === undefined) return void res.writeHead(401).end();
        const body = {
          principal: { id: seat.principalId },
          agent: null,
          instance: { id: seat.memberId, principal_id: seat.principalId, revoked_at: null },
        };
        json(200, this.instanceResponse === undefined ? body : this.instanceResponse(body));
        return;
      }
      const joinMatch = /^\/api\/v1\/rooms\/([^/]+)\/join$/.exec(url.pathname);
      if (req.method === 'POST' && joinMatch?.[1] !== undefined) {
        const roomId = decodeURIComponent(joinMatch[1]);
        let raw = '';
        req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
        req.on('end', () => {
          if (this.joinFailWith !== undefined) return void res.writeHead(this.joinFailWith).end();
          const invite = bearer === undefined ? undefined : this.invites.get(bearer);
          if (invite === undefined || invite.roomId !== roomId)
            return void res.writeHead(401).end();
          const parsed = JSON.parse(raw === '' ? '{}' : raw) as {
            name?: unknown;
            runtime?: { kind?: unknown };
          };
          this.joins.push({ roomId, bodyName: parsed.name, runtimeKind: parsed.runtime?.kind });
          const items = (this.rooms.get(roomId)?.messages ?? []).map((m) => ({
            id: m.id,
            sequence: m.sequence,
            content: m.content,
          }));
          const body = { member_token: invite.seat.token, history: { items } };
          json(200, this.joinResponse === undefined ? body : this.joinResponse(body));
        });
        return;
      }
      const match = /^\/api\/v1\/rooms\/([^/]+)\/wait$/.exec(url.pathname);
      const messagesMatch = /^\/api\/v1\/rooms\/([^/]+)\/messages$/.exec(url.pathname);
      if (req.method === 'GET' && messagesMatch?.[1] !== undefined) {
        const roomId = decodeURIComponent(messagesMatch[1]);
        const messageRoom = this.rooms.get(roomId);
        if (messageRoom === undefined) return void res.writeHead(404).end();
        if (this.messagesFailWith !== undefined)
          return void res.writeHead(this.messagesFailWith).end();
        if (req.headers.authorization !== `Bearer ${messageRoom.seatToken}`)
          return void res.writeHead(401).end();
        const after = Number(url.searchParams.get('after') ?? '0');
        const limit = Number(url.searchParams.get('limit') ?? '50');
        const order = url.searchParams.get('order');
        this.messageRequests.push({ roomId, after, limit, order });
        const all = messageRoom.messages.filter((message) => message.sequence > after);
        const page = all.slice(0, limit);
        const items = page.map((message) =>
          this.breakMessagesContract
            ? {
                id: message.id,
                sequence: message.sequence,
                content: message.content,
                type: 'message',
              }
            : {
                id: message.id,
                room_id: roomId,
                sequence: message.sequence,
                sender_principal_id: message.senderPrincipalId,
                sender_instance_id: message.senderMemberId,
                sender: {
                  member_id: message.senderMemberId,
                  kind: 'guest',
                  name: message.senderName,
                },
                type: 'message',
                content: message.content,
                reply_to_message_id: null,
                created_at: new Date().toISOString(),
              },
        );
        json(200, {
          items,
          next_cursor: page.at(-1)?.sequence ?? null,
          has_more: all.length > page.length,
        });
        return;
      }
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
                  sender_agent_id: m.senderAgentId ?? null,
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
