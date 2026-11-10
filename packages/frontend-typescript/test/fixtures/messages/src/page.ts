// A page that posts to a worker it constructs, held in a local const.
export function runLocal(): void {
  const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (e) => {
    console.log("local reply", e.data);
  };
  w.postMessage({ seq: 1, n: 2 });
}

// A worker that is only ever used through the parameter it arrives in: nothing is paired.
export function sendVia(worker: Worker): void {
  worker.postMessage({ seq: 2 });
}

// The addEventListener form, with a named handler on the page side and a worker that answers through self.
export function startPing(): void {
  const p = new Worker(new URL("./ping.ts", import.meta.url), { type: "module" });
  p.addEventListener("message", onReply);
  p.postMessage("hello");
}

function onReply(e: MessageEvent): void {
  console.log("ping reply", e.data);
}

// A class that keeps its worker in a field, assigned from a method that creates it.
export class VerifyClient {
  private worker: Worker | undefined;
  private seq = 0;

  ensureWorker(): void {
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e) => this.finish(e.data.seq, e.data);
    this.worker = w;
  }

  pump(): void {
    this.ensureWorker();
    this.worker?.postMessage({ seq: this.seq++, n: 3 });
  }

  finish(seq: number, data: unknown): void {
    console.log("finished", seq, data);
  }
}
