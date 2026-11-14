// A BroadcastChannel with a literal name: its send and its receives share the channel "jobs".
const jobs = new BroadcastChannel("jobs");

export function announce(): void {
  jobs.postMessage({ kind: "ready" });
}

jobs.onmessage = (e: MessageEvent) => {
  console.log(e.data);
};

jobs.addEventListener("message", () => undefined);

// A BroadcastChannel named by a variable, and one received through a parameter: both are dynamic.
export function openNamed(name: string): void {
  const named = new BroadcastChannel(name);
  named.postMessage("hi");
}

export function listenOn(ch: BroadcastChannel): void {
  ch.onmessage = () => undefined;
}

// A MessageChannel: both ports are one channel, identified by where it is made.
export function pair(): void {
  const { port1, port2 } = new MessageChannel();
  port2.onmessage = (e: MessageEvent) => console.log(e.data);
  port1.postMessage("hello");
}

export function viaVariable(): void {
  const ch = new MessageChannel();
  ch.port1.postMessage(1);
  ch.port2.addEventListener("message", () => undefined);
}

// A port that is not traced to its channel in this file is dynamic.
export function untraced(port: MessagePort): void {
  port.postMessage("x");
}

// Locks and atomics.
export function lockWork(name: string): void {
  navigator.locks.request("cache", async () => undefined);
  navigator.locks.request(name, async () => undefined);
}

export function atomics(): void {
  const shared = new Int32Array(new SharedArrayBuffer(16));
  Atomics.wait(shared, 0, 0);
  Atomics.waitAsync(shared, 0, 0);
  Atomics.notify(shared, 0, 1);
  Atomics.add(shared, 1, 1);
  Atomics.sub(shared, 1, 1);
  Atomics.and(shared, 1, 1);
  Atomics.or(shared, 1, 1);
  Atomics.xor(shared, 1, 1);
  Atomics.load(shared, 1);
  Atomics.store(shared, 1, 2);
  Atomics.exchange(shared, 1, 2);
  Atomics.compareExchange(shared, 1, 2, 3);
}
