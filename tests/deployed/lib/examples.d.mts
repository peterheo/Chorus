export interface PageExampleCall {
  readonly name: string;
  readonly request: unknown;
  readonly response: unknown;
}

export function buildPageExamples(
  calls: readonly PageExampleCall[],
  identifiers?: Readonly<Record<string, string>>,
): PageExampleCall[];
