import { meshThickness } from "./mesh.js";

const ctx = self as unknown as { onmessage: ((e: { data: number }) => void) | null };
ctx.onmessage = (e) => {
  meshThickness(e.data);
};
