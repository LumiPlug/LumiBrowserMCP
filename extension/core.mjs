export class LumiError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
export function originOf(url) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new LumiError(
      "restricted_page",
      "Only HTTP(S) pages can be authorized.",
    );
  return parsed.origin;
}
export function assertLive(session, epoch) {
  if (session.state !== "active" || session.epoch !== epoch)
    throw new LumiError(
      "cancelled",
      "Session was paused, revoked, or changed.",
    );
}
export function enqueue(session, operation) {
  const epoch = session.epoch;
  const result = session.queue
    .catch(() => {})
    .then(() => {
      assertLive(session, epoch);
      return operation(epoch);
    });
  session.queue = result.catch(() => {});
  return result;
}
export function invalidate(session, state) {
  session.epoch++;
  session.state = state;
}

export const TOOL_NAMES = [
  "list_sessions",
  "snapshot",
  "read_text",
  "click",
  "fill",
  "scroll",
  "wait_for",
];
export function validateNativeRequest(message) {
  if (
    typeof message.tool !== "string" ||
    message.tool.length > 32 ||
    !TOOL_NAMES.includes(message.tool)
  )
    throw new LumiError(
      "unknown_tool",
      "Only the seven documented browser tools are available.",
    );
  const args = message.args === undefined ? {} : message.args;
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new LumiError("invalid_argument", "args must be a JSON object.");
  const fields = {
    list_sessions: [],
    snapshot: ["sessionId"],
    read_text: ["sessionId", "ref"],
    click: ["sessionId", "ref"],
    fill: ["sessionId", "ref", "text"],
    scroll: ["sessionId", "ref", "deltaX", "deltaY"],
    wait_for: ["sessionId", "ref", "text", "state", "timeoutMs"],
  }[message.tool];
  if (Object.keys(args).some((key) => !fields.includes(key)))
    throw new LumiError("invalid_argument", "Unknown tool argument.");
  if (new TextEncoder().encode(JSON.stringify(args)).length > 512 * 1024)
    throw new LumiError("invalid_argument", "Tool arguments exceed 512 KiB.");
  if (
    message.tool !== "list_sessions" &&
    (typeof args.sessionId !== "string" ||
      !args.sessionId ||
      args.sessionId.length > 128)
  )
    throw new LumiError(
      "invalid_argument",
      "A bounded sessionId string is required.",
    );
  if (
    args.ref !== undefined &&
    (typeof args.ref !== "string" || !args.ref || args.ref.length > 256)
  )
    throw new LumiError(
      "invalid_argument",
      "ref must be a nonempty string of at most 256 characters.",
    );
  if (
    args.text !== undefined &&
    (typeof args.text !== "string" || args.text.length > 100000)
  )
    throw new LumiError(
      "invalid_argument",
      "text must be a string of at most 100000 characters.",
    );
  for (const key of ["deltaX", "deltaY", "timeoutMs"])
    if (
      args[key] !== undefined &&
      (typeof args[key] !== "number" || !Number.isFinite(args[key]))
    )
      throw new LumiError(
        "invalid_argument",
        `${key} must be a finite number.`,
      );
  if (args.state !== undefined && !["visible", "hidden"].includes(args.state))
    throw new LumiError("invalid_argument", "state must be visible or hidden.");
  return args;
}
