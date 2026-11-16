export class Store {
  constructor() {}
  load(): number {
    return 1;
  }
  private secret(): number {
    return 2;
  }
  #hidden(): number {
    return 3;
  }
  get size(): number {
    return 4;
  }
}

class Internal {
  run(): number {
    return 5;
  }
}

export default class Main {
  go(): number {
    return 6;
  }
}

function helper(): number {
  return 7;
}

export { helper as renamed };

export function direct(): number {
  return 8;
}

export const arrow = (): number => 9;

const listedArrow = (): number => 10;
export { listedArrow };
