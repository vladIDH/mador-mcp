# mador-mcp

**Extracted from the MCP server that runs [Mador](https://mador.ai) in production, as a reusable TypeScript package.**

A small, read-only [Model Context Protocol](https://modelcontextprotocol.io) server for any SaaS: your users connect your product to Claude or ChatGPT and ask "how is my account doing?" in plain words.

- **Read-only by construction.** Tools are declared with `defineReadOnlyTool()`, which always sends read-only annotations, so Claude and ChatGPT do not ask for confirmation on every call.
- **One user per request.** The bearer token is verified on every request and the server is built around that user. Tools never receive a user id among their arguments, so a model cannot ask for somebody else's data.
- **A deadline on every tool call** (10 s by default). A slow database ends as an error the model can read, not as a function killed by the platform.
- **No long-lived streams.** The server declares `tools.listChanged: false`, so clients do not keep a notification stream open on your serverless functions (see [Lessons from production](#lessons-from-production)).
- **Per-user rate limit** (60 calls a minute by default), with a pluggable store.
- **Clean errors.** Expected errors (`ToolError`) reach the model as they are; anything else is logged through `onError` and the model only gets a generic sentence: no table names, no stack traces.
- **Web-standard `fetch` handler.** Works on Next.js route handlers, Cloudflare Workers, Deno, Bun, and on plain Node with `toNodeListener()`.
- Built on the official SDK, [`@modelcontextprotocol/server`](https://github.com/modelcontextprotocol/typescript-sdk) 2.2.0. Speaks the 2026-07-28 protocol and answers 2025 clients statelessly.

Italian: [README.it.md](README.it.md).

## Try it in two minutes

Requires Node.js 20 or later.

```bash
git clone https://github.com/vladIDH/mador-mcp.git
cd mador-mcp
npm install
npm test        # unit and end-to-end tests
npm run demo    # demo server on http://localhost:3333/mcp
```

The demo serves an invented analytics product ("Acme Analytics") from in-memory fake data: two users, three projects, weekly visits and signups. At start it prints a fresh token for each user. Open the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) with `npx @modelcontextprotocol/inspector`, choose "Streamable HTTP", enter `http://localhost:3333/mcp`, and add the header `Authorization: Bearer <token>`.

## Use it in your product

The package is not on npm yet. Install it from GitHub, or copy `src/` (MIT).

```bash
npm install github:vladIDH/mador-mcp
```

```ts
import { ToolError, createMcpFetchHandler, defineReadOnlyTool } from "mador-mcp";

const listProjects = defineReadOnlyTool<MyData>({
  name: "list_projects",
  title: "List projects",
  description: "Lists the projects of this account with their id. Call this first.",
  handler: async (_args, { data, signal }) => {
    const projects = await data.projects(signal);
    if (projects.length === 0) throw new ToolError("This account has no projects yet.");
    return {
      text: projects.map((p) => `- ${p.name} (project_id ${p.id})`).join("\n"),
      data: { projects },
    };
  },
});

export const mcp = createMcpFetchHandler<MyData>({
  name: "my-app",
  title: "My App",
  version: "1.0.0",
  instructions: "Read-only access to the signed-in account of My App. Start with list_projects.",
  tools: [listProjects],
  // Your data layer, created for ONE user: every read is scoped to user.userId.
  createData: (user) => myData.forUser(user.userId),
  // Bearer token -> user, on every request. null = 401.
  verifyToken: async (token) => myAuth.verify(token),
  // Fixed in production: it must match the URL people paste into Claude or ChatGPT.
  resourceUrl: "https://app.example.com/api/mcp",
  callTimeoutMs: 10_000,
  rateLimit: { limit: 60, windowMs: 60_000 },
  onCall: (e) => log.info("mcp call", e), // tool, userId, outcome, ms
});

// Any fetch-style runtime:
export default { fetch: mcp.fetch };
```

- **Next.js**: see [`examples/nextjs/route.ts`](examples/nextjs/route.ts), including `maxDuration` on that route only.
- **Node / Express**: `http.createServer(toNodeListener(mcp.fetch))`, see [`examples/node-server.ts`](examples/node-server.ts).
- **The fake data adapter and its three tools**: [`examples/fake-adapter/`](examples/fake-adapter).

## Authentication

`verifyToken(token)` returns `{ userId, clientId?, scopes?, expiresAt? }` or `null`. Two ways to fill it:

### 1. Static per-user tokens (simplest)

One long random token per user. You store only its SHA-256; the comparison runs in constant time.

```bash
npm run token   # prints a new token and the hash to store
```

```ts
import { staticTokenVerifier } from "mador-mcp";

verifyToken: staticTokenVerifier([{ userId: "user_123", tokenHash: "<sha-256 hex>" }]);
```

For a real product, look the hash up in your database instead (`hashToken(token)`), so a revoked token stops working on the next request.

Static tokens work wherever the client lets you set an `Authorization` header: Claude Code, Cursor, the MCP Inspector, the MCP connector of the Claude Messages API. **They do not work as custom connectors in Claude.ai or ChatGPT**, which accept OAuth or no authentication at all.

### 2. OAuth, for Claude.ai and ChatGPT

This package is the **resource server**: it checks tokens, it does not issue them. Pair it with an OAuth 2.1 authorization server (Auth0, WorkOS, Clerk, Stytch, Supabase Auth, Keycloak, or your own), and verify its access tokens (JWT signature or introspection) in `verifyToken`.

```ts
createMcpFetchHandler({
  // ...
  resourceUrl: "https://app.example.com/api/mcp",
  authorizationServers: ["https://auth.example.com"],
  scopes: ["myapp:read"],
  verifyToken: async (token) => {
    const claims = await verifyJwt(token, { audience: "https://app.example.com/api/mcp" });
    return claims ? { userId: claims.sub, clientId: claims.client_id, scopes: claims.scope?.split(" "), expiresAt: claims.exp } : null;
  },
});
```

With `authorizationServers` set, the handler serves the [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) document at `/.well-known/oauth-protected-resource/<path>`, and every 401 carries `WWW-Authenticate: Bearer resource_metadata="…"`. That is how Claude and ChatGPT discover where to sign in. On frameworks with one file per route, serve `mcp.protectedResourceMetadata(req)` at that path.

What Claude and ChatGPT ask of your authorization server:

- [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414) metadata with `code_challenge_methods_supported: ["S256"]` (ChatGPT refuses a server without it) and `"none"` among `token_endpoint_auth_methods_supported` (public clients).
- Client registration through Dynamic Client Registration ([RFC 7591](https://www.rfc-editor.org/rfc/rfc7591)) or Client ID Metadata Documents.
- PKCE S256 on every authorization request, and the `resource` parameter ([RFC 8707](https://www.rfc-editor.org/rfc/rfc8707)): bind the token to your MCP URL and check the audience in `verifyToken`.
- Rotating refresh tokens. An invalid refresh token answers `invalid_grant`.
- Redirect URIs to allow: `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`, `https://chatgpt.com/connector_platform_oauth_redirect`, and `http://localhost:<port>/…` / `http://127.0.0.1:<port>/…` for local clients (Claude Code, MCP Inspector).
- List one authorization server only: Claude reads the first.

## Connect it to Claude and ChatGPT

The server must be reachable on a public HTTPS URL: requests come from Anthropic's and OpenAI's servers, not from the user's computer.

**Claude Code** (static token or OAuth):

```bash
claude mcp add --transport http my-app https://app.example.com/api/mcp \
  --header "Authorization: Bearer <token>"
```

**Claude** (web, desktop, mobile; OAuth): Customize → Connectors → *Add custom connector* → paste the URL → *Connect* → sign in. Available on every Claude plan; on Team and Enterprise an owner adds it, then each member signs in with their own account. In a conversation, turn it on from the "+" menu → Connectors. Docs: [custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), [authentication](https://claude.com/docs/connectors/building/authentication).

**ChatGPT** (OAuth): turn on *Developer mode* (Settings → Security and login), then add the server from the apps / connectors settings with a name, a description and the URL, and sign in. Availability depends on the ChatGPT plan and workspace settings. Docs: [connect from ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt), [authentication](https://developers.openai.com/plugins/build/auth).

Menu names change often; the linked pages are the reference.

## Lessons from production

These come from running this server for Mador's customers.

1. **Declare `tools.listChanged: false`.** Registering a tool makes the SDK declare `listChanged: true` unless something was declared before. Clients on the 2026-07-28 protocol, Claude among them, then open a `subscriptions/listen` stream that the server keeps open with a heartbeat. On Vercel that meant functions held open to the 300-second limit, over and over, doing nothing. With `false` the SDK confirms an empty subscription and closes the stream at once. `buildServer()` does this before registering tools, and a test fails if the line is removed.
2. **Cap the route, too.** Under the per-call deadline, give the MCP route a short platform limit (`maxDuration = 30` on Next.js / Vercel). A real call takes about a second; anything left open by mistake dies at 30 s instead of 300.
3. **Unauthenticated means 401 with `WWW-Authenticate`**, never a JSON-RPC error on a 200: the 401 is what starts the sign-in in Claude and ChatGPT.
4. **Write `resourceUrl`, do not read it from the request.** The RFC 9728 `resource` must match the pasted URL character for character, and a value derived from headers is chosen by whoever sends them.
5. **Re-check the token on every request.** Revoked access, a closed account or a downgraded plan must stop working on the next call.
6. **Scope data by construction.** The server is built around the caller; another user's id is "not found", exactly like an invented one.
7. **Never tell the model about your internals.** Log the error, return a sentence.

## How Mador uses it

See [`examples/mador.md`](examples/mador.md).

## Development

```bash
npm run typecheck
npm test
npm run build
```

CI runs the same on Node 20, 22 and 24 ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## License

[MIT](LICENSE). Made by the team behind [Mador](https://mador.ai).
