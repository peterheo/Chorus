export function runE2E(): Promise<Record<string, unknown>>;

export type ScriptLine = { seat: 'A' | 'B' | 'C' | 'D'; key: string; content: string };
export function coordinationScript(memberIds: Record<'A' | 'B' | 'C' | 'D', string>): {
  scan: ScriptLine[];
  assist: ScriptLine[];
};
export function canonicalJson(value: unknown): string;
export function verifyReceiptLocally(envelope: unknown, publicKeyPem: string): boolean;
export function tamperedReceipt<T>(envelope: T): T;
export function leakedValues(text: string, privateValues: readonly unknown[]): number[];
