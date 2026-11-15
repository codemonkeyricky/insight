// The selected machine rides in the hash query as machine=<holder id>, next to scope= and line=, so a reload keeps it.
import type { LensView, StateMachineView } from "../api";

export const MACHINE_PARAM = "machine";

export function machinesOf(views: readonly LensView[]): StateMachineView[] {
  return views.filter((v): v is StateMachineView => v.type === "state-machine");
}

export function readMachineParam(hash: string): string | null {
  const at = hash.indexOf("?");
  if (at === -1) return null;
  return new URLSearchParams(hash.slice(at + 1)).get(MACHINE_PARAM);
}

/** The hash with machine= set to `id`, or removed when `id` is null. Other parameters stay. */
export function withMachineParam(hash: string, id: string | null): string {
  const raw = hash.startsWith("#") ? hash : `#${hash}`;
  const at = raw.indexOf("?");
  const path = at === -1 ? raw : raw.slice(0, at);
  const params = new URLSearchParams(at === -1 ? "" : raw.slice(at + 1));
  if (id === null) params.delete(MACHINE_PARAM);
  else params.set(MACHINE_PARAM, id);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** The machine a param names, else the first. */
export function selectMachine(machines: readonly StateMachineView[], param: string | null): StateMachineView | undefined {
  return machines.find((m) => m.holder.id === param) ?? machines[0];
}
