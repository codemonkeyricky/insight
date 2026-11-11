async function fetch(req: Request) {
  return new Response(req.url);
}

export default { fetch };
