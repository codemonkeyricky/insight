import { Button, helper as h, Store, Plain, handler, declaredOnly } from "./widgets.js";
import * as w from "./widgets.js";

export const table = { run: handler };

export function render() {
  return <Button label="x" />;
}

export function make() {
  return new Store();
}

export function makePlain() {
  return new Plain();
}

export function pass() {
  return [1, 2].map(h);
}

export function attach() {
  return <div onClick={handler} />;
}

export function intrinsic() {
  return <span className="x" />;
}

export function viaNamespace() {
  return <w.Button label="y" />;
}

export function selfRef(): unknown {
  const again = selfRef;
  return again;
}

export function reexported() {
  return w.helper(1);
}
