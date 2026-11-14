import type { Item } from "../src/build.js";

const call = (label: string, target?: string): Item => ({ t: "step", role: "call", label, ...(target ? { target } : {}) });
const ret: Item = { t: "term", role: "return", label: "return" };
const brk: Item = { t: "term", role: "break", label: "break" };
const branch = (label: string, t: Item[], f: Item[], complete = true): Item => ({
  t: "fork",
  role: "branch",
  label,
  complete,
  arms: [
    { label: "then", kind: "true", body: t },
    { label: "else", kind: "false", body: f },
  ],
});

/** A step; an if whose true arm falls through and whose else has two steps; a for loop with an if inside; a switch; a try; a return. */
export const FIXTURE: Item[] = [
  call("prep()"),
  branch("a > 0", [call("t1()")], [call("e1()"), call("e2()")]),
  { t: "loop", label: "for x of xs", body: [branch("x < 0", [call("neg()")], [], false), call("use(x)")] },
  { t: "loop", label: "while ok", body: [call("tick()"), brk] },
  {
    t: "fork",
    role: "switch",
    label: "switch",
    complete: true,
    arms: [
      { label: 'case "a"', kind: "case", body: [call("doA()")] },
      { label: "default", kind: "case", body: [ret] },
    ],
  },
  {
    t: "fork",
    role: "try",
    label: "try",
    complete: true,
    arms: [
      { label: "try", kind: "next", body: [call("risky()")] },
      { label: "catch", kind: "exception", body: [call("recover()")] },
    ],
  },
  call("tail()"),
  ret,
];

export { call, ret, brk, branch };
