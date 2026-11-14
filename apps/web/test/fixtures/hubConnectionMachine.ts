// A hand-written state machine equal to the expected SignalR HubConnectionState diagram
// (dotnet/aspnetcore, src/SignalR/clients/ts/signalr/src/HubConnection.ts), plus one self-loop and one unentered state.
import type { Span, StateMachineView } from "../../src/api";

const FILE = "src/HubConnection.ts";
const at = (line: number): Span => ({ file: FILE, start: [line, 8], end: [line, 60] });
const H = "HubConnection._connectionState";
const st = (name: string, kind: "initial" | "any" | "state" | "unentered" = "state", line?: number) => ({
  id: `${H}|${name}`,
  label: name,
  kind,
  ...(line ? { span: at(line) } : {}),
});
const id = (name: string) => `${H}|${name}`;

let n = 0;
function tr(
  from: string,
  to: string,
  label: string | undefined,
  confidence: "exact" | "inferred" | "heuristic",
  sites: { line: number; fn?: string; guard?: string }[],
) {
  n += 1;
  return {
    id: `t${n}`,
    from: id(from),
    to: id(to),
    ...(label ? { label } : {}),
    confidence,
    sites: sites.map((s) => ({ span: at(s.line), ...(s.fn ? { fn: s.fn } : {}), ...(s.guard ? { guard: s.guard } : {}) })),
  };
}

export const hubConnectionMachine: StateMachineView = {
  type: "state-machine",
  id: `machine:${H}`,
  title: "HubConnectionState",
  holder: { id: H, name: "HubConnection._connectionState", file: FILE, domainKind: "enum", span: at(40) },
  states: [
    st("●", "initial"),
    st("Disconnected", "state", 112),
    st("Connecting", "state", 113),
    st("Connected", "state", 114),
    st("Disconnecting", "state", 115),
    st("Reconnecting", "state", 116),
    st("Faulted", "unentered", 117),
  ],
  transitions: [
    tr("●", "Disconnected", undefined, "exact", [{ line: 128, fn: "constructor" }]),
    tr("Disconnected", "Connecting", "start", "inferred", [{ line: 215, fn: "_startWithStateTransitions", guard: "state === Disconnected" }]),
    tr("Connecting", "Connected", "start", "exact", [{ line: 224, fn: "_startWithStateTransitions" }]),
    tr("Connecting", "Disconnected", "catch", "exact", [{ line: 233, fn: "_startWithStateTransitions", guard: "catch" }]),
    tr("Connected", "Disconnected", "catch", "exact", [{ line: 234, fn: "_startWithStateTransitions", guard: "catch" }]),
    tr("Connecting", "Disconnecting", "_stopInternal", "exact", [{ line: 301, fn: "_stopInternal" }]),
    tr("Connected", "Disconnecting", "_stopInternal", "exact", [{ line: 302, fn: "_stopInternal" }]),
    tr("Reconnecting", "Disconnecting", "_stopInternal", "exact", [{ line: 303, fn: "_stopInternal" }]),
    tr("Disconnecting", "Disconnected", "_completeClose", "inferred", [{ line: 640, fn: "_completeClose", guard: "caller branch: === Disconnecting" }]),
    tr("Connected", "Reconnecting", "_connectionClosed", "inferred", [{ line: 702, fn: "_reconnect", guard: "caller branch: === Connected" }]),
    tr("Reconnecting", "Connected", "_reconnect", "exact", [{ line: 731, fn: "_reconnect", guard: "state === Reconnecting" }, { line: 760, fn: "_reconnect" }]),
    tr("Reconnecting", "Reconnecting", "retry", "heuristic", [{ line: 744, fn: "_reconnect" }]),
  ],
  notes: ["Fixture: hand-traced from source."],
};

/** A second, small machine for list tests. */
export const twoStateMachine: StateMachineView = {
  type: "state-machine",
  id: "machine:Job.status",
  title: "JobStatus",
  holder: { id: "Job.status", name: "Job.status", file: "src/jobs.ts", domainKind: "union" },
  states: [
    { id: "Job.status|●", label: "●", kind: "initial" },
    { id: "Job.status|idle", label: "idle", kind: "state", span: { file: "src/jobs.ts", start: [3, 0], end: [3, 10] } },
    { id: "Job.status|busy", label: "busy", kind: "state" },
  ],
  transitions: [
    { id: "j1", from: "Job.status|●", to: "Job.status|idle", confidence: "exact", sites: [{ span: { file: "src/jobs.ts", start: [9, 0], end: [9, 10] } }] },
    { id: "j2", from: "Job.status|idle", to: "Job.status|busy", label: "run", confidence: "exact", sites: [{ span: { file: "src/jobs.ts", start: [20, 0], end: [20, 10] }, fn: "run" }] },
  ],
};

/** A synthetic wider machine with `count` states in a ring plus a few chords. */
export function syntheticMachine(count: number, name = "Synthetic.state"): StateMachineView {
  const sid = (i: number) => `${name}|S${i}`;
  const states = [{ id: `${name}|●`, label: "●", kind: "initial" as const }, ...Array.from({ length: count }, (_, i) => ({ id: sid(i), label: `State${i}`, kind: "state" as const }))];
  const transitions = [{ id: "s-init", from: `${name}|●`, to: sid(0), confidence: "exact" as const, sites: [] }];
  for (let i = 0; i < count; i++) {
    transitions.push({ id: `s${i}`, from: sid(i), to: sid((i + 1) % count), label: `step${i}`, confidence: "exact" as const, sites: [] });
    if (i % 3 === 0 && count > 4) transitions.push({ id: `c${i}`, from: sid(i), to: sid((i + 3) % count), label: `skip${i}`, confidence: "inferred" as const, sites: [] });
  }
  return { type: "state-machine", id: `machine:${name}`, title: name, holder: { id: name, name, domainKind: "enum" }, states, transitions };
}
