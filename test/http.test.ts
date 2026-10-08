import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { INTERNAL_ERROR_MESSAGE, createMcpFetchHandler, type CallEvent } from "../src/index.js";
import { INITIALIZE, startDemo, textOf } from "./helpers.js";

let running: Awaited<ReturnType<typeof startDemo>> | null = null;
async function demo(options: Parameters<typeof startDemo>[0] = {}) {
  running = await startDemo(options);
  return running;
}
afterEach(async () => {
  await running?.stop();
  running = null;
});

const post = (base: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: INITIALIZE,
  });

describe("authentication", () => {
  it("no token: 401 at once, with WWW-Authenticate, on POST, GET and DELETE", async () => {
    const { base } = await demo();
    for (const method of ["POST", "GET", "DELETE"]) {
      const started = Date.now();
      const r = await fetch(`${base}/mcp`, { method, ...(method === "POST" ? { body: INITIALIZE } : {}) });
      expect(r.status, method).toBe(401);
      expect(r.headers.get("www-authenticate"), method).toMatch(/^Bearer/);
      await r.arrayBuffer();
      expect(Date.now() - started).toBeLessThan(1000);
    }
  });

  it("an unknown token: 401 invalid_token", async () => {
    const { base } = await demo();
    const r = await post(base, { authorization: "Bearer mcp_not-a-real-token" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(await r.json()).toMatchObject({ error: "invalid_token" });
  });

  it("an expired token: 401, even if the verifier recognises it", async () => {
    const handler = createMcpFetchHandler({
      name: "t",
      version: "1",
      tools: [],
      createData: () => null,
      verifyToken: () => ({ userId: "u", expiresAt: Math.floor(Date.now() / 1000) - 1 }),
    });
    const r = await handler.fetch(
      new Request("http://localhost/mcp", { method: "POST", headers: { authorization: "Bearer x" }, body: INITIALIZE }),
    );
    expect(r.status).toBe(401);
  });

  it("a verifier that throws: 503, and the error goes to onError, not to the client", async () => {
    const onError = vi.fn();
    const handler = createMcpFetchHandler({
      name: "t",
      version: "1",
      tools: [],
      createData: () => null,
      onError,
      verifyToken: () => {
        throw new Error("connection refused: db.internal:5432");
      },
    });
    const r = await handler.fetch(
      new Request("http://localhost/mcp", { method: "POST", headers: { authorization: "Bearer x" }, body: INITIALIZE }),
    );
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain("db.internal");
    expect(onError).toHaveBeenCalledOnce();
  });

  it("with OAuth configured, the 401 points to the RFC 9728 document, which names the resource exactly", async () => {
    const { base } = await demo({
      resourceUrl: "https://app.example.com/mcp",
      authorizationServers: ["https://auth.example.com"],
      scopes: ["analytics:read"],
    });
    const r = await post(base);
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://app.example.com/.well-known/oauth-protected-resource/mcp", scope="analytics:read"',
    );
    const doc = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(doc.status).toBe(200);
    expect(await doc.json()).toEqual({
      resource: "https://app.example.com/mcp",
      authorization_servers: ["https://auth.example.com"],
      bearer_methods_supported: ["header"],
      scopes_supported: ["analytics:read"],
      resource_name: "Acme Analytics",
    });
  });

  it("without OAuth configured, there is no RFC 9728 document", async () => {
    const { base } = await demo();
    expect((await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).status).toBe(404);
  });

  it("CORS preflight answers 204 with the MCP headers allowed", async () => {
    const { base } = await demo();
    const r = await fetch(`${base}/mcp`, { method: "OPTIONS" });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(r.headers.get("access-control-expose-headers")).toContain("www-authenticate");
  });
});

describe("no long-lived streams (the 300-second lesson)", () => {
  it("with a valid token, GET and DELETE answer 405 at once: nothing stays open", async () => {
    const { base, tokens } = await demo();
    for (const method of ["GET", "DELETE"]) {
      const started = Date.now();
      const r = await fetch(`${base}/mcp`, {
        method,
        headers: { authorization: `Bearer ${tokens.alice}`, accept: "text/event-stream" },
      });
      expect(r.status, method).toBe(405);
      await r.arrayBuffer();
      expect(Date.now() - started).toBeLessThan(1000);
    }
  });

  it("subscriptions/listen: the server declares listChanged false and the stream closes in under a second", async () => {
    const { tokens, connect } = await demo();
    // A client that WANTS tool-list notifications, like Claude. With
    // listChanged true it would open the stream by itself on connect, and the
    // stream would stay open until the platform killed the function.
    const client = await connect(tokens.alice, {
      listChanged: { tools: { onChanged: () => {} } },
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    });
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(false);

    const started = Date.now();
    const listen = await client.listen({ toolsListChanged: true }, { timeout: 2000 });
    expect(listen.honoredFilter).toEqual({});
    const end = await Promise.race([listen.closed, new Promise((ok) => setTimeout(() => ok("still open"), 2000))]);
    expect(end).toBe("graceful");
    expect(Date.now() - started).toBeLessThan(1000);

    // And the connector keeps working on the same client.
    expect((await client.listTools()).tools).toHaveLength(3);
    expect((await client.callTool({ name: "list_projects", arguments: {} })).isError).not.toBe(true);
  });
});

describe("tools", () => {
  it("three tools, all declared read-only", async () => {
    const { tokens, connect } = await demo();
    const client = await connect(tokens.alice);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["list_projects", "get_project", "get_metrics"]);
    for (const t of tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    }
    expect(client.getInstructions()).toContain("read-only");
  });

  it("each user sees only their own projects", async () => {
    const { tokens, connect } = await demo();
    const alice = await connect(tokens.alice);
    const bob = await connect(tokens.bob);
    const a = await alice.callTool({ name: "list_projects", arguments: {} });
    const b = await bob.callTool({ name: "list_projects", arguments: {} });
    expect(textOf(a)).toContain("Corner Bakery");
    expect(textOf(a)).not.toContain("Harbour Yoga");
    expect(textOf(b)).toContain("Harbour Yoga");
    expect(textOf(b)).not.toContain("Bakery");
    expect(a.structuredContent).toMatchObject({ projects: [{ id: "prj_bakery" }, { id: "prj_shop" }] });
  });

  it("another user's project id is 'not found', exactly like an invented one", async () => {
    const { tokens, connect } = await demo();
    const bob = await connect(tokens.bob);
    for (const tool of ["get_project", "get_metrics"]) {
      const theirs = await bob.callTool({ name: tool, arguments: { project_id: "prj_bakery" } });
      const invented = await bob.callTool({ name: tool, arguments: { project_id: "prj_nope" } });
      expect(theirs.isError).toBe(true);
      expect(textOf(theirs)).toBe(textOf(invented));
      expect(textOf(theirs)).toMatch(/Project not found/);
      expect(JSON.stringify(theirs)).not.toContain("Corner Bakery");
    }
  });

  it("project_id is optional with one project, required with more", async () => {
    const { tokens, connect } = await demo();
    const bob = await connect(tokens.bob);
    const one = await bob.callTool({ name: "get_project", arguments: {} });
    expect(one.isError).not.toBe(true);
    expect(textOf(one)).toMatch(/Harbour Yoga Studio, week of 2026-08-24: 455 visits, 6 signups/);

    const alice = await connect(tokens.alice);
    const many = await alice.callTool({ name: "get_project", arguments: {} });
    expect(many.isError).toBe(true);
    expect(textOf(many)).toMatch(/2 projects: pass project_id/);
  });

  it("get_metrics returns the requested weeks, oldest first", async () => {
    const { tokens, connect } = await demo();
    const alice = await connect(tokens.alice);
    const r = await alice.callTool({ name: "get_metrics", arguments: { project_id: "prj_shop", weeks: 3 } });
    expect(r.structuredContent).toMatchObject({
      weeks: [{ week: "2026-08-10" }, { week: "2026-08-17" }, { week: "2026-08-24", visits: 395, signups: 9 }],
    });
  });

  it("arguments outside the schema are refused before the tool runs", async () => {
    const { tokens, connect } = await demo();
    const bob = await connect(tokens.bob);
    const r = await bob.callTool({ name: "get_metrics", arguments: { weeks: 500 } }).catch((e: Error) => e);
    const text = r instanceof Error ? r.message : textOf(r);
    expect(r instanceof Error || (r as { isError?: boolean }).isError).toBe(true);
    expect(text).toMatch(/weeks|valid/i);
  });
});

