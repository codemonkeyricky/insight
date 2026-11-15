import type { Mode } from "./component.js";

function useState<T>(v: T): [T, (n: T) => void] {
  return [v, () => undefined];
}

/** A local function that is not React's: no holder, no write. */
export function Widget(): void {
  const [m, setM] = useState<Mode>("view");
  setM("edit");
  void m;
}
