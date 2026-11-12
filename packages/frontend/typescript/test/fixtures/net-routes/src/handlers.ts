export async function POST(req: Request) {
  return new Response(String(req.url));
}

export const GET = async () => new Response("ok");

export function helper() {
  return 1;
}
