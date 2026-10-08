import { createMcpHandler } from "@modelcontextprotocol/server";
import { bearerTokenOf, type AuthenticatedUser, type TokenVerifier } from "./auth.js";
import { buildServer, resolveLimits, type ServerOptions } from "./server.js";

export interface McpHandlerOptions<D> extends ServerOptions<D> {
  /** Turns the bearer token of each request into a user. Runs on every request. */
  verifyToken: TokenVerifier;
  /**
   * The public URL of the MCP endpoint, e.g. `https://app.example.com/api/mcp`.
   *
   * Set it in production. It is the `resource` of the RFC 9728 document and it
   * must match, character for character, the URL people paste into Claude or
   * ChatGPT. When it is missing the URL of the incoming request is used, which
   * is right on localhost and wrong behind proxies, and it lets whoever sends
   * the `Host` header decide what the server says it is.
   */
  resourceUrl?: string;
  /**
   * The OAuth authorization server(s) that issue your tokens (their issuer
   * URLs). When set, `/.well-known/oauth-protected-resource` is served and
   * every 401 points to it, which is how Claude.ai and ChatGPT start their
   * sign-in. Claude reads only the first one. Leave it out with static tokens.
   */
  authorizationServers?: readonly string[];
  /** Human-readable name in the RFC 9728 document. Default: `title` or `name`. */
  resourceName?: string;
  /** A page explaining how to connect, in the RFC 9728 document. */
  resourceDocumentation?: string;
  /** CORS headers for browser-based clients such as the MCP Inspector. Default true. */
  cors?: boolean;
}

export interface McpFetchHandler {
  /**
   * Serves the MCP endpoint, its CORS preflight and, when
   * `authorizationServers` is set, `/.well-known/oauth-protected-resource`.
   * Route the endpoint path and the well-known paths to it.
   */
  fetch: (req: Request) => Promise<Response>;
  /** The RFC 9728 document alone, for frameworks with one file per route. */
  protectedResourceMetadata: (req: Request) => Response;
  /** Aborts open exchanges, e.g. on shutdown. */
  close: () => Promise<void>;
}

const WELL_KNOWN = "/.well-known/oauth-protected-resource";

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "www-authenticate, mcp-session-id, mcp-protocol-version",
  "access-control-max-age": "86400",
};

/** Where the RFC 9728 document of a resource lives (path inserted after the well-known prefix). */
export function protectedResourceMetadataUrl(resourceUrl: string): string {
  const u = new URL(resourceUrl);
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
  return `${u.origin}${WELL_KNOWN}${path}`;
}

/**
 * The MCP endpoint as a web-standard `fetch` handler: `Request` in,
 * `Response` out. Works as is on Next.js route handlers, Cloudflare Workers,
 * Deno and Bun; on plain Node wrap it with `toNodeListener()`.
 *
 * Order of checks: token → user → the SDK handler with a server built for
 * that user. Each POST is answered and closed: no sessions, nothing kept
 * between requests. GET and DELETE (2025 session operations) get 405.
 */
export function createMcpFetchHandler<D>(options: McpHandlerOptions<D>): McpFetchHandler {
  const limits = resolveLimits(options);
  const cors = options.cors ?? true;
  const withCors = (r: Response): Response => {
    if (!cors) return r;
    const headers = new Headers(r.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers });
  };
  const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
    withCors(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
      }),
    );

  const resourceOf = (req: Request): string => {
    if (options.resourceUrl) return options.resourceUrl;
    const u = new URL(req.url);
    return `${u.origin}${u.pathname.startsWith(WELL_KNOWN) ? u.pathname.slice(WELL_KNOWN.length) || "/" : u.pathname}`;
  };

  const challenge = (req: Request, error?: { code: string; description: string }): string => {
    const parts: string[] = [];
    if (error) parts.push(`error="${error.code}"`, `error_description="${error.description}"`);
    if (options.authorizationServers?.length) parts.push(`resource_metadata="${protectedResourceMetadataUrl(resourceOf(req))}"`);
    if (options.scopes?.length) parts.push(`scope="${options.scopes.join(" ")}"`);
    return parts.length ? `Bearer ${parts.join(", ")}` : "Bearer";
  };

  const protectedResourceMetadata = (req: Request): Response => {
    if (!options.authorizationServers?.length) return withCors(new Response(null, { status: 404 }));
    const body = {
      resource: resourceOf(req),
      authorization_servers: [...options.authorizationServers],
      bearer_methods_supported: ["header"],
      ...(options.scopes?.length ? { scopes_supported: [...options.scopes] } : {}),
      resource_name: options.resourceName ?? options.title ?? options.name,
      ...(options.resourceDocumentation ? { resource_documentation: options.resourceDocumentation } : {}),
    };
    return json(body, 200, { "cache-control": "public, max-age=300" });
  };

  const sdk = createMcpHandler((ctx) => {
    const user = (ctx.authInfo?.extra as { user?: AuthenticatedUser } | undefined)?.user;
    // Unreachable through `fetch` below, which always passes the user.
    if (!user) throw new Error("mcp: request reached the server without a verified user");
    return buildServer(options, limits, user);
  });

  const fetch = async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
    if (new URL(req.url).pathname.startsWith(WELL_KNOWN)) {
      return req.method === "GET" ? protectedResourceMetadata(req) : withCors(new Response(null, { status: 405 }));
    }

    const token = bearerTokenOf(req);
    if (!token) {
      // A 401 with WWW-Authenticate, not a JSON-RPC error: it is what makes
      // Claude and ChatGPT start their sign-in. Claude ignores the header on a 200.
      return json({ error: "unauthorized", error_description: "a bearer token is required" }, 401, {
        "www-authenticate": challenge(req),
      });
    }

    let user: AuthenticatedUser | null;
    try {
      user = await options.verifyToken(token);
    } catch (error) {
      (options.onError ?? ((e: unknown) => console.error("mcp: token verification failed", e)))(error, {
        tool: "(auth)",
        userId: "(unknown)",
      });
      return json({ error: "server_error", error_description: "the token could not be checked right now" }, 503);
    }
    if (user && user.expiresAt !== undefined && user.expiresAt * 1000 <= Date.now()) user = null;
    if (!user) {
      const description = "the access token is invalid, expired or revoked";
      return json({ error: "invalid_token", error_description: description }, 401, {
        "www-authenticate": challenge(req, { code: "invalid_token", description }),
      });
    }

    const response = await sdk.fetch(req, {
      authInfo: {
        token,
        clientId: user.clientId ?? "unknown",
        scopes: user.scopes ?? [],
        ...(user.expiresAt !== undefined ? { expiresAt: user.expiresAt } : {}),
        resource: new URL(resourceOf(req)),
        extra: { user },
      },
    });
    return withCors(response);
  };

  return { fetch, protectedResourceMetadata, close: () => sdk.close() };
}
