import { fetchUser, onDone, onError, onFlush, onTick, syncValue } from "./tasks.js";

// Awaiting an async call: the caller waits for it.
export async function load(): Promise<string> {
  return await fetchUser("u1");
}

// Not awaited, but the async function still starts.
export function kickoff(): void {
  const pending = fetchUser("u2");
  void pending;
}

// Awaiting a plain function is not a dispatch.
export async function plain(): Promise<number> {
  return await syncValue();
}

// Timers and the microtask queue run the named callback later.
export function schedule(): void {
  setTimeout(onTick, 10);
  queueMicrotask(onFlush);
  process.nextTick(onTick);
}

// Promise callbacks, named.
export function chain(): void {
  fetchUser("u3").then(onDone).catch(onError).finally(onFlush);
}

// An inline arrow is an anonymous function. A callback written inline is that function, so the edge targets the arrow.
export function inline(): void {
  setTimeout(() => onTick(), 10);
  queueMicrotask(() => onFlush());
  fetchUser("u4").then((v) => console.log(v));
}

export class Job {
  run(): void {
    // A method passed by reference resolves like any other function value.
    fetchUser("job").then(this.finish);
  }

  finish(): void {}
}

// Module level: no function encloses this call, so the file itself is the source.
setTimeout(onDone, 0);
