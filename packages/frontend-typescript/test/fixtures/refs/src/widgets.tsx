export function Button(props: { label: string }) {
  return <span>{props.label}</span>;
}

export class Store {
  constructor(readonly name = "store") {}
}

export class Plain {
  size = 0;
}

export function helper(n: number): number {
  return n + 1;
}

export const handler = (): number => 1;

export function declaredOnly(): void {}

export function dec(target: unknown): unknown {
  return target;
}

export class Widget {
  @dec
  draw(): void {}

  run(): void {
    this.draw();
  }

  pick(): (n: number) => number {
    return this.scale;
  }

  scale(n: number): number {
    return n * 2;
  }
}
