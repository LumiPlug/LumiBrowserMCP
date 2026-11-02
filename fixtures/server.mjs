import http from "node:http";
import { readFile } from "node:fs/promises";
const html = await readFile(new URL("./orders.html", import.meta.url));
const port = Number(process.env.PORT || 8765);
http
  .createServer((req, res) => {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(html);
  })
  .listen(port, "127.0.0.1", () =>
    console.log(`Local test fixture: http://127.0.0.1:${port}`),
  );
