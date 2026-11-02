// Runs only in the extension's isolated world, in the authorized main frame.
export function pageOperation(operation, args = {}) {
  if (args.expectedOrigin && location.origin !== args.expectedOrigin)
    return {
      error: {
        code: "origin_changed",
        message: "Authorized origin no longer matches.",
      },
    };
  const key = "__lumi_browser_mcp_v1__";
  let registry = globalThis[key];
  if (!registry || registry.document !== document) {
    registry = globalThis[key] = {
      document,
      prefix: crypto.randomUUID(),
      generation: 0,
      refs: new Map(),
      overlay: null,
    };
  }
  const fail = (code, message) => ({ error: { code, message } });
  const visible = (el) => {
    if (!el?.isConnected) return false;
    if (
      el.checkVisibility &&
      !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    )
      return false;
    const style = getComputedStyle(el),
      r = el.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.visibility !== "collapse" &&
      Number(style.opacity) !== 0 &&
      r.width > 0 &&
      r.height > 0
    );
  };
  const referencedText = (el, attr) =>
    (el.getAttribute(attr) || "")
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent || "")
      .join(" ")
      .trim();
  const labelText = (el) =>
    [...(el.labels || [])]
      .map((l) => l.innerText || l.textContent || "")
      .join(" ")
      .trim();
  const name = (el) =>
    (
      el.getAttribute("aria-label") ||
      referencedText(el, "aria-labelledby") ||
      labelText(el) ||
      el.getAttribute("alt") ||
      el.getAttribute("placeholder") ||
      el.innerText ||
      el.getAttribute("title") ||
      ""
    ).trim();
  // A recycled virtual-list node must not silently become a different target.
  // Include the resolved naming sources, not only label IDs. Input.value is
  // deliberately excluded: normal editing must not invalidate its own identity.
  const fingerprint = (el) => {
    const identityAttrs = [
      "id",
      "role",
      "type",
      "name",
      "href",
      "src",
      "alt",
      "title",
      "placeholder",
      "contenteditable",
      "aria-label",
      "aria-labelledby",
      "aria-describedby",
      "for",
      "form",
      "data-testid",
      "data-order",
      "orderid",
    ];
    const dataAttrs = (el.getAttributeNames?.() || []).filter((k) =>
      k.startsWith("data-"),
    );
    const attrs = [...new Set([...identityAttrs, ...dataAttrs])]
      .sort()
      .map((k) => [k, el.getAttribute(k)]);
    return JSON.stringify([
      el.tagName,
      attrs,
      name(el),
      labelText(el),
      referencedText(el, "aria-labelledby"),
      referencedText(el, "aria-describedby"),
      el.innerText || "",
    ]);
  };
  const get = (ref) => {
    const entry = registry.refs.get(ref);
    return entry && fingerprint(entry.el) === entry.fingerprint
      ? entry.el
      : null;
  };
  const isScrollable = (el) => {
    const style = getComputedStyle(el);
    return (
      (el.scrollHeight > el.clientHeight &&
        /auto|scroll/.test(style.overflowY)) ||
      (el.scrollWidth > el.clientWidth && /auto|scroll/.test(style.overflowX))
    );
  };
  const state = (el) => ({
    scrollable: isScrollable(el),
    disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true",
    checked: "checked" in el ? !!el.checked : el.getAttribute("aria-checked"),
    expanded: el.getAttribute("aria-expanded"),
    value:
      el.type === "password"
        ? "[redacted]"
        : "value" in el
          ? String(el.value).slice(0, 1000)
          : undefined,
  });
  if (operation === "snapshot") {
    registry.generation++;
    registry.refs.clear();
    const interactive = [
      ...document.querySelectorAll(
        'a[href],button,input,textarea,select,[role],[contenteditable="true"],summary',
      ),
    ];
    const scrollable = [...document.querySelectorAll("*")]
      .slice(0, 20000)
      .filter((el) => {
        if (
          el.scrollHeight <= el.clientHeight &&
          el.scrollWidth <= el.clientWidth
        )
          return false;
        const style = getComputedStyle(el);
        return /auto|scroll/.test(style.overflowX + style.overflowY);
      });
    const nodes = [...new Set([...interactive, ...scrollable])]
      .filter(visible)
      .slice(0, 500);
    const fullText = document.body?.innerText || "";
    const reasons = [];
    if (fullText.length > 60000) reasons.push("text_limit");
    if (nodes.length === 500) reasons.push("control_limit");
    const result = {
      url: location.href.slice(0, 8192),
      title: document.title.slice(0, 1024),
      text: fullText.slice(0, 60000),
      controls: [],
      truncated: false,
      truncationReasons: reasons,
      scope: "main_frame_light_dom",
      unsupported: ["iframes", "closed_shadow_roots", "canvas_targets"],
      contentTrust: "untrusted_page_data",
    };
    // Budget UTF-8 bytes rather than JS characters (Chinese can use 3 bytes).
    // Keep headroom for final flags and the native protocol response envelope.
    const encoder = new TextEncoder();
    let bytes = encoder.encode(JSON.stringify(result)).length;
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i],
        ref = `${registry.prefix}:${registry.generation}:${i}`;
      const control = {
        ref,
        role:
          el.getAttribute("role") ||
          (isScrollable(el) ? "scroll_region" : el.tagName.toLowerCase()),
        name: name(el).slice(0, 500),
        state: state(el),
      };
      const addition = encoder.encode(JSON.stringify(control)).length + 1;
      if (bytes + addition > 700 * 1024 - 512) {
        reasons.push("utf8_response_budget");
        break;
      }
      result.controls.push(control);
      registry.refs.set(ref, { el, fingerprint: fingerprint(el) });
      bytes += addition;
    }
    if (location.href.length > 8192 || document.title.length > 1024)
      reasons.push("metadata_limit");
    result.truncated = reasons.length > 0;
    return result;
  }
  if (operation === "read_text") {
    const el = args.ref ? get(args.ref) : document.body;
    if (!el?.isConnected)
      return fail(
        "stale_ref",
        "Take a fresh snapshot; the element reference is stale.",
      );
    return {
      text: (el.innerText || el.textContent || "").slice(0, 60000),
      contentTrust: "untrusted_page_data",
    };
  }
  if (operation === "wait_check") {
    if (args.ref) {
      const el = get(args.ref);
      if (!el) return fail("stale_ref", "Unknown or expired reference.");
      return { matched: args.state === "hidden" ? !visible(el) : visible(el) };
    }
    const found = (document.body?.innerText || "").includes(args.text);
    return { matched: args.state === "hidden" ? !found : found };
  }
  if (operation === "remove_overlay") {
    registry.overlay?.remove();
    registry.overlay = null;
    return { ok: true };
  }
  if (operation === "cursor") {
    if (!registry.overlay?.isConnected) {
      const el = document.createElement("div");
      el.setAttribute("aria-hidden", "true");
      el.style.cssText =
        "all:initial;position:fixed;z-index:2147483647;pointer-events:none;width:14px;height:14px;border:2px solid #fff;background:#7955f5;border-radius:50%;box-shadow:0 0 0 2px #7955f5;transform:translate(-50%,-50%);";
      const label = document.createElement("span");
      label.textContent = "Lumi";
      label.style.cssText =
        "position:absolute;left:18px;top:5px;font:12px sans-serif;color:#fff;background:#6744d9;border-radius:4px;padding:2px 5px;pointer-events:none";
      el.append(label);
      document.documentElement.append(el);
      registry.overlay = el;
    }
    registry.overlay.style.left = `${args.x}px`;
    registry.overlay.style.top = `${args.y}px`;
    return { ok: true };
  }
  if (
    operation === "validate" ||
    operation === "prepare" ||
    operation === "verify"
  ) {
    if (!args.ref) {
      // Wheel events scroll the nearest eligible ancestor. Choose a point outside
      // nested scrollers, or refuse rather than scrolling the wrong container.
      const candidates =
        args.x !== undefined
          ? [[args.x, args.y]]
          : [0.5, 0.95, 0.05, 0.25, 0.75].flatMap((x) =>
              [0.5, 0.2, 0.8].map((y) => [innerWidth * x, innerHeight * y]),
            );
      for (const [x, y] of candidates) {
        let hit = document.elementFromPoint(x, y),
          nested = false;
        if (!hit) continue;
        for (
          let node = hit;
          node && node !== document.body && node !== document.documentElement;
          node = node.parentElement
        ) {
          if (isScrollable(node)) {
            nested = true;
            break;
          }
        }
        if (!nested) return { x, y };
      }
      return fail(
        "scroll_target_required",
        "No unobstructed page scroll point; use a scroll_region ref from a fresh snapshot.",
      );
    }
    const el = get(args.ref);
    if (!el?.isConnected)
      return fail(
        "stale_ref",
        "Original element is gone; references never retarget replacements.",
      );
    if (!visible(el)) return fail("not_visible", "Target is not visible.");
    if (state(el).disabled) return fail("disabled", "Target is disabled.");
    if (
      args.action === "fill" &&
      !(
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLInputElement &&
          [
            "text",
            "search",
            "email",
            "url",
            "tel",
            "password",
            "number",
          ].includes(el.type)) ||
        el.isContentEditable
      )
    )
      return fail(
        "not_editable",
        "Target is not a supported editable text field.",
      );
    if (args.action === "fill" && el.readOnly)
      return fail("not_editable", "Target is read-only.");
    if (args.action === "scroll" && !isScrollable(el))
      return fail(
        "not_scrollable",
        "Use a scroll_region ref for a container scroll.",
      );
    if (operation === "validate") return { ok: true };
    if (operation === "prepare")
      el.scrollIntoView({
        block: "center",
        inline: "center",
        behavior: "instant",
      });
    const r = el.getBoundingClientRect();
    const x =
      Math.max(0, Math.min(innerWidth, r.right)) / 2 + Math.max(0, r.left) / 2;
    const y =
      Math.max(0, Math.min(innerHeight, r.bottom)) / 2 + Math.max(0, r.top) / 2;
    if (x <= 0 || y <= 0 || x >= innerWidth || y >= innerHeight)
      return fail("not_visible", "Target lies outside the viewport.");
    const hit = document.elementFromPoint(x, y);
    if (!(hit === el || el.contains(hit)))
      return fail("obstructed", "Another element covers the target.");
    if (args.action === "scroll") {
      for (let node = hit; node && node !== el; node = node.parentElement) {
        if (isScrollable(node))
          return fail(
            "obstructed",
            "A nested scroll container would receive the wheel event. Use its ref or reposition the outer container.",
          );
      }
    }
    if (
      operation === "verify" &&
      (Math.abs(x - args.x) > 1 || Math.abs(y - args.y) > 1)
    )
      return fail(
        "target_moved",
        "Target moved before dispatch; take a new snapshot.",
      );
    return { x, y };
  }
  if (operation === "check_focus") {
    const el = get(args.ref);
    return { focused: !!el?.isConnected && document.activeElement === el };
  }
  return fail("invalid_operation", "Unsupported page operation.");
}
