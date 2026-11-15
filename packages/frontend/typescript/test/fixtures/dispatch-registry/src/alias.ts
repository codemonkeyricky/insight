// A named object type: a call through a receiver typed by it dispatches like an interface.
export type Handler = {
  handle(x: number): number;
};

export const doubler: Handler = { handle: (x) => x * 2 };

export function use(h: Handler): number {
  return h.handle(1);
}
