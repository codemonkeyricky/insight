export const api = {
  onClick() {
    return 1;
  },
  load: () => 2,
};

export function useApi() {
  return api.onClick();
}

export function pass(cb: () => number) {
  return cb();
}

export function viaProp() {
  return pass(api.onClick);
}

export const handlers = {
  run() {
    return 3;
  },
};

export function callRun() {
  return handlers.run();
}

export class Local {
  n = 1;
  go() {
    return this.step();
  }
  step() {
    return this.n;
  }
}
