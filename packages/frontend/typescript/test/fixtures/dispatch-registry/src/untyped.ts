// An untyped table: its members are inferred, not declared by an interface.
const T = {
  json: {
    parse(log: string): number {
      return log.length;
    },
  },
  text: {
    parse: (log: string): number => log.trim().length,
  },
};

// A keyed lookup into the table, then a member call.
export function runKey(k: "json" | "text", log: string): number {
  return T[k].parse(log);
}

// A loop over every table value: `parse` is declared once per literal.
export function runAll(log: string): number {
  let n = 0;
  for (const t of Object.values(T)) n += t.parse(log);
  return n;
}
