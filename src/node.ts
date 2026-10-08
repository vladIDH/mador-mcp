import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

/**
 * Adapts a web-standard `fetch` handler to `node:http` (and Express, which
 * accepts the same listener).
 *
 * `baseUrl` fixes the origin of the incoming URLs; without it the `Host`
 * header is used. Set `resourceUrl` on the MCP handler in production either way.
 */
export function toNodeListener(
  handler: (req: Request) => Promise<Response>,
  options: { baseUrl?: string } = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });

    void (async () => {
      const base = options.baseUrl ?? `http://${req.headers.host ?? "localhost"}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) for (const item of v) headers.append(k, item);
        else if (v !== undefined) headers.set(k, v);
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const request = new Request(new URL(req.url ?? "/", base), {
        method: req.method,
        headers,
        body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>) : undefined,
        signal: abort.signal,
        // Required by Node's fetch for a streamed request body.
        ...(hasBody ? { duplex: "half" } : {}),
      } as RequestInit);

      const response = await handler(request);
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      if (!response.body) {
        res.end();
        return;
      }
      res.flushHeaders();
      Readable.fromWeb(response.body as unknown as NodeReadableStream).pipe(res);
    })().catch((error) => {
      console.error("mcp: node listener failed", error);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  };
}
