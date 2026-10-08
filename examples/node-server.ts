import { createServer } from "node:http";
import { toNodeListener } from "../src/index.js";
import { createDemo } from "./demo.js";

/**
 * `npm run demo`: the demo MCP server on http://localhost:3333/mcp.
 *
 * Try it with the MCP Inspector:
 *   npx @modelcontextprotocol/inspector
 * Transport "Streamable HTTP", URL http://localhost:3333/mcp, and an
 * `Authorization: Bearer <token>` header with one of the tokens printed below.
 */
const port = Number(process.env.PORT ?? 3333);
const { handler, tokens } = createDemo({ resourceUrl: `http://localhost:${port}/mcp` });

const listener = toNodeListener(handler.fetch);
createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (path === "/mcp" || path?.startsWith("/.well-known/")) return listener(req, res);
  res.statusCode = 404;
  res.end();
}).listen(port, () => {
  console.log(`Demo MCP server on http://localhost:${port}/mcp`);
  console.log("Tokens for this run (new ones at every start):");
  console.log(`  user_alice (2 projects): ${tokens.alice}`);
  console.log(`  user_bob   (1 project):  ${tokens.bob}`);
});
