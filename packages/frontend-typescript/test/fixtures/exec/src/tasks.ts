export async function fetchUser(id: string): Promise<string> {
  return id;
}

export function syncValue(): number {
  return 1;
}

export function onTick(): void {}

export function onDone(): void {}

export function onFlush(): void {}

export function onError(err: unknown): void {
  console.error(err);
}
