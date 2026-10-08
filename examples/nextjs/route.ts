/**
 * Next.js App Router: `app/api/mcp/route.ts`.
 *
 * The RFC 9728 document goes in `app/.well-known/oauth-protected-resource/api/mcp/route.ts`:
 *
 *   import { mcp } from "@/lib/mcp";
 *   export const GET = (req: Request) => mcp.protectedResourceMetadata(req);
 */
import { createMcpFetchHandler, type AuthenticatedUser } from "../../src/index.js";
import { fakeData } from "../fake-adapter/data.js";
import { INSTRUCTIONS, TOOLS } from "../fake-adapter/tools.js";

// Your own verification: an API keys table, or the JWT / introspection of
// your OAuth provider. It runs on every request.
async function verifyToken(token: string): Promise<AuthenticatedUser | null> {
  void token;
  return null;
}

export const mcp = createMcpFetchHandler({
  name: "acme-analytics",
  title: "Acme Analytics",
  version: "1.0.0",
  instructions: INSTRUCTIONS,
  tools: TOOLS,
  createData: (user) => fakeData(user),
  verifyToken,
  // Written, never read from the request: it must match the URL people paste.
  resourceUrl: "https://app.example.com/api/mcp",
  authorizationServers: ["https://auth.example.com"],
  scopes: ["analytics:read"],
  callTimeoutMs: 10_000,
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The safety net under the per-call deadline: a real call ends in about a
// second, and a stream left open by mistake dies at 30 s instead of at the
// platform default (300 s on Vercel), set on this route only.
export const maxDuration = 30;

const serve = (req: Request) => mcp.fetch(req);
export { serve as GET, serve as POST, serve as DELETE, serve as OPTIONS };
