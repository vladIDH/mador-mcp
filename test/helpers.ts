import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { toNodeListener } from "../src/index.js";
import { createDemo } from "../examples/demo.js";

/** The demo server on a random local port, behind the real `node:http` adapter. */
export async function startDemo(options: Parameters<typeof createDemo>[0] = {}) {
  let base = "";
  const demo = createDemo({ ...options, resourceUrl: options.resourceUrl });
  const listener = toNodeListener(demo.handler.fetch);
  const server: Server = createServer(listener);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const opened: Client[] = [];

  async function connect(token: string, clientOptions: ConstructorParameters<typeof Client>[1] = {}) {
    const client = new Client({ name: "test-client", version: "1.0.0" }, clientOptions);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
    );
    opened.push(client);
    return client;
  }

  async function stop() {
    await Promise.allSettled(opened.map((c) => c.close()));
    await demo.handler.close();
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
  }

  return { base, tokens: demo.tokens, connect, stop };
}

/** The text of a tool result. */
export function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
}

/** A JSON-RPC initialize body, for raw HTTP checks. */
export const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw", version: "1.0.0" } },
});
