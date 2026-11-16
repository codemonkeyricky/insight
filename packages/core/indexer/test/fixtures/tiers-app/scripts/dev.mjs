// Local stand-in for the dev server: answers every request with a placeholder page.
import http from "node:http";

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`dev ${req.url}`);
}).listen(5173);
