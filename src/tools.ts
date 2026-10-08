import type { AuthenticatedUser } from "./auth.js";

/** A JSON Schema for the tool arguments: an object. */
export interface ToolInputSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

/** What a tool receives besides its arguments. */
export interface ToolContext<D> {
  /** The caller. Scope every read to `user.userId`. */
  user: AuthenticatedUser;
  /** Your data layer for this request, from `createData(user)`. */
  data: D;
  /** Aborts at the call deadline or when the client cancels. Pass it to your queries. */
  signal: AbortSignal;
}

/**
 * What a tool returns: a text the model reads, and optionally the same facts
 * as structured data (sent as `structuredContent`).
 */
export interface ToolResult {
  text: string;
  data?: Record<string, unknown>;
}

export interface ReadOnlyTool<D, A = Record<string, unknown>> {
  /** snake_case, e.g. `list_projects`. */
  name: string;
  title: string;
  /**
   * The only thing a model has to decide whether to call the tool. Say what it
   * returns and when to use it, in English.
   */
  description: string;
  /** Default: no arguments. */
  inputSchema?: ToolInputSchema;
  handler: (args: A, ctx: ToolContext<D>) => Promise<ToolResult> | ToolResult;
}

/** An empty argument list. */
export const NO_ARGUMENTS: ToolInputSchema = { type: "object", properties: {}, additionalProperties: false };

/**
 * Declares a read-only tool. There is no way to declare anything else: the
 * annotations sent to clients always say read-only, non-destructive,
 * idempotent and closed-world, so Claude and ChatGPT do not ask the user to
 * confirm each call. Keep the handler honest: it must not write, not even an
 * idempotent row.
 */
export function defineReadOnlyTool<D, A = Record<string, unknown>>(tool: ReadOnlyTool<D, A>): ReadOnlyTool<D, A> {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name)) {
    throw new Error(`defineReadOnlyTool: "${tool.name}" must be snake_case, at most 64 characters`);
  }
  return tool;
}

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
