import { byExit, type ParseResult } from "./parsers.js";

// A gate definition: a parser the caller invokes through the interface.
export interface Def {
  parse: (log: string, code: number) => ParseResult;
}

const parse = (log: string): ParseResult => ({ ok: log.length > 0, summary: log });

// Four implementations: an inline arrow, an imported function bound by name, a shorthand, and a separate typed const.
export const GATES: Record<string, Def> = {
  inline: { parse: (log, code) => ({ ok: code === 0 && log === "", summary: "inline" }) },
  imported: { parse: byExit },
  shorthand: { parse },
};

export const separate: Def = { parse: (log) => ({ ok: log.includes("x"), summary: "separate" }) };

// A call through the interface-typed receiver: its candidates are the implementations above.
export function runGate(def: Def): ParseResult {
  return def.parse("", 0);
}
