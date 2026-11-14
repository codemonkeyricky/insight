// Dev-only harness: renders StateDiagram with fixtures. Served by `vite`, not part of the production build
// (the build's only entry is index.html).
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "../src/styles.css";
import { StateDiagram } from "../src/components/StateDiagram";
import { hubConnectionMachine, syntheticMachine } from "../test/fixtures/hubConnectionMachine";
import type { StateMachineView } from "../src/api";

const small: StateMachineView = {
  type: "state-machine",
  id: "machine:Small.status",
  title: "Small.status",
  holder: { id: "Small.status", name: "Small.status", domainKind: "union" },
  states: [
    { id: "a|●", label: "●", kind: "initial" },
    { id: "a|idle", label: "idle", kind: "state" },
    { id: "a|error", label: "error", kind: "state" },
  ],
  transitions: [
    { id: "x1", from: "a|●", to: "a|idle", confidence: "exact", sites: [] },
    { id: "x2", from: "a|idle", to: "a|error", label: "fail", confidence: "exact", sites: [] },
  ],
};

const only = new URLSearchParams(location.search).get("only");
const machines = [hubConnectionMachine, small, syntheticMachine(9)].filter((m, i) => only === null || String(i) === only);

createRoot(document.getElementById("root") as HTMLElement).render(
  <main style={{ padding: 16, display: "grid", gap: 28, maxWidth: 1300, margin: "0 auto" }}>
    {machines.map((m) => (
      <section key={m.id}>
        <h3>{m.title}</h3>
        <StateDiagram view={m} onPick={(p) => console.log("pick", p.label)} />
      </section>
    ))}
  </main>,
);
