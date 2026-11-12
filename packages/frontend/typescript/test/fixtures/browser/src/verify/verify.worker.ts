import { verify } from "./verify.js";

const ctx = self as unknown as { onmessage: ((e: { data: number }) => void) | null };
ctx.onmessage = (e) => {
  verify(e.data);
};
