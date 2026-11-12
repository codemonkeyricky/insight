// The worker reaches its global object through a cast alias, and answers each message on the same alias.
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage: (message: unknown) => void;
};

ctx.onmessage = (e) => {
  ctx.postMessage({ seq: e.data.seq, report: e.data.n });
};
