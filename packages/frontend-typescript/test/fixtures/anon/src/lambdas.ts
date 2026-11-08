import { fetchUser, onFlush, onTick } from "./tasks.js";

// Outer function: its own flow stays with it, and its map callback is an anonymous function it creates. The inner map is nested.
export function outer(items: number[]): number[] {
  if (items.length === 0) return [];
  return items.map((n) => {
    const doubled = [n].map((m) => m * 2);
    return doubled[0] ?? 0;
  });
}

// A filter callback with control flow of its own: the branch belongs to the lambda, not to filtered.
export function filtered(items: number[]): number[] {
  return items.filter((n) => {
    if (n > 0) return true;
    return false;
  });
}

// Timers, microtasks and promise callbacks written inline: each callback is its own anonymous function.
export function schedule(): void {
  setTimeout(() => onTick(), 10);
  queueMicrotask(() => onFlush());
  fetchUser("u1").then((v) => console.log(v));
}

// An async function expression called on the spot is a task of its own: started here, or awaited by the caller.
export function kick(): void {
  void (async () => {
    await fetchUser("u2");
  })();
}

export async function wait(): Promise<string> {
  return await (async () => {
    return fetchUser("u3");
  })();
}

export class Counter {
  // A class property initialised with an arrow is named by the property, so it stays a method.
  tick = (): number => 1;
}

// A function expression bound to a name keeps that name.
export const named = function helper(): number {
  return 2;
};

// An arrow in an object literal is named by no declaration, so it is a lambda parented by the file.
export const handler = {
  go: () => 3,
};

// Module level: a lambda with no enclosing function is parented by the file.
[1, 2].forEach((n) => onTick());
