import { verify } from "./verify";

const ctx = self as unknown as Worker;
ctx.onmessage = (e: MessageEvent) => {
  const r = verify(e.data);
  ctx.postMessage(r);
};
