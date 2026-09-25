import type { ExtractedEvent } from "../schemas/llm.ts";

export interface ExtractionContext {
  author: string; // display name
  replyTo?: { author: string; text: string };
  recent: Array<{ seq: number; author: string; text: string }>;
  roster: string[];
  openObjects: Array<{ id: string; summary: string; owner?: string }>;
}

export interface Extractor {
  readonly name: string;
  extract(text: string, ctx: ExtractionContext): Promise<ExtractedEvent[]>;
  /**
   * Optional (§11.2): extract several queued messages in one call. Returns one
   * event list per item, in order. Used when the room's backlog grows.
   */
  extractBatch?(items: Array<{ text: string; ctx: ExtractionContext }>): Promise<ExtractedEvent[][]>;
}
