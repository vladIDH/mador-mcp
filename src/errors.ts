/**
 * An error whose message is safe to show to the model, as is.
 *
 * Throw it from a tool for expected situations: "Project not found",
 * "This account has no projects yet", "Pass project_id". Anything else a tool
 * throws is treated as an internal failure: the details go to `onError`, and
 * the model only gets a generic sentence (see `INTERNAL_ERROR_MESSAGE`).
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/**
 * What the model reads when a tool fails for a reason of ours. It never
 * carries table names, query fragments or stack traces.
 */
export const INTERNAL_ERROR_MESSAGE = "The server could not read the data right now. Try again in a moment.";
