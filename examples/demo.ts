import { createMcpFetchHandler, generateToken, staticTokenVerifier, type McpHandlerOptions } from "../src/index.js";
import { fakeData, type FakeDataOptions, type ProjectsData } from "./fake-adapter/data.js";
import { INSTRUCTIONS, TOOLS } from "./fake-adapter/tools.js";

/**
 * The demo server: the fake "Acme Analytics" data, three read-only tools,
 * and a fresh random token for each of the two demo users. Shared by
 * `npm run demo` and the tests.
 */
export function createDemo(
  options: { fake?: FakeDataOptions } & Partial<Omit<McpHandlerOptions<ProjectsData>, "tools" | "createData">> = {},
) {
  const alice = generateToken();
  const bob = generateToken();
  const { fake, ...rest } = options;
  const handler = createMcpFetchHandler<ProjectsData>({
    name: "acme-analytics",
    title: "Acme Analytics",
    version: "0.1.0",
    instructions: INSTRUCTIONS,
    tools: TOOLS,
    createData: (user) => fakeData(user, fake),
    verifyToken: staticTokenVerifier([
      { userId: "user_alice", tokenHash: alice.hash, clientId: "demo-alice" },
      { userId: "user_bob", tokenHash: bob.hash, clientId: "demo-bob" },
    ]),
    ...rest,
  });
  return { handler, tokens: { alice: alice.token, bob: bob.token } };
}
