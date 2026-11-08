// Talks to the built server over stdio like a real MCP client would.
// Usage: node scripts/smoke.mjs [tool] [json-args]   (no args = default checks)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/stdio.js"] }));

const call = async (name, args) => {
  const t = Date.now();
  const r = await client.callTool({ name, arguments: args });
  console.log(`\n===== ${name} ${JSON.stringify(args)} (${Date.now() - t} ms)${r.isError ? " ERROR" : ""}`);
  console.log(r.content.map((c) => c.text).join("\n"));
};

const [, , tool, json] = process.argv;
if (tool) await call(tool, JSON.parse(json ?? "{}"));
else {
  console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));
  await call("find_game_wiki", { game: "Terraria" });
  await call("search_game_wiki", { game: "Terraria", query: "moon lord drops", limit: 3 });
  await call("read_wiki_page", { game: "Terraria", title: "Moon Lord", max_chars: 3000 });
}
await client.close();