describe("limits and errors", () => {
  it("a slow data layer ends as a readable error at the deadline, and the signal is aborted", async () => {
    const events: CallEvent[] = [];
    const { tokens, connect } = await demo({ callTimeoutMs: 200, fake: { delayMs: 5000 }, onCall: (e) => events.push(e) });
    const bob = await connect(tokens.bob);
    const started = Date.now();
    const r = await bob.callTool({ name: "list_projects", arguments: {} });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^The data took longer than 0.2 seconds to load./);
    expect(events).toMatchObject([{ tool: "list_projects", userId: "user_bob", outcome: "timeout" }]);
  });

  it("an internal failure tells the model nothing about the internals; the details go to onError", async () => {
    const onError = vi.fn();
    const events: CallEvent[] = [];
    const { tokens, connect } = await demo({
      fake: { failWith: new Error('relation "secret_table" does not exist: SELECT * FROM secret_table') },
      onError,
      onCall: (e) => events.push(e),
    });
    const bob = await connect(tokens.bob);
    const r = await bob.callTool({ name: "list_projects", arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(INTERNAL_ERROR_MESSAGE);
    expect(JSON.stringify(r)).not.toContain("secret_table");
    expect(onError).toHaveBeenCalledOnce();
    expect(String(onError.mock.calls[0]?.[0])).toContain("secret_table");
    expect(events[0]?.outcome).toBe("internal_error");
  });

  it("past the per-user limit the call is refused with a retry time; another user is not affected", async () => {
    const events: CallEvent[] = [];
    const { tokens, connect } = await demo({ rateLimit: { limit: 3, windowMs: 60_000 }, onCall: (e) => events.push(e) });
    const alice = await connect(tokens.alice);
    const bob = await connect(tokens.bob);
    for (let i = 0; i < 3; i++) {
      expect((await alice.callTool({ name: "list_projects", arguments: {} })).isError).not.toBe(true);
    }
    const refused = await alice.callTool({ name: "list_projects", arguments: {} });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/Rate limit reached: 3 calls per 60 seconds for this account\. Retry in \d+ seconds\./);
    expect((await bob.callTool({ name: "list_projects", arguments: {} })).isError).not.toBe(true);
    expect(events.map((e) => e.outcome)).toEqual(["ok", "ok", "ok", "rate_limited", "ok"]);
  });

  it("the data layer is built once per request, and only when a tool runs", async () => {
    const createData = vi.fn(() => null);
    const handler = createMcpFetchHandler({
      name: "t",
      version: "1",
      tools: [],
      createData,
      verifyToken: () => ({ userId: "u" }),
    });
    const r = await handler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { authorization: "Bearer x", "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: INITIALIZE,
      }),
    );
    expect(r.status).toBe(200);
    expect(createData).not.toHaveBeenCalled();
    await handler.close();
  });

  it("works with the 2025 protocol too (the client default, and what ChatGPT speaks today)", async () => {
    const { base, tokens } = await demo();
    const client = new Client({ name: "legacy", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokens.bob}` } } }),
    );
    try {
      expect(client.getNegotiatedProtocolVersion()).not.toBe("2026-07-28");
      expect(textOf(await client.callTool({ name: "list_projects", arguments: {} }))).toContain("Harbour Yoga");
    } finally {
      await client.close();
    }
  });
});
