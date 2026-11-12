export default {
  async fetch(req: Request) {
    return new Response(req.url);
  },
};
