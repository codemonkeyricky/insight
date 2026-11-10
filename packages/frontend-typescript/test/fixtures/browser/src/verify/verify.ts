import { meshThickness } from "./mesh.js";

export function verify(v: number): boolean {
  return meshThickness(v) > 1;
}
