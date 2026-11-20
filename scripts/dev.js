import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { POST } from "../api/hunt.js";
import * as batches from "../api/batches.js";
import * as worker from "../api/worker.js";

const files = new Map([
  ["/", ["index.html", "text/html"]],
  ["/style.css", ["style.css", "text/css"]],
  ...["app.js", "batch.js", "game.js"].map((name) => [`/${name}`, [name, "text/javascript"]]),
  ["/sample-run.json", ["sample-run.json", "application/json"]],
  ["/benchmark.json", ["benchmark.json", "application/json"]],
]);
const port = Number(process.env.PORT ?? 4317);
const server = createServer(async (incoming, outgoing) => {
  const origin = `http://127.0.0.1:${port}`;
  const url = new URL(incoming.url, origin);
  try {
    const routes = { "/api/hunt": { POST }, "/api/batches": batches, "/api/worker": worker };
    const handler = routes[url.pathname]?.[incoming.method];
    if (handler) {
      const request = new Request(url, {
        method: incoming.method, headers: incoming.headers,
        ...(!["GET", "HEAD"].includes(incoming.method) && { body: Readable.toWeb(incoming), duplex: "half" }),
      });
      const response = await handler(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(await response.text());
      return;
    }
    const file = files.get(url.pathname);
    if (incoming.method !== "GET" || !file) {
      outgoing.writeHead(404).end("Not found");
      return;
    }
    const [filename, type] = file;
    const data = await readFile(new URL(`../public/${filename}`, import.meta.url));
    outgoing.writeHead(200, { "Content-Type": `${type}; charset=utf-8` }).end(data);
  } catch {
    outgoing.writeHead(500).end("Preview server error");
  }
});
server.listen(port, "127.0.0.1", () => console.log(`Glitch Hunt · http://127.0.0.1:${port}`));
