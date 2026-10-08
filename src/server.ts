import { McpServer, fromJsonSchema, type JsonSchemaType } from "@modelcontextprotocol/server";
import type { AuthenticatedUser } from "./auth.js";
import { INTERNAL_ERROR_MESSAGE, ToolError } from "./errors.js";
import { memoryRateLimitStore, type RateLimitOptions, type RateLimitStore } from "./rate-limit.js";
import { ToolTimeoutError, withTimeout } from "./timeout.js";
import { NO_ARGUMENTS, READ_ONLY_ANNOTATIONS, type ReadOnlyTool } from "./tools.js";

/** One line per tool call, for your logs or metrics. */
export interface CallEvent {
  tool: string;
  userId: string;
  clientId?: string;
  outcome: "ok" | "tool_error" | "internal_error" | "timeout" | "rate_limited";
  ms: number;
}

export interface ServerOptions<D> {
  /** Machine name of the server, e.g. "acme". */
  name: string;
  version: string;
  /** Display name, e.g. "Acme Analytics". */
  title?: string;
  /**
   * Instructions every client hands to its model: what the data is, which
   * tool to call first, how to read the numbers, which language to answer in.
   */
  instructions?: string;
  // `any` here lets each tool keep its own argument type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: readonly ReadOnlyTool<D, any>[];
  /**
   * Your data layer for one request, scoped to the caller. Built lazily, on
   * the first tool call of the request: listing tools never touches it.
   */
  createData: (user: AuthenticatedUser) => D | Promise<D>;
  /**
   * Deadline for one tool call, in milliseconds. Default 10 000.
   * Keep it well under the max duration of your platform (Vercel, Lambda…):
   * a call that hangs must end as an error the model can read, not as a
   * killed function.
   */
  callTimeoutMs?: number;
  /** Calls per user per minute. Default: 60 in process memory. `false` turns it off. */
  rateLimit?: RateLimitOptions | false;
  /** OAuth scopes the tools require; advertised to ChatGPT in `_meta.securitySchemes`. */
  scopes?: readonly string[];
  /** Where internal failures go. Default: `console.error`. */
  onError?: (error: unknown, info: { tool: string; userId: string }) => void;
  /** Called once per tool call, after it ends. */
  onCall?: (event: CallEvent) => void;
}

export const DEFAULT_CALL_TIMEOUT_MS = 10_000;

const errorResult = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

export interface ResolvedLimits {
  timeoutMs: number;
  rate: { limit: number; windowMs: number; store: RateLimitStore } | null;
}

export function resolveLimits<D>(options: ServerOptions<D>): ResolvedLimits {
  const timeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  if (!(timeoutMs > 0)) throw new Error("callTimeoutMs must be a positive number");
  const rate =
    options.rateLimit === false
      ? null
      : {
          limit: options.rateLimit?.limit ?? 60,
          windowMs: options.rateLimit?.windowMs ?? 60_000,
          store: options.rateLimit?.store ?? memoryRateLimitStore(),
        };
  return { timeoutMs, rate };
}

/**
 * Builds the MCP server for ONE request and ONE user.
 *
 * Every tool call goes through the same path: a slot in the rate limit, the
 * handler under a deadline, an error the model can read, one `onCall` event.
 */
export function buildServer<D>(options: ServerOptions<D>, limits: ResolvedLimits, user: AuthenticatedUser): McpServer {
  const server = new McpServer(
    { name: options.name, title: options.title, version: options.version },
    options.instructions ? { instructions: options.instructions } : {},
  );

  // BEFORE the tools, and false. Registering a tool makes the SDK declare
  // `tools.listChanged: true` unless something was declared already; clients
  // on the 2026-07-28 protocol (Claude among them) then open a
  // `subscriptions/listen` stream, which stays open, with a heartbeat, until
  // the platform kills the function. On a serverless host that is one function
  // held open to its max duration (300 s on Vercel) again and again, doing
  // nothing. Our tools never change while a session is open, so: false, and
  // the SDK confirms an empty subscription and closes the stream at once.
  server.server.registerCapabilities({ tools: { listChanged: false } });

  let data: Promise<D> | null = null;
  const dataFor = () => (data ??= Promise.resolve().then(() => options.createData(user)));
  const meta = options.scopes?.length ? { securitySchemes: [{ type: "oauth2", scopes: [...options.scopes] }] } : undefined;
  const onError =
    options.onError ?? ((error: unknown, info: { tool: string }) => console.error(`mcp: tool ${info.tool} failed`, error));

  for (const tool of options.tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>((tool.inputSchema ?? NO_ARGUMENTS) as JsonSchemaType),
        annotations: { ...READ_ONLY_ANNOTATIONS, title: tool.title },
        ...(meta ? { _meta: meta } : {}),
      },
      async (args, ctx) => {
        const started = Date.now();
        let outcome: CallEvent["outcome"] = "ok";
        try {
          if (limits.rate) {
            const decision = await limits.rate.store.hit(user.userId, limits.rate.limit, limits.rate.windowMs, started);
            if (!decision.ok) {
              outcome = "rate_limited";
              return errorResult(
                `Rate limit reached: ${limits.rate.limit} calls per ${limits.rate.windowMs / 1000} seconds for this account. Retry in ${decision.retryAfterSeconds} seconds.`,
              );
            }
          }
          const result = await withTimeout(limits.timeoutMs, ctx.mcpReq.signal, async (signal) =>
            tool.handler(args ?? {}, { user, data: await dataFor(), signal }),
          );
          return {
            content: [{ type: "text" as const, text: result.text }],
            ...(result.data ? { structuredContent: result.data } : {}),
          };
        } catch (error) {
          if (error instanceof ToolError) {
            outcome = "tool_error";
            return errorResult(error.message);
          }
          if (error instanceof ToolTimeoutError) {
            outcome = "timeout";
            return errorResult(
              `The data took longer than ${limits.timeoutMs / 1000} seconds to load. Try again in a moment, or ask for less at once.`,
            );
          }
          outcome = "internal_error";
          onError(error, { tool: tool.name, userId: user.userId });
          return errorResult(INTERNAL_ERROR_MESSAGE);
        } finally {
          try {
            options.onCall?.({ tool: tool.name, userId: user.userId, clientId: user.clientId, outcome, ms: Date.now() - started });
          } catch (error) {
            onError(error, { tool: tool.name, userId: user.userId });
          }
        }
      },
    );
  }
  return server;
}
