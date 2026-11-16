import { describe, expect, it } from "vitest";
import ts from "typescript";
import { matchStoreAccess } from "../src/effects.js";

/** The outermost call of a one-statement snippet: the call the snippet's expression statement makes. */
function callOf(code: string): ts.CallExpression {
  const sf = ts.createSourceFile("worker.ts", code, ts.ScriptTarget.Latest, true);
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (ts.isCallExpression(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (found === undefined) throw new Error(`no call in ${code}`);
  return found;
}

const bindings = new Map([
  ["INDEX", "cloudflare-kv"],
  ["DB", "cloudflare-d1"],
]);
const envNames = new Set(["env"]);
const opOf = (code: string): string | undefined => {
  const m = matchStoreAccess(callOf(code), bindings, envNames);
  return m === undefined ? undefined : (m.attrs.op as string);
};

describe("store op lookup", () => {
  it("gives no store fact for a prototype member of a binding (valueOf, toString, constructor)", () => {
    expect(matchStoreAccess(callOf("env.INDEX.valueOf();"), bindings, envNames)).toBeUndefined();
    expect(matchStoreAccess(callOf("env.INDEX.toString();"), bindings, envNames)).toBeUndefined();
    expect(matchStoreAccess(callOf("env.INDEX.constructor();"), bindings, envNames)).toBeUndefined();
  });

  it("still reads the declared ops of a KV binding", () => {
    expect(opOf("env.INDEX.get('k');")).toBe("read");
    expect(opOf("env.INDEX.put('k', 'v');")).toBe("write");
  });
});

describe("D1 prepare", () => {
  it("is a write when the statement starts with a write keyword, in any case and after whitespace", () => {
    expect(opOf('env.DB.prepare("INSERT INTO t (a) VALUES (1)");')).toBe("write");
    expect(opOf('env.DB.prepare("  update t set a = 1");')).toBe("write");
    expect(opOf('env.DB.prepare("\\n  DELETE FROM t");')).toBe("write");
    expect(opOf("env.DB.prepare(`REPLACE INTO t VALUES (${id})`);")).toBe("write");
    expect(opOf("env.DB.prepare(`CREATE TABLE t (a)`);")).toBe("write");
    expect(opOf('env.DB.prepare("drop table t");')).toBe("write");
    expect(opOf('env.DB.prepare("ALTER TABLE t ADD c");')).toBe("write");
  });

  it("is a read for a select, and for a statement that is not a literal", () => {
    expect(opOf('env.DB.prepare("SELECT * FROM t");')).toBe("read");
    expect(opOf("env.DB.prepare(`select * from t where id = ${id}`);")).toBe("read");
    expect(opOf("env.DB.prepare(sql);")).toBe("read");
  });

  it("reads past leading SQL comments to the statement's first keyword", () => {
    expect(opOf('env.DB.prepare("-- audit\\nDELETE FROM t");')).toBe("write");
    expect(opOf('env.DB.prepare("/* nightly */ INSERT INTO t VALUES (1)");')).toBe("write");
    expect(opOf('env.DB.prepare("-- just a note\\nSELECT * FROM t");')).toBe("read");
    expect(opOf('env.DB.prepare("/* DELETE */ SELECT * FROM t");')).toBe("read");
  });

  it("is a write for a WITH statement that holds a write keyword as code, and a read for one that does not", () => {
    expect(opOf('env.DB.prepare("WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x");')).toBe("write");
    expect(opOf('env.DB.prepare("with old as (select id from t) delete from t where id in (select id from old)");')).toBe("write");
    expect(opOf('env.DB.prepare("WITH x AS (SELECT replace(a, \'b\', \'c\') AS r FROM t) SELECT * FROM x");')).toBe("read");
    expect(opOf('env.DB.prepare("WITH x AS (SELECT \'update\' AS w FROM t) SELECT * FROM x");')).toBe("read");
    expect(opOf('env.DB.prepare("WITH x AS (SELECT 1) SELECT * FROM x");')).toBe("read");
  });

  it("does not read a write keyword that only appears inside the statement", () => {
    expect(opOf('env.DB.prepare("SELECT * FROM t WHERE note = \'insert\'");')).toBe("read");
  });
});
