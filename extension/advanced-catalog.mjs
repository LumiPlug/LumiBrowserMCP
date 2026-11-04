// SPDX-License-Identifier: MPL-2.0
// Mirrored by Lumi Core advanced-tools.json; contract tests verify parity.
export const ADVANCED_TOOLS = [
  {
    name: "tab_info",
    description:
      "Read live tab/window/loading/opener state for one allowed session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
    },
  },
  {
    name: "wait_state",
    description:
      "Wait for URL, document ready, enabled/hidden ref, or an allowed child tab. No automatic action retries.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
        condition: {
          type: "string",
          enum: ["url", "ready", "enabled", "hidden", "new_tab"],
        },
        url: {
          type: "string",
          minLength: 1,
          maxLength: 2048,
        },
        ref: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: 30000,
        },
      },
      required: ["sessionId", "condition"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
    },
  },
  {
    name: "list_frames",
    description:
      "List allowed HTTP(S) frames with document-scoped frame tokens. Each frame is checked independently.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
    },
  },
  {
    name: "frame_action",
    description:
      "Operate one current allowed frame. DOM events are synthetic. Frame token and refs expire on navigation. No arbitrary scripts.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
        frameToken: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
        action: {
          type: "string",
          enum: [
            "snapshot",
            "read_text",
            "click",
            "fill",
            "hover",
            "select_option",
            "set_checked",
          ],
        },
        ref: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
        text: {
          type: "string",
          maxLength: 100000,
        },
        values: {
          type: "array",
          items: {
            type: "string",
            maxLength: 10000,
          },
          minItems: 1,
          maxItems: 100,
        },
        checked: {
          type: "boolean",
        },
      },
      required: ["sessionId", "frameToken", "action"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
    },
  },
  {
    name: "semantic_snapshot",
    description:
      "Read bounded accessibility tree including shadow controls; returns untrusted labels and short-lived semantic refs.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
    },
  },
  {
    name: "semantic_action",
    description:
      "Focus/click/fill a control from a current semantic snapshot, including shadow controls. Uses DOM events, not trusted OS input.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
        ref: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
        action: {
          type: "string",
          enum: ["focus", "click", "fill"],
        },
        text: {
          type: "string",
          maxLength: 100000,
        },
      },
      required: ["sessionId", "ref", "action"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
    },
  },
  {
    name: "upload_files",
    description:
      "Attach explicitly specified local files to a current file input ref. Does not submit the form. Core validates regular files; no directory uploads.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
        ref: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
        paths: {
          type: "array",
          items: {
            type: "string",
            minLength: 1,
            maxLength: 4096,
          },
          minItems: 1,
          maxItems: 10,
        },
      },
      required: ["sessionId", "ref", "paths"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
    },
  },
  {
    name: "download_start",
    description:
      "Start a download from an allowed HTTP(S) URL. Tracks only Lumi-owned downloads. Does not bypass browser warnings.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
        url: {
          type: "string",
          minLength: 1,
          maxLength: 2048,
        },
        filename: {
          type: "string",
          minLength: 1,
          maxLength: 200,
        },
      },
      required: ["sessionId", "url"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
    },
  },
  {
    name: "download_watch",
    description:
      "Arm a short watch for page-triggered downloads whose referrer matches this page. Pair with one explicit click; unrelated downloads excluded.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
        timeoutMs: {
          type: "integer",
          minimum: 1000,
          maximum: 30000,
        },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
    },
  },
  {
    name: "downloads",
    description:
      "Read only downloads associated with this session/tab, with completion, failure and filename.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
        downloadId: {
          type: "integer",
          minimum: 0,
          maximum: 2147483647,
        },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
    },
  },
  {
    name: "dialog",
    description:
      "Inspect or explicitly accept/dismiss a JavaScript dialog. Browser permission and security dialogs are not supported.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
        action: {
          type: "string",
          enum: ["read", "accept", "dismiss"],
        },
        promptText: {
          type: "string",
          maxLength: 10000,
        },
      },
      required: ["sessionId", "action"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
    },
  },
  {
    name: "diagnostics",
    description:
      "Start/stop/read bounded console, exceptions and network metadata for this session. No headers, cookies or request bodies.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
        action: {
          type: "string",
          enum: ["start", "stop", "read"],
        },
        kind: {
          type: "string",
          enum: ["all", "console", "network"],
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
        },
      },
      required: ["sessionId", "action"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
    },
  },
  {
    name: "response_body",
    description:
      "Read bounded text response for a request captured by diagnostics. Common credential fields are redacted. Explicit opt-in only.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
        requestId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
        maxBytes: {
          type: "integer",
          minimum: 1,
          maximum: 65536,
        },
      },
      required: ["sessionId", "requestId"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
    },
  },
  {
    name: "drag",
    description:
      "Drag between two current unobstructed refs. Uses bounded mouse steps; do not retry unknown outcomes.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
        sourceRef: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
        targetRef: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
        steps: {
          type: "integer",
          minimum: 2,
          maximum: 30,
        },
      },
      required: ["sessionId", "sourceRef", "targetRef"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
    },
  },
  {
    name: "capture_page",
    description:
      "Capture full-page or one element as a PNG artifact saved by Lumi Core. Capture is not a coordinate-click token.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
        mode: {
          type: "string",
          enum: ["full", "element"],
        },
        ref: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
      },
      required: ["sessionId", "mode"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
    },
  },
  {
    name: "extract_table",
    description:
      "Extract bounded rows, columns and links from a current native table or ARIA grid ref; virtualized rows are limited to loaded DOM.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
        ref: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
        offset: {
          type: "integer",
          minimum: 0,
          maximum: 100000,
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
        },
      },
      required: ["sessionId", "ref"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
    },
  },
  {
    name: "export_pdf",
    description:
      "Print page to a PDF artifact saved by Lumi Core. May return unsupported on Chrome builds that reject printing.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
        landscape: {
          type: "boolean",
        },
        printBackground: {
          type: "boolean",
        },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
    },
  },
  {
    name: "emulate",
    description:
      "Set or reset viewport/touch and network conditions for this tab only. State is reset on detach.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
        action: {
          type: "string",
          enum: ["set", "reset"],
        },
        width: {
          type: "integer",
          minimum: 320,
          maximum: 3840,
        },
        height: {
          type: "integer",
          minimum: 240,
          maximum: 3840,
        },
        deviceScaleFactor: {
          type: "number",
          minimum: 1,
          maximum: 3,
        },
        mobile: {
          type: "boolean",
        },
        touch: {
          type: "boolean",
        },
        offline: {
          type: "boolean",
        },
        latencyMs: {
          type: "integer",
          minimum: 0,
          maximum: 10000,
        },
        downloadKbps: {
          type: "integer",
          minimum: 1,
          maximum: 1000000,
        },
        uploadKbps: {
          type: "integer",
          minimum: 1,
          maximum: 1000000,
        },
      },
      required: ["sessionId", "action"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
    },
  },
  {
    name: "touch",
    description:
      "Send one viewport touch tap; requires recent screenshot capture, consumed once.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
        captureId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
        x: {
          type: "number",
          minimum: 0,
        },
        y: {
          type: "number",
          minimum: 0,
        },
      },
      required: ["sessionId", "captureId", "x", "y"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
    },
  },
];
