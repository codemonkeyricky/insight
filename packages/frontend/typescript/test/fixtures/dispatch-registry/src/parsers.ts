// Parsers that gate tables bind by name, imported and used as values.
export interface ParseResult {
  ok: boolean;
  summary: string;
}

export function byExit(log: string, code: number): ParseResult {
  return { ok: code === 0, summary: log.slice(-20) };
}

export function parseGuide(log: string): ParseResult {
  return { ok: log.includes("ok"), summary: log };
}
