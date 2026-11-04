// Runs only in the extension's isolated world, in the authorized main frame.
export function pageOperation(operation, args = {}) {
  if (args.expectedOrigin && location.origin !== args.expectedOrigin)
    return {
      error: {
        code: "origin_changed",
        message: "Authorized origin no longer matches.",
      },
    };
  if (
    operation !== "remove_overlay" &&
    args.expectedUrl &&
    location.href !== args.expectedUrl
  )
    return {
      error: {
        code: "navigation_changed",
        message: "Document URL changed before the operation.",
      },
    };
  const key = "__lumi_browser_mcp_v1__";
  let registry = globalThis[key];
  if (
    operation === "remove_overlay" &&
    registry &&
    registry.sessionToken !== args.sessionToken
  )
    return { ok: true };
  if (
    !registry ||
    registry.document !== document ||
    registry.sessionToken !== args.sessionToken
  ) {
    registry?.overlay?.remove();
    registry = globalThis[key] = {
      document,
      sessionToken: args.sessionToken,
      prefix: crypto.randomUUID(),
      generation: 0,
      refs: new Map(),
      overlay: null,
    };
  }
  if (operation === "viewport") {
    if (!registry.viewportTracking) {
      registry.viewportTracking = true;
      registry.viewportRevision = 0;
      const changed = () => {
        registry.viewportRevision++;
      };
      addEventListener("scroll", changed, true);
      addEventListener("resize", changed);
      visualViewport?.addEventListener("resize", changed);
      visualViewport?.addEventListener("scroll", changed);
    }
    return {
      url: location.href,
      documentId: registry.prefix,
      revision: registry.viewportRevision,
      width: innerWidth,
      height: innerHeight,
      scrollX,
      scrollY,
      scale: visualViewport?.scale ?? 1,
      offsetX: visualViewport?.offsetLeft ?? 0,
      offsetY: visualViewport?.offsetTop ?? 0,
      dpr: devicePixelRatio,
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
  const hitAt = (x, y) => {
    let el = document.elementFromPoint(x, y);
    for (let depth = 0; el?.shadowRoot && depth < 20; depth++) {
      const inner = el.shadowRoot.elementFromPoint?.(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  };
  const state = (el) => ({
    inputType: el.tagName === "INPUT" ? el.type : undefined,
    scrollable: isScrollable(el),
    disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true",
    checked: "checked" in el ? !!el.checked : el.getAttribute("aria-checked"),
    expanded: el.getAttribute("aria-expanded"),
    ...(el.tagName === "SELECT"
      ? {
          multiple: !!el.multiple,
          options: [...el.options].slice(0, 100).map((o) => ({
            value: o.value,
            label: o.label,
            selected: o.selected,
            disabled: !!o.disabled || !!o.parentElement?.disabled,
          })),
          optionsTruncated: el.options.length > 100,
        }
      : {}),
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
    const controlSelector =
      'a,button,input,textarea,select,table,[role],[onclick],[tabindex],[contenteditable="true"],summary';
    const interactive = [...document.querySelectorAll(controlSelector)];
    const elements = [...document.querySelectorAll("*")].slice(0, 20000);
    for (let i = 0; i < elements.length && i < 20000; i++) {
      const shadow = elements[i].shadowRoot;
      if (shadow) {
        interactive.push(...shadow.querySelectorAll(controlSelector));
        elements.push(
          ...[...shadow.querySelectorAll("*")].slice(
            0,
            20000 - elements.length,
          ),
        );
      }
    }
    // Delegated menus often attach one listener to a container. Expose the
    // individual text target so the normal hit-test and CDP click can bubble.
    const menuLabels = elements.filter((el) => {
      if (
        !el.childNodes ||
        el.closest(
          "a,button,input,textarea,select,[role=menuitem],[role=button]",
        )
      )
        return false;
      if (
        ![...el.childNodes].some(
          (node) => node.nodeType === 3 && node.textContent.trim(),
        )
      )
        return false;
      const label = el.textContent.trim();
      if (!label || label.length > 120 || /[\r\n]/.test(label)) return false;
      return (
        getComputedStyle(el).cursor === "pointer" ||
        !!el.closest(
          'li,menu,[role=menu],[role=listbox],[class*="dropdown" i],[class*="popover" i],[class*="menu" i]',
        )
      );
    });
    const scrollable = elements.filter((el) => {
      if (
        el.scrollHeight <= el.clientHeight &&
        el.scrollWidth <= el.clientWidth
      )
        return false;
      return isScrollable(el);
    });
    const nodes = [...new Set([...interactive, ...menuLabels, ...scrollable])]
      .filter(
        (el) => visible(el) || (el.tagName === "INPUT" && el.type === "file"),
      )
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
      scope: "document_and_open_shadow_dom",
      unsupported: ["closed_shadow_roots", "canvas_targets"],
      contentTrust: "untrusted_page_data",
    };
    // Budget UTF-8 bytes rather than JS characters (Chinese can use 3 bytes).
    // Keep headroom for final flags and the encrypted transport response envelope.
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
      if (bytes + addition > 400 * 1024 - 512) {
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
        let hit = hitAt(x, y),
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
    if (args.action === "select_option") {
      if (el.tagName !== "SELECT")
        return fail("not_select", "Use a native select ref.");
      if (!el.multiple && new Set(args.values).size !== 1)
        return fail("invalid_argument", "Single select requires one value.");
      for (const value of args.values) {
        const options = [...el.options].filter((o) => o.value === value);
        if (
          !options.length ||
          options.some((o) => o.disabled || o.parentElement?.disabled)
        )
          return fail("invalid_option", "Option missing or disabled.");
      }
    }
    if (args.action === "set_checked") {
      const native =
        el.tagName === "INPUT" && ["checkbox", "radio"].includes(el.type);
      const aria = ["checkbox", "radio", "switch"].includes(
        el.getAttribute("role"),
      );
      if (!native && !aria)
        return fail("not_checkable", "Use a checkbox, radio or switch ref.");
      if (
        (el.type === "radio" || el.getAttribute("role") === "radio") &&
        !args.checked
      )
        return fail(
          "invalid_argument",
          "Select another radio instead of clearing a radio.",
        );
    }
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
    const hit = hitAt(x, y);
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
  if (["focus", "checked_state", "select_option"].includes(operation)) {
    const el = get(args.ref);
    if (!el?.isConnected) return fail("stale_ref", "Target changed.");
    if (!visible(el) || state(el).disabled)
      return fail("disabled", "Target unavailable.");
    if (operation === "checked_state") {
      const checked = state(el).checked;
      return {
        checked:
          checked === true || checked === "true"
            ? true
            : checked === false || checked === "false"
              ? false
              : null,
      };
    }
    if (operation === "focus") {
      el.focus({ preventScroll: true });
      return { ok: true };
    }
    if (el.tagName !== "SELECT")
      return fail("not_select", "Use a native select ref.");
    const verified = pageOperation("verify", {
      ...args,
      action: "select_option",
    });
    if (verified.error) return verified;
    const values = new Set(args.values);
    if (!el.multiple && values.size !== 1)
      return fail("invalid_argument", "Single select requires one value.");
    for (const value of values) {
      const options = [...el.options].filter((o) => o.value === value);
      if (
        !options.length ||
        options.some((o) => o.disabled || o.parentElement?.disabled)
      )
        return fail("invalid_option", "Option missing or disabled.");
    }
    const unchanged = [...el.options].every(
      (o) => o.selected === values.has(o.value),
    );
    if (unchanged) return { dispatched: false, values: [...values] };
    for (const option of el.options) option.selected = values.has(option.value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return {
      dispatched: true,
      values: [...el.selectedOptions].map((o) => o.value),
    };
  }
  if (operation === "document_state")
    return { url: location.href, readyState: document.readyState };
  if (operation === "ref_state") {
    const el = get(args.ref);
    return {
      present: !!el?.isConnected,
      visible: visible(el),
      enabled: !!el?.isConnected && visible(el) && !state(el).disabled,
    };
  }
  if (operation === "capture_bounds") {
    if (!args.ref)
      return {
        x: 0,
        y: 0,
        width: Math.max(document.documentElement.scrollWidth, innerWidth),
        height: Math.max(document.documentElement.scrollHeight, innerHeight),
        dpr: devicePixelRatio,
      };
    const el = get(args.ref);
    if (!el || !visible(el)) return fail("stale_ref", "Element unavailable");
    const r = el.getBoundingClientRect();
    return {
      x: r.x + scrollX,
      y: r.y + scrollY,
      width: r.width,
      height: r.height,
      dpr: devicePixelRatio,
    };
  }
  if (operation === "file_marker") {
    const el = get(args.ref);
    if (
      !el?.isConnected ||
      el.tagName !== "INPUT" ||
      el.type !== "file" ||
      el.disabled
    )
      return fail("not_file_input", "Use a current file input ref");
    if (el.webkitdirectory || (!el.multiple && args.count > 1))
      return fail(
        "invalid_argument",
        "File count or directory input unsupported",
      );
    // Exact current element, in an isolated world; marker is removed after CDP attachment.
    const marker = "lumi-upload-" + crypto.randomUUID();
    el.setAttribute("data-lumi-upload", marker);
    return { marker };
  }
  if (operation === "remove_file_marker") {
    const el = get(args.ref);
    if (el?.getAttribute("data-lumi-upload") === args.marker)
      el.removeAttribute("data-lumi-upload");
    return { ok: true };
  }
  if (operation === "extract_table") {
    const table = get(args.ref);
    if (
      !table?.isConnected ||
      !(
        table.tagName === "TABLE" ||
        ["table", "grid", "treegrid"].includes(table.getAttribute("role"))
      )
    )
      return fail("not_table", "Use a table or ARIA grid ref");
    const rows = [...table.querySelectorAll("tr,[role=row]")].filter(
      (row) =>
        row.closest("table,[role=table],[role=grid],[role=treegrid]") === table,
    );
    const offset = args.offset || 0,
      limit = args.limit || 100;
    const result = rows.slice(offset, offset + limit).map((row) =>
      [
        ...row.querySelectorAll(
          "th,td,[role=cell],[role=gridcell],[role=columnheader],[role=rowheader]",
        ),
      ]
        .filter((cell) => cell.closest("tr,[role=row]") === row)
        .slice(0, 100)
        .map((cell) => ({
          text: (cell.innerText || cell.textContent || "").slice(0, 1000),
          header:
            cell.tagName === "TH" ||
            cell.getAttribute("role") === "columnheader",
          links: [...cell.querySelectorAll("a[href]")]
            .slice(0, 5)
            .flatMap((a) => {
              try {
                const u = new URL(a.href);
                return ["http:", "https:"].includes(u.protocol) &&
                  !u.username &&
                  !u.password
                  ? [
                      {
                        text: a.textContent.slice(0, 200),
                        url: u.href.slice(0, 2048),
                      },
                    ]
                  : [];
              } catch {
                return [];
              }
            }),
        })),
    );
    while (new TextEncoder().encode(JSON.stringify(result)).length > 250000)
      result.pop();
    return {
      rows: result,
      offset,
      totalLoadedRows: rows.length,
      nextOffset:
        offset + result.length < rows.length ? offset + result.length : null,
      scope: "loaded_dom_only",
      contentTrust: "untrusted_page_data",
    };
  }
  if (operation === "frame_perform") {
    const action = args.action;
    if (action === "snapshot" || action === "read_text")
      return pageOperation(action, args);
    if (
      !["click", "hover", "fill", "select_option", "set_checked"].includes(
        action,
      )
    )
      return fail("invalid_argument", "Unsupported frame action");
    const validated = pageOperation("validate", { ...args, action });
    if (validated.error) return validated;
    const point = pageOperation("prepare", { ...args, action });
    if (point.error) return point;
    const el = get(args.ref);
    if (!el) return fail("stale_ref", "Target changed");
    if (action === "select_option")
      return pageOperation("select_option", { ...args, ...point });
    if (action === "click") el.click();
    if (action === "hover") {
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mouseenter"));
    }
    if (action === "set_checked") {
      const current = pageOperation("checked_state", args).checked;
      if (current !== args.checked) el.click();
      if (pageOperation("checked_state", args).checked !== args.checked)
        return fail(
          "outcome_unknown",
          "Checkbox state was not confirmed; inspect before continuing",
        );
    }
    if (action === "fill") {
      el.focus();
      if (el.isContentEditable) el.textContent = args.text;
      else {
        const prototype =
          el.tagName === "TEXTAREA"
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value").set.call(
          el,
          args.text,
        );
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return {
      dispatched: true,
      inputMode: "dom_events",
      note: "DOM events are synthetic; inspect a fresh snapshot.",
    };
  }
  if (operation === "check_focus") {
    const el = get(args.ref);
    let active = document.activeElement;
    for (
      let depth = 0;
      active?.shadowRoot?.activeElement && depth < 20;
      depth++
    )
      active = active.shadowRoot.activeElement;
    return { focused: !!el?.isConnected && active === el };
  }
  return fail("invalid_operation", "Unsupported page operation.");
}
