import def from "./defaults.js";
import { SqlRepo, type Repo, type Store } from "./repo.js";
import { Shape, Square } from "./shapes.js";
import { api, Clicker, make, outer } from "./props.js";
import type { Wide } from "./wide.js";

// A call through an interface-typed receiver: the implementations are candidates.
export function persist(r: Repo): void {
  r.save();
}

// Through a receiver typed by an extended interface: only the implementers of Store.
export function persistStore(s: Store): void {
  s.save();
}

// Through a receiver typed by the class itself: an ordinary edge to its own method.
export function direct(s: SqlRepo): void {
  s.save();
}

// Through an abstract class: every concrete subclass that overrides area.
export function area(s: Shape): number {
  return s.area();
}

export function squareArea(s: Square): number {
  return s.area();
}

// Over the cap: 35 implementers, of which the first 32 by id are kept.
export function sweep(w: Wide): number {
  return w.go();
}

export function callProps(): number {
  api.load();
  api.save(1);
  def.ping();
  outer.inner.deep();
  new Clicker().onX();
  new Clicker().handlers.onY();
  return make();
}
