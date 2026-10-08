import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Who is calling. The server is built around ONE user per request: tools
 * never receive a user id among their arguments, so there is no argument a
 * model could use to ask for somebody else's data.
 */
export interface AuthenticatedUser {
  /** Your user (or account) id. Every data read is scoped to it. */
  userId: string;
  /** The OAuth client or API key that made the call, for your logs. */
  clientId?: string;
  /** Scopes granted to the token. */
  scopes?: string[];
  /** When the token expires, in seconds since the epoch. */
  expiresAt?: number;
}

/**
 * Turns a bearer token into a user, or `null` when the token is unknown,
 * expired or revoked.
 *
 * Plug in whatever issues your tokens: the static per-user tokens below, your
 * own API keys table, or the introspection / JWT verification of an external
 * OAuth server (Auth0, WorkOS, Clerk, Supabase Auth, Keycloak…).
 *
 * It runs on EVERY request: a revoked token or a downgraded account stops
 * working on the next call, not when the token expires.
 */
export type TokenVerifier = (token: string) => Promise<AuthenticatedUser | null> | AuthenticatedUser | null;

/** SHA-256 of a token, hex encoded. Store this, never the token itself. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A new random token (256 bits, base64url) with its hash. */
export function generateToken(prefix = "mcp_"): { token: string; hash: string } {
  const token = `${prefix}${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashToken(token) };
}

export interface StaticTokenEntry {
  userId: string;
  /** `hashToken(token)`: the token itself is never kept in memory or config. */
  tokenHash: string;
  /** A label for logs, e.g. "alice laptop". */
  clientId?: string;
  scopes?: string[];
}

/**
 * Per-user static tokens: one long random token per user, compared by hash in
 * constant time.
 *
 * Good for Claude Code, Cursor, the MCP Inspector, the Messages API MCP
 * connector, and any client that lets you set an `Authorization` header.
 * Claude.ai and ChatGPT custom connectors need OAuth instead: see the README.
 */
export function staticTokenVerifier(entries: readonly StaticTokenEntry[]): TokenVerifier {
  const known = entries.map((e) => {
    if (!/^[0-9a-f]{64}$/.test(e.tokenHash)) {
      throw new Error(`staticTokenVerifier: tokenHash for user ${e.userId} is not a SHA-256 hex digest`);
    }
    return { ...e, digest: Buffer.from(e.tokenHash, "hex") };
  });
  return (token) => {
    const digest = Buffer.from(hashToken(token), "hex");
    let match: (typeof known)[number] | null = null;
    // Walk every entry: the time taken does not depend on which one matches.
    for (const e of known) {
      if (timingSafeEqual(e.digest, digest)) match = e;
    }
    if (!match) return null;
    return { userId: match.userId, clientId: match.clientId ?? "static-token", scopes: match.scopes ?? [] };
  };
}

/** The token in an `Authorization: Bearer …` header, or `null`. */
export function bearerTokenOf(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
  return token ?? null;
}
