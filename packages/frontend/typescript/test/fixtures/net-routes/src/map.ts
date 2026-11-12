const map = new Map<string, number>();

export function lookup() {
  return map.get("/x");
}
