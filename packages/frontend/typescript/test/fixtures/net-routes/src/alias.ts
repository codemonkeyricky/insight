async function handle(req: Request) {
  return new Response(req.method);
}

export { handle as POST, handle as GET };
