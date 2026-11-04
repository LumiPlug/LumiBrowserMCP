import { untilDialog } from "./dialog.mjs";
// SPDX-License-Identifier: MPL-2.0
import { ADVANCED_TOOLS } from "./advanced-catalog.mjs";
import { pageOperation } from "./page.js";

const MAX_ARTIFACT = 20 * 1024 * 1024;
export function scrub(value, depth = 0) {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string")
    return value
      .slice(0, 4096)
      .replace(/(bearer\s+)[\w.\-]+/gi, "$1[redacted]")
      .replace(
        /((?:password|token|secret|cookie|authorization|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi,
        "$1[redacted]",
      );
  if (Array.isArray(value))
    return value.slice(0, 100).map((v) => scrub(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([k, v]) => [
          k,
          /password|token|secret|cookie|authorization|api[_-]?key/i.test(k)
            ? "[redacted]"
            : scrub(v, depth + 1),
        ]),
    );
  return value;
}
export const safeUrl = (value) => {
  try {
    const u = new URL(value);
    return ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.origin + u.pathname
      : "[restricted]";
  } catch {
    return "[invalid]";
  }
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createAdvanced({
  sessions,
  guard,
  cdp,
  page,
  allowedUrl,
  holdTab,
}) {
  const downloads = new Map(),
    watches = new Map(),
    artifacts = new Map();
  const bound = (s, item) => item && item.sessionId === s.id;
  const storeArtifact = (s, data, mimeType) => {
    const size =
      Math.floor((data.length * 3) / 4) -
      (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
    if (size < 1 || size > MAX_ARTIFACT)
      throw error("artifact_too_large", "Artifact must be at most 20 MiB");
    for (const [id, item] of artifacts)
      if (Date.now() - item.created > 120000) artifacts.delete(id);
    if (artifacts.size >= 4)
      throw error("artifact_busy", "Finish existing artifact transfers first");
    const artifactId = crypto.randomUUID();
    artifacts.set(artifactId, {
      sessionId: s.id,
      data,
      size,
      mimeType,
      created: Date.now(),
    });
    return { artifactId, size, mimeType };
  };
  function error(code, message) {
    return Object.assign(new Error(message), { code });
  }
  async function mutating(s, fn) {
    try {
      return await fn();
    } catch (e) {
      if (e.code === "dialog_opened") throw e;
      await holdTab(s, "paused").catch(() => {});
      throw error(
        "outcome_unknown",
        "Operation may have occurred. Inspect the page; never retry automatically.",
      );
    }
  }
  function currentSession(tabId) {
    return [...sessions.values()].find(
      (s) => s.tabId === tabId && s.state === "active",
    );
  }
  function rememberDownload(s, item) {
    if (downloads.size >= 100) downloads.delete(downloads.keys().next().value);
    downloads.set(item.id, {
      sessionId: s.id,
      tabId: s.tabId,
      id: item.id,
      url: item.finalUrl || item.url,
      created: Date.now(),
    });
  }
  chrome.webNavigation.onCreatedNavigationTarget?.addListener((event) => {
    const s = currentSession(event.sourceTabId);
    if (!s || !allowedUrl(event.url)) return;
    s.childTabs ??= new Set();
    if (s.childTabs.size >= 100)
      s.childTabs.delete(s.childTabs.values().next().value);
    s.childTabs.add(event.tabId);
  });
  chrome.downloads?.onCreated?.addListener((item) => {
    if (!item.referrer) return;
    for (const [tabId, w] of watches) {
      const s = currentSession(tabId);
      if (
        !s ||
        s.id !== w.sessionId ||
        Date.now() > w.expires ||
        s.url !== w.url
      ) {
        watches.delete(tabId);
        continue;
      }
      if (item.referrer === s.url && allowedUrl(item.url)) {
        rememberDownload(s, item);
        watches.delete(tabId);
      }
    }
  });
  chrome.debugger.onEvent?.addListener((source, method, p) => {
    if (source.sessionId) return; // Child target data requires independent frame permission.
    const s = currentSession(source.tabId);
    if (!s || !allowedUrl(s.url)) return;
    if (method === "Page.javascriptDialogOpening")
      s.dialog = {
        type: p.type,
        message: String(p.message || "").slice(0, 4096),
        url: p.url,
      };
    if (method === "Page.javascriptDialogClosed") s.dialog = null;
    const d = s.diagnostics;
    if (!d?.enabled) return;
    const add = (item) => {
      d.events.push({ time: Date.now(), ...item });
      if (d.events.length > 200) d.events.shift();
    };
    if (
      method === "Network.requestWillBeSent" &&
      (!allowedUrl(p.documentURL) || !allowedUrl(p.request?.url))
    )
      d.requests.delete(p.requestId);
    if (
      method === "Network.requestWillBeSent" &&
      allowedUrl(p.documentURL) &&
      allowedUrl(p.request?.url)
    ) {
      if (d.requests.size >= 200)
        d.requests.delete(d.requests.keys().next().value);
      d.requests.set(p.requestId, {
        url: p.request.url,
        documentUrl: p.documentURL,
        mimeType: "",
      });
      add({
        kind: "network",
        event: "request",
        requestId: p.requestId,
        url: safeUrl(p.request.url),
        method: p.request.method,
      });
    }
    if (method === "Network.responseReceived") {
      const r = d.requests.get(p.requestId);
      if (!r) return;
      if (!allowedUrl(p.response.url)) {
        d.requests.delete(p.requestId);
        return;
      }
      r.url = p.response.url;
      r.mimeType = p.response.mimeType;
      add({
        kind: "network",
        event: "response",
        requestId: p.requestId,
        url: safeUrl(r.url),
        status: p.response.status,
        mimeType: r.mimeType,
      });
    }
    if (method === "Network.loadingFailed" && d.requests.has(p.requestId))
      add({
        kind: "network",
        event: "failed",
        requestId: p.requestId,
        error: scrub(p.errorText),
      });
    if (
      method === "Runtime.executionContextCreated" &&
      p.context.auxData?.frameId === d.mainFrame &&
      p.context.auxData?.isDefault
    )
      d.contexts.add(p.context.id);
    if (method === "Runtime.executionContextDestroyed")
      d.contexts.delete(p.executionContextId);
    if (
      method === "Runtime.consoleAPICalled" &&
      d.contexts.has(p.executionContextId)
    )
      add({
        kind: "console",
        level: p.type,
        text: (p.args || [])
          .slice(0, 10)
          .map((a) => scrub(a.value ?? a.description ?? `[${a.type}]`)),
      });
    if (
      method === "Runtime.exceptionThrown" &&
      d.contexts.has(p.exceptionDetails?.executionContextId)
    )
      add({
        kind: "console",
        level: "exception",
        text: scrub(
          p.exceptionDetails?.exception?.description ||
            p.exceptionDetails?.text ||
            "Script exception",
        ),
      });
  });
  async function checkedFrame(s, token) {
    const f = s.frameTokens?.get(token);
    if (!f || Date.now() - f.created > 60000)
      throw error("stale_frame", "List frames again");
    const now = await chrome.webNavigation.getFrame({
      tabId: s.tabId,
      frameId: f.frameId,
    });
    if (
      !now ||
      now.documentId !== f.documentId ||
      now.url !== f.url ||
      !allowedUrl(now.url)
    )
      throw error("stale_frame", "Frame navigated or is blocked");
    return f;
  }
  async function context(s, epoch) {
    const { frameTree } = await cdp(s, epoch, "Page.getFrameTree", {});
    return (
      await cdp(s, epoch, "Page.createIsolatedWorld", {
        frameId: frameTree.frame.id,
        worldName: "lumi-browser-semantic",
      })
    ).executionContextId;
  }
  async function tabInfo(s, epoch) {
    await guard(s, epoch);
    const t = await chrome.tabs.get(s.tabId);
    const w = await chrome.windows.get(t.windowId);
    await guard(s, epoch);
    return {
      tabId: t.id,
      windowId: t.windowId,
      active: t.active,
      windowFocused: w.focused,
      loading: t.status === "loading",
      index: t.index,
      openerTabId: t.openerTabId ?? null,
      url: t.url,
      title: t.title,
    };
  }
  async function run(tool, s, epoch, args) {
    if (tool === "artifact_chunk") {
      const a = artifacts.get(args.artifactId);
      if (
        !bound(s, a) ||
        Date.now() - a.created > 120000 ||
        args.offset % 49152 !== 0 ||
        args.offset >= a.size
      )
        throw error("artifact_expired", "Artifact unavailable");
      const start = (args.offset / 3) * 4,
        data = a.data.slice(start, start + 65536),
        eof = start + data.length === a.data.length;
      if (eof) artifacts.delete(args.artifactId);
      return { data, eof };
    }
    if (tool === "tab_info") return tabInfo(s, epoch);
    if (tool === "wait_state") {
      if (args.condition === "url" && (!args.url || !allowedUrl(args.url)))
        throw error("invalid_argument", "Provide an allowed exact target URL");
      if (["enabled", "hidden"].includes(args.condition) && !args.ref)
        throw error("invalid_argument", "Current ref required");
      const deadline = Date.now() + (args.timeoutMs ?? 10000),
        originalTabId = s.tabId;
      do {
        // Navigation waits may outlive the old session; only inspect fresh allowed sessions of this tab.
        const current = currentSession(originalTabId);
        if (current) {
          await guard(current, current.epoch);
          if (
            args.condition === "url" &&
            current.url === new URL(args.url).href
          )
            return { matched: true, sessionId: current.id, url: current.url };
          if (
            args.condition === "ready" &&
            (await page(current, "document_state")).readyState === "complete"
          )
            return { matched: true, sessionId: current.id };
          if (["enabled", "hidden"].includes(args.condition)) {
            if (current.id !== s.id)
              throw error("stale_ref", "Navigation invalidated the ref");
            const state = await page(s, "ref_state", args);
            if (args.condition === "enabled" ? state.enabled : !state.visible)
              return { matched: true };
          }
          if (args.condition === "new_tab") {
            const tabs = await chrome.tabs.query({});
            const allowed = tabs
              .filter(
                (t) =>
                  (t.openerTabId === originalTabId || s.childTabs?.has(t.id)) &&
                  allowedUrl(t.url),
              )
              .map((t) => currentSession(t.id))
              .filter(Boolean);
            if (allowed.length)
              return {
                matched: true,
                sessions: allowed.map((t) => ({
                  sessionId: t.id,
                  tabId: t.tabId,
                  url: t.url,
                })),
              };
          }
        }
        await pause(100);
      } while (Date.now() < deadline);
      throw error("timeout", "Condition not reached");
    }
    if (tool === "list_frames") {
      const frames = await chrome.webNavigation.getAllFrames({
        tabId: s.tabId,
      });
      await guard(s, epoch);
      s.frameTokens = new Map();
      return {
        frames: (frames || [])
          .filter((f) => f.documentId && allowedUrl(f.url))
          .slice(0, 100)
          .map((f) => {
            const frameToken = crypto.randomUUID();
            s.frameTokens.set(frameToken, { ...f, created: Date.now() });
            return {
              frameToken,
              frameId: f.frameId,
              parentFrameId: f.parentFrameId,
              url: f.url,
            };
          }),
      };
    }
    if (tool === "frame_action") {
      const f = await checkedFrame(s, args.frameToken);
      if (!["snapshot", "read_text"].includes(args.action) && !args.ref)
        throw error("invalid_argument", "Current frame ref required");
      if (
        (args.action === "fill" && typeof args.text !== "string") ||
        (args.action === "select_option" && !args.values) ||
        (args.action === "set_checked" && typeof args.checked !== "boolean")
      )
        throw error("invalid_argument", "Missing action argument");
      const invoke = async () => {
        await guard(s, epoch);
        await checkedFrame(s, args.frameToken);
        const result = await untilDialog(s, () =>
          chrome.scripting.executeScript({
            target: { tabId: s.tabId, documentIds: [f.documentId] },
            world: "ISOLATED",
            func: pageOperation,
            args: [
              "frame_perform",
              {
                ...args,
                expectedUrl: f.url,
                expectedOrigin: new URL(f.url).origin,
                sessionToken: s.id + ":" + f.documentId,
              },
            ],
          }),
        );
        await guard(s, epoch);
        await checkedFrame(s, args.frameToken);
        const value = result[0]?.result;
        if (!value) throw error("frame_unavailable", "Frame unavailable");
        if (value.error) throw error(value.error.code, value.error.message);
        return value;
      };
      return ["snapshot", "read_text"].includes(args.action)
        ? invoke()
        : mutating(s, invoke);
    }
    if (tool === "semantic_snapshot") {
      const { frameTree } = await cdp(s, epoch, "Page.getFrameTree", {});
      const { nodes } = await cdp(s, epoch, "Accessibility.getFullAXTree", {
        frameId: frameTree.frame.id,
      });
      const excluded = new Set();
      for (const n of nodes)
        if (
          (n.frameId && n.frameId !== frameTree.frame.id) ||
          ["Iframe", "IframePresentational"].includes(n.role?.value)
        )
          excluded.add(n.nodeId);
      const byId = new Map(nodes.map((n) => [n.nodeId, n]));
      const queue = [...excluded];
      for (let i = 0; i < queue.length; i++)
        for (const id of byId.get(queue[i])?.childIds || [])
          if (!excluded.has(id)) {
            excluded.add(id);
            queue.push(id);
          }
      await guard(s, epoch);
      s.semanticRefs = new Map();
      s.semanticCreated = Date.now();
      const result = [];
      for (const n of nodes) {
        if (n.ignored || excluded.has(n.nodeId)) continue;
        const ref = crypto.randomUUID();
        if (n.backendDOMNodeId) s.semanticRefs.set(ref, n.backendDOMNodeId);
        result.push({
          ref: n.backendDOMNodeId ? ref : null,
          role: n.role?.value,
          name: String(n.name?.value || "").slice(0, 500),
          properties: (n.properties || [])
            .filter((p) =>
              [
                "disabled",
                "checked",
                "expanded",
                "required",
                "focusable",
              ].includes(p.name),
            )
            .map((p) => ({ name: p.name, value: p.value?.value })),
        });
        if (result.length >= 500) break;
      }
      return {
        nodes: result,
        truncated: nodes.length > result.length,
        contentTrust: "untrusted_page_data",
      };
    }
    if (tool === "semantic_action") {
      const id = s.semanticRefs?.get(args.ref);
      if (!id || Date.now() - s.semanticCreated > 30000)
        throw error("stale_ref", "Take a new semantic snapshot");
      if (args.action === "fill" && typeof args.text !== "string")
        throw error("invalid_argument", "text required");
      const executionContextId = await context(s, epoch);
      const { object } = await cdp(s, epoch, "DOM.resolveNode", {
        backendNodeId: id,
        executionContextId,
        objectGroup: "lumi-semantic",
      });
      try {
        return await mutating(s, async () => {
          const result = await cdp(s, epoch, "Runtime.callFunctionOn", {
            objectId: object.objectId,
            returnByValue: true,
            functionDeclaration: `function(action,text){if(!this.isConnected||this.disabled||this.getAttribute('aria-disabled')==='true')throw Error('Target unavailable');const r=this.getBoundingClientRect();if(!r.width||!r.height)throw Error('Target hidden');this.scrollIntoView({block:'center'});const b=this.getBoundingClientRect();const root=this.getRootNode();let hit=(root.elementFromPoint||document.elementFromPoint).call(root,b.x+b.width/2,b.y+b.height/2);if(hit!==this&&!this.contains(hit))throw Error('Target obscured');this.focus();if(action==='click')this.click();if(action==='fill'){if(this.readOnly)throw Error('readonly');if(this.isContentEditable)this.textContent=text;else {if(!['INPUT','TEXTAREA'].includes(this.tagName)||this.tagName==='INPUT'&&!['text','email','search','url','tel','password','number'].includes(this.type))throw Error('not editable');Object.getOwnPropertyDescriptor(this.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(this,text);}this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));}return {dispatched:true,inputMode:'dom_events'};}`,
            arguments: [{ value: args.action }, { value: args.text ?? "" }],
          });
          if (result.exceptionDetails)
            throw error("semantic_action_failed", "Semantic action failed");
          await guard(s, epoch);
          return result.result.value;
        });
      } finally {
        await cdp(s, epoch, "Runtime.releaseObjectGroup", {
          objectGroup: "lumi-semantic",
        }).catch(() => {});
      }
    }
    if (tool === "upload_files") {
      const marker = await page(s, "file_marker", {
        ...args,
        count: args.paths.length,
      });
      try {
        const { root } = await cdp(s, epoch, "DOM.getDocument", {
          depth: -1,
          pierce: true,
        });
        const stack = [root];
        let target,
          visited = 0;
        while (stack.length && visited++ < 100000) {
          const n = stack.pop(),
            a = n.attributes || [];
          for (let i = 0; i < a.length; i += 2)
            if (a[i] === "data-lumi-upload" && a[i + 1] === marker.marker)
              target = n;
          stack.push(...(n.children || []), ...(n.shadowRoots || []));
        }
        if (!target)
          throw error("file_input_unavailable", "Current file input not found");
        return await mutating(s, async () => {
          await cdp(s, epoch, "DOM.setFileInputFiles", {
            files: args.paths,
            backendNodeId: target.backendNodeId,
          });
          return {
            dispatched: true,
            count: args.paths.length,
            submitted: false,
          };
        });
      } finally {
        await page(s, "remove_file_marker", {
          ...args,
          marker: marker.marker,
        }).catch(() => {});
      }
    }
    if (["download_start", "download_watch", "downloads"].includes(tool)) {
      if (!(await chrome.permissions.contains({ permissions: ["downloads"] })))
        throw error(
          "permission_required",
          "Chrome downloads permission required",
        );
      if (tool === "download_watch") {
        watches.set(s.tabId, {
          sessionId: s.id,
          url: s.url,
          expires: Date.now() + (args.timeoutMs ?? 15000),
        });
        return {
          watching: true,
          expiresInMs: args.timeoutMs ?? 15000,
          association: "exact_referrer",
        };
      }
      if (tool === "download_start") {
        if (!allowedUrl(args.url))
          throw error("blocked_url", "Download URL is blocked");
        if (
          args.filename &&
          (/[\\/\x00-\x1f]/.test(args.filename) ||
            args.filename === "." ||
            args.filename === "..")
        )
          throw error("invalid_argument", "filename must be a plain basename");
        return mutating(s, async () => {
          await guard(s, epoch);
          const id = await chrome.downloads.download({
            url: args.url,
            ...(args.filename ? { filename: args.filename } : {}),
            conflictAction: "uniquify",
            saveAs: false,
          });
          rememberDownload(s, { id, url: args.url });
          return { downloadId: id };
        });
      }
      const result = [];
      for (const item of downloads.values()) {
        if (
          !bound(s, item) ||
          (args.downloadId !== undefined && item.id !== args.downloadId)
        )
          continue;
        const [d] = await chrome.downloads.search({ id: item.id });
        if (!d) continue;
        if (!allowedUrl(d.finalUrl || d.url)) continue;
        result.push({
          id: d.id,
          filename: d.filename,
          state: d.state,
          error: d.error || null,
          bytesReceived: d.bytesReceived,
          totalBytes: d.totalBytes,
          danger: d.danger,
          exists: d.exists,
        });
      }
      await guard(s, epoch);
      return { downloads: result };
    }
    if (tool === "dialog") {
      if (s.dialog?.url && !allowedUrl(s.dialog.url))
        throw error("blocked_url", "Dialog source is blocked");
      if (args.action === "read")
        return {
          dialog: s.dialog
            ? { type: s.dialog.type, message: s.dialog.message }
            : null,
        };
      if (!s.dialog) throw error("no_dialog", "No JavaScript dialog observed");
      if (s.dialog.url && !allowedUrl(s.dialog.url))
        throw error("blocked_url", "Dialog source is blocked");
      return mutating(s, async () => {
        await cdp(s, epoch, "Page.handleJavaScriptDialog", {
          accept: args.action === "accept",
          promptText: args.promptText ?? "",
        });
        return { dispatched: true };
      });
    }
    if (tool === "diagnostics") {
      if (args.action === "start") {
        const { frameTree } = await cdp(s, epoch, "Page.getFrameTree", {});
        s.diagnostics = {
          enabled: true,
          events: [],
          requests: new Map(),
          contexts: new Set(),
          mainFrame: frameTree.frame.id,
        };
        try {
          await cdp(s, epoch, "Network.enable", {
            maxTotalBufferSize: 2 * 1024 * 1024,
            maxResourceBufferSize: 128 * 1024,
          });
          await cdp(s, epoch, "Runtime.enable", {});
        } catch (e) {
          s.diagnostics.enabled = false;
          throw e;
        }
        return { enabled: true };
      }
      if (args.action === "stop") {
        if (s.diagnostics) s.diagnostics.enabled = false;
        await cdp(s, epoch, "Network.disable", {});
        await cdp(s, epoch, "Runtime.disable", {});
        return { enabled: false };
      }
      return {
        enabled: !!s.diagnostics?.enabled,
        events: (s.diagnostics?.events || [])
          .filter(
            (x) => !args.kind || args.kind === "all" || x.kind === args.kind,
          )
          .slice(-(args.limit || 100)),
        contentTrust: "untrusted_page_data",
      };
    }
    if (tool === "response_body") {
      const r = s.diagnostics?.requests.get(args.requestId);
      if (!r || !allowedUrl(r.url) || !allowedUrl(r.documentUrl))
        throw error(
          "unknown_request",
          "Request not available in this allowed session",
        );
      if (!/text|json|xml|javascript/.test(r.mimeType))
        throw error(
          "unsupported_content",
          "Only text response bodies are supported",
        );
      const result = await cdp(s, epoch, "Network.getResponseBody", {
        requestId: args.requestId,
      });
      await guard(s, epoch);
      if (
        s.diagnostics?.requests.get(args.requestId) !== r ||
        !allowedUrl(r.url) ||
        !allowedUrl(r.documentUrl)
      )
        throw error("unknown_request", "Request changed during retrieval");
      if (result.base64Encoded)
        throw error("unsupported_content", "Encoded bodies are not exposed");
      const max = args.maxBytes ?? 65536;
      let text = result.body;
      try {
        text = JSON.stringify(scrub(JSON.parse(text)));
      } catch {
        text = scrub(text);
      }
      const bytes = new TextEncoder().encode(text);
      return {
        text: new TextDecoder().decode(bytes.slice(0, max)),
        truncated:
          bytes.length > max ||
          new TextEncoder().encode(result.body).length > 4096,
        contentTrust: "untrusted_page_data",
      };
    }
    if (tool === "extract_table") {
      const result = await page(s, "extract_table", args);
      await guard(s, epoch);
      return result;
    }
    if (tool === "capture_page") {
      if (args.mode === "element" && !args.ref)
        throw error("invalid_argument", "Element ref required");
      const clip = await page(
        s,
        "capture_bounds",
        args.mode === "element" ? args : {},
      );
      if (
        clip.width < 1 ||
        clip.height < 1 ||
        clip.width > 8192 ||
        clip.height > 30000 ||
        clip.width * clip.height > 32000000
      )
        throw error(
          "capture_too_large",
          "Capture at most 32 million CSS pixels; use an element capture",
        );
      const { data } = await cdp(s, epoch, "Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        fromSurface: true,
        clip: {
          x: clip.x,
          y: clip.y,
          width: clip.width,
          height: clip.height,
          scale: 1 / clip.dpr,
        },
      });
      await guard(s, epoch);
      return storeArtifact(s, data, "image/png");
    }
    if (tool === "export_pdf") {
      let result;
      try {
        result = await cdp(s, epoch, "Page.printToPDF", {
          landscape: args.landscape ?? false,
          printBackground: args.printBackground ?? true,
          transferMode: "ReturnAsStream",
        });
      } catch {
        throw error(
          "unsupported",
          "This Chrome target does not support PDF printing",
        );
      }
      await guard(s, epoch);
      if (result.data) return storeArtifact(s, result.data, "application/pdf");
      let data = "",
        size = 0;
      try {
        while (true) {
          const chunk = await cdp(s, epoch, "IO.read", {
            handle: result.stream,
            size: 49152,
          });
          if (!chunk.base64Encoded)
            throw error("unsupported", "Expected binary PDF stream");
          size += Math.floor((chunk.data.length * 3) / 4);
          if (size > MAX_ARTIFACT)
            throw error("artifact_too_large", "PDF exceeds 20 MiB");
          data += atob(chunk.data);
          if (chunk.eof) break;
        }
      } finally {
        await chrome.debugger
          .sendCommand({ tabId: s.tabId }, "IO.close", {
            handle: result.stream,
          })
          .catch(() => {});
      }
      await guard(s, epoch);
      return storeArtifact(s, btoa(data), "application/pdf");
    }
    if (tool === "drag") {
      await page(s, "validate", { ref: args.sourceRef, action: "click" });
      await page(s, "validate", { ref: args.targetRef, action: "click" });
      return mutating(s, async () => {
        const a = await page(s, "prepare", {
            ref: args.sourceRef,
            action: "click",
          }),
          b = await page(s, "prepare", {
            ref: args.targetRef,
            action: "click",
          });
        await page(s, "verify", { ref: args.sourceRef, action: "click", ...a });
        await page(s, "verify", { ref: args.targetRef, action: "click", ...b });
        await cdp(s, epoch, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          ...a,
        });
        await cdp(s, epoch, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          button: "left",
          buttons: 1,
          clickCount: 1,
          ...a,
        });
        const steps = args.steps ?? 10;
        let dragData;
        let intercepted;
        const onDrag = (source, method, params) => {
          if (
            source.tabId === s.tabId &&
            !source.sessionId &&
            method === "Input.dragIntercepted"
          ) {
            dragData = params.data;
            intercepted?.();
          }
        };
        chrome.debugger.onEvent?.addListener(onDrag);
        try {
          await cdp(s, epoch, "Input.setInterceptDrags", { enabled: true });
          for (let i = 1; i <= steps; i++) {
            const dragEvent = new Promise((resolve) => {
              intercepted = resolve;
            });
            await Promise.race([
              cdp(s, epoch, "Input.dispatchMouseEvent", {
                type: "mouseMoved",
                buttons: 1,
                x: a.x + ((b.x - a.x) * i) / steps,
                y: a.y + ((b.y - a.y) * i) / steps,
              }),
              dragEvent,
            ]);
            if (dragData) {
              for (const type of ["dragEnter", "dragOver", "drop"])
                await cdp(s, epoch, "Input.dispatchDragEvent", {
                  type,
                  x: b.x,
                  y: b.y,
                  data: dragData,
                });
              break;
            }
          }
          await cdp(s, epoch, "Input.dispatchMouseEvent", {
            type: "mouseReleased",
            button: "left",
            buttons: 0,
            clickCount: 1,
            ...b,
          });
        } catch (e) {
          await chrome.debugger
            .sendCommand({ tabId: s.tabId }, "Input.cancelDragging", {})
            .catch(() => {});
          throw e;
        } finally {
          chrome.debugger.onEvent?.removeListener?.(onDrag);
          await chrome.debugger
            .sendCommand({ tabId: s.tabId }, "Input.setInterceptDrags", {
              enabled: false,
            })
            .catch(() => {});
        }
        return { dispatched: true };
      });
    }
    if (tool === "emulate") {
      if (
        args.action === "set" &&
        (args.width === undefined) !== (args.height === undefined)
      )
        throw error("invalid_argument", "Supply both width and height");
      return mutating(s, async () => {
        if (args.action === "reset") {
          await cdp(s, epoch, "Emulation.clearDeviceMetricsOverride", {});
          await cdp(s, epoch, "Emulation.setTouchEmulationEnabled", {
            enabled: false,
          });
          await cdp(s, epoch, "Network.emulateNetworkConditions", {
            offline: false,
            latency: 0,
            downloadThroughput: -1,
            uploadThroughput: -1,
          });
        } else {
          if (args.width)
            await cdp(s, epoch, "Emulation.setDeviceMetricsOverride", {
              width: args.width,
              height: args.height,
              deviceScaleFactor: args.deviceScaleFactor ?? 1,
              mobile: args.mobile ?? false,
            });
          if (args.touch !== undefined)
            await cdp(s, epoch, "Emulation.setTouchEmulationEnabled", {
              enabled: args.touch,
              maxTouchPoints: 1,
            });
          if (
            ["offline", "latencyMs", "downloadKbps", "uploadKbps"].some(
              (k) => args[k] !== undefined,
            )
          )
            await cdp(s, epoch, "Network.emulateNetworkConditions", {
              offline: args.offline ?? false,
              latency: args.latencyMs ?? 0,
              downloadThroughput: args.downloadKbps
                ? (args.downloadKbps * 1024) / 8
                : -1,
              uploadThroughput: args.uploadKbps
                ? (args.uploadKbps * 1024) / 8
                : -1,
            });
        }
        s.capture = null;
        return { dispatched: true, reset: args.action === "reset" };
      });
    }
    if (tool === "touch") {
      const c = s.capture;
      s.capture = null;
      if (
        !c ||
        c.captureId !== args.captureId ||
        c.epoch !== epoch ||
        Date.now() - c.created > 30000 ||
        JSON.stringify(c.viewport) !==
          JSON.stringify(await page(s, "viewport")) ||
        args.x >= c.viewport.width ||
        args.y >= c.viewport.height
      )
        throw error("stale_capture", "Capture again before touch");
      return mutating(s, async () => {
        await cdp(s, epoch, "Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x: args.x, y: args.y }],
        });
        try {
          await cdp(s, epoch, "Input.dispatchTouchEvent", {
            type: "touchEnd",
            touchPoints: [],
          });
        } catch (e) {
          await chrome.debugger
            .sendCommand({ tabId: s.tabId }, "Input.dispatchTouchEvent", {
              type: "touchCancel",
              touchPoints: [],
            })
            .catch(() => {});
          throw e;
        }
        return { dispatched: true };
      });
    }
    throw error("unknown_tool", "Unknown advanced tool");
  }
  return {
    handles: (tool) =>
      tool === "artifact_chunk" || ADVANCED_TOOLS.some((x) => x.name === tool),
    async attach(s, epoch) {
      await cdp(s, epoch, "Page.enable", {});
    },
    run,
    forget(s) {
      s.childTabs = null;
      watches.delete(s.tabId);
      for (const [id, a] of artifacts) if (bound(s, a)) artifacts.delete(id);
      for (const [id, d] of downloads) if (bound(s, d)) downloads.delete(id);
      s.diagnostics = null;
      s.frameTokens = null;
      s.semanticRefs = null;
    },
  };
}
