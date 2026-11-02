import { Transform } from "node:stream";
export const MAX_FRAME = 1024 * 1024;
export class Frames extends Transform {
  constructor(native = false) {
    super({ readableObjectMode: true });
    this.native = native;
    this.buffer = Buffer.alloc(0);
  }
  _transform(chunk, enc, done) {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        let n, start;
        if (this.native) {
          if (this.buffer.length < 4) break;
          n = this.buffer.readUInt32LE(0);
          start = 4;
          if (!n || n > MAX_FRAME) throw Error("Invalid frame size");
          if (this.buffer.length < n + 4) break;
        } else {
          n = this.buffer.indexOf(10);
          start = 0;
          if (n < 0) break;
          if (n > MAX_FRAME) throw Error("Frame too large");
        }
        const b = this.buffer.subarray(start, start + n);
        this.buffer = this.buffer.subarray(start + n + (this.native ? 0 : 1));
        if (!b.length && !this.native) continue;
        const v = JSON.parse(b.toString("utf8"));
        if (!v || typeof v !== "object" || Array.isArray(v))
          throw Error("Expected object");
        this.push(v);
      }
      if (this.buffer.length > MAX_FRAME + (this.native ? 4 : 0))
        throw Error("Frame too large");
      done();
    } catch (e) {
      done(e);
    }
  }
  _flush(done) {
    done(this.buffer.length ? Error("Truncated frame") : undefined);
  }
}
export function writeFrame(stream, value, native = false) {
  const b = Buffer.from(JSON.stringify(value));
  if (b.length > MAX_FRAME) throw Error("Frame too large");
  if (stream.destroyed || stream.writableLength > MAX_FRAME * 4)
    throw Error("Connection unavailable or slow");
  if (native) {
    const h = Buffer.alloc(4);
    h.writeUInt32LE(b.length);
    stream.write(Buffer.concat([h, b]));
  } else stream.write(Buffer.concat([b, Buffer.from("\n")]));
}
const string = (maxLength = 256) => ({
    type: "string",
    minLength: 1,
    maxLength,
  }),
  sessionId = string(),
  ref = string();
const defs = [
  [
    "list_sessions",
    "List explicitly shared tabs. The first client to operate a session owns it until disconnect.",
    {},
    [],
  ],
  [
    "snapshot",
    "Observe a shared tab. Replaces previous control refs.",
    { sessionId },
    ["sessionId"],
  ],
  ["read_text", "Read untrusted page text.", { sessionId, ref }, ["sessionId"]],
  [
    "click",
    "Click a current snapshot ref.",
    { sessionId, ref },
    ["sessionId", "ref"],
  ],
  [
    "fill",
    "Replace editable text using CDP input.",
    { sessionId, ref, text: { type: "string", maxLength: 100000 } },
    ["sessionId", "ref", "text"],
  ],
  [
    "scroll",
    "Scroll the page or a referenced container.",
    {
      sessionId,
      ref,
      deltaX: { type: "number", minimum: -10000, maximum: 10000 },
      deltaY: { type: "number", minimum: -10000, maximum: 10000 },
    },
    ["sessionId"],
  ],
  [
    "wait_for",
    "Wait for exactly one text or ref condition.",
    {
      sessionId,
      ref,
      text: string(10000),
      state: { type: "string", enum: ["visible", "hidden"] },
      timeoutMs: { type: "integer", minimum: 1, maximum: 30000 },
    },
    ["sessionId"],
  ],
];
export const TOOLS = defs.map(([name, description, properties, required]) => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  },
}));
export function validate(tool, args) {
  const s = TOOLS.find((t) => t.name === tool)?.inputSchema;
  if (!s) throw Error("Unknown tool");
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw Error("Arguments must be an object");
  for (const k of s.required)
    if (!Object.hasOwn(args, k)) throw Error(`Missing ${k}`);
  for (const [k, v] of Object.entries(args)) {
    const p = s.properties[k];
    if (!p) throw Error(`Unexpected ${k}`);
    if (p.type === "integer" ? !Number.isInteger(v) : typeof v !== p.type)
      throw Error(`Invalid ${k}`);
    if (
      typeof v === "number" &&
      (!Number.isFinite(v) || v < p.minimum || v > p.maximum)
    )
      throw Error(`Invalid ${k}`);
    if (
      typeof v === "string" &&
      (v.length < (p.minLength ?? 0) || v.length > p.maxLength)
    )
      throw Error(`Invalid ${k}`);
    if (p.enum && !p.enum.includes(v)) throw Error(`Invalid ${k}`);
  }
  if (tool === "wait_for" && !!args.ref === !!args.text)
    throw Error("Provide exactly one of text or ref");
  return args;
}
