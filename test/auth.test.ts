import { describe, expect, it } from "vitest";
import { bearerTokenOf, generateToken, hashToken, staticTokenVerifier } from "../src/index.js";

describe("tokens", () => {
  it("generateToken gives a long random token and its SHA-256", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a.token).toMatch(/^mcp_[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(hashToken(a.token));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("staticTokenVerifier maps each token to its own user, and nothing else", async () => {
    const alice = generateToken();
    const bob = generateToken();
    const verify = staticTokenVerifier([
      { userId: "alice", tokenHash: alice.hash, scopes: ["read"] },
      { userId: "bob", tokenHash: bob.hash },
    ]);
    expect(await verify(alice.token)).toEqual({ userId: "alice", clientId: "static-token", scopes: ["read"] });
    expect((await verify(bob.token))?.userId).toBe("bob");
    expect(await verify(alice.hash)).toBeNull();
    expect(await verify(`${alice.token}x`)).toBeNull();
    expect(await verify("")).toBeNull();
  });

  it("staticTokenVerifier refuses a raw token where a hash is expected", () => {
    expect(() => staticTokenVerifier([{ userId: "alice", tokenHash: "not-a-hash" }])).toThrow(/SHA-256/);
  });

  it("bearerTokenOf reads only a well-formed Bearer header", () => {
    const req = (h?: string) => new Request("http://x/mcp", h ? { headers: { authorization: h } } : {});
    expect(bearerTokenOf(req("Bearer abc"))).toBe("abc");
    expect(bearerTokenOf(req("bearer abc"))).toBe("abc");
    expect(bearerTokenOf(req("Basic abc"))).toBeNull();
    expect(bearerTokenOf(req("Bearer a b"))).toBeNull();
    expect(bearerTokenOf(req())).toBeNull();
  });
});
