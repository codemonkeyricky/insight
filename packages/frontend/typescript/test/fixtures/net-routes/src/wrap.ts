// A wrapper: the URL and the method come from its parameters.
export async function call(method: string, url: string) {
  return fetch(url, { method });
}

export async function callers(id: string) {
  await call("GET", "/api/items");
  await call("POST", `/api/projects/${id}/reindex`);
  await call("DELETE", id);
}
