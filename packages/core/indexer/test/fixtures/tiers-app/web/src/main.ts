// The items page: a list, a detail panel and a live event stream per item.

export async function loadItems(): Promise<unknown[]> {
  const res = await fetch("/api/items");
  return res.json();
}

export async function loadDetail(id: string, q: string): Promise<unknown> {
  const res = await fetch(`/api/items/${id}/detail${q}`);
  return res.json();
}

export function subscribe(id: string, onEvent: (data: string) => void): EventSource {
  const source = new EventSource(`/api/items/${id}/events`);
  source.onmessage = (ev) => onEvent(ev.data);
  return source;
}

export async function startIndex(): Promise<void> {
  await fetch("/api/index", { method: "POST" });
}

export async function loadLatest(): Promise<unknown> {
  const res = await fetch(`${import.meta.env.VITE_STORAGE_BASE}k/latest.json`);
  return res.json();
}

export async function loadReadme(): Promise<string> {
  const res = await fetch("https://raw.githubusercontent.com/o/r/main/x");
  return res.text();
}
