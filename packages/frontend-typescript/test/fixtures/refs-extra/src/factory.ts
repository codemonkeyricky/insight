import { Store } from "./store";
import { log } from "./dec";

export function makeStore() {
  return new Store();
}

export const factory = {
  build: () => new Store(),
};

export class Decorated {
  @log
  m() {
    return 1;
  }
}

export function useFactory() {
  return makeStore();
}
