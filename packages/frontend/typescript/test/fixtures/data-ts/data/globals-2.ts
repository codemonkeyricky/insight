export function readFlag(): boolean {
  return globalThis.flag;
}

export function castFlag(): void {
  (globalThis as Record<string, unknown>).flag = false;
}

export function where(): string {
  return window.location.href;
}
