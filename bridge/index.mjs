import fs from "node:fs";
import { endpoint, createBroker } from "./broker.mjs";
import { mcpHost, nativeHost } from "./hosts.mjs";
async function main() {
  if (process.argv.includes("--help")) {
    process.stdout.write(
      "Lumi Browser MCP adapter\nUsage: lumi-browser-adapter [--mcp | --native | --broker]\nDefault: MCP stdio. Chrome origin arguments select native messaging.\n",
    );
    return;
  }
  if (process.argv.includes("--broker")) {
    const { address, token } = endpoint(),
      server = createBroker({ token });
    server.on("error", (e) => {
      process.stderr.write(`Lumi broker: ${e.message}\n`);
      server.shutdown();
      process.exitCode = 1;
    });
    server.listen(address, () => {
      if (process.platform !== "win32") fs.chmodSync(address, 0o600);
    });
    process.on("SIGTERM", () => server.shutdown());
    process.on("SIGINT", () => server.shutdown());
  } else if (
    process.argv.includes("--native") ||
    process.argv.some((a) => a.startsWith("chrome-extension://"))
  )
    await nativeHost();
  else mcpHost();
}
main().catch((e) => {
  process.stderr.write(`Lumi adapter: ${e.message}\n`);
  process.exitCode = 1;
});
