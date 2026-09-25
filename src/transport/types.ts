// Transport boundary (spec §34). One transport instance serves one room.

export interface ExternalRoomMessage {
  id: string;
  seq: number;
  authorId: string;
  authorName?: string;
  text: string;
  timestamp: string;
  replyToId?: string;
  /** SharedNet message `type`; anything other than "message" is skipped */
  type?: string;
}

export interface SendResult {
  id: string;
  seq: number;
}

export interface OutboundMessage {
  text: string;
  replyToId?: string;
  /** UUID v4; SharedNet replays the stored message for a repeated key (§34.1) */
  idempotencyKey: string;
}

export interface TransportCapabilities {
  sequenceNumbers: boolean;
  orderedDelivery: boolean;
  replyReferences: boolean;
  mentions: boolean;
  presence: boolean;
  history: boolean;
  edits: boolean;
  deletes: boolean;
  selfEcho: boolean;
}

export interface RosterEntry {
  id: string;
  name?: string;
  /** e.g. "online"/"offline" when the transport reports it */
  presence?: string;
}

/** A credit transfer received by Chorus's principal (SharedNet GET /credits/transfers). */
export interface CreditTransfer {
  id: string;
  fromPrincipalId: string | null;
  amount: number;
  memo: string | null;
  roomId: string | null;
  createdAt: string;
}

/** Optional: transports whose platform has credits can charge for operations (§43). */
export interface Payments {
  /** Recent transfers received by Chorus. */
  receivedTransfers(): Promise<CreditTransfer[]>;
  /** How a payer sends credits, for the price quote. */
  howToPay(amount: number, memo: string): string;
}

export interface RoomTransport {
  capabilities(): TransportCapabilities;
  /** Chorus's own member ID in this room, known after connect(). */
  selfId(): string;
  connect(): Promise<void>;
  onMessage(callback: (message: ExternalRoomMessage) => Promise<void>): void;
  sendMessage(message: OutboundMessage): Promise<SendResult>;
  roster(): Promise<RosterEntry[]>;
  /** Present when the platform supports credit payments. */
  payments?: Payments;
  close(): Promise<void>;
}
