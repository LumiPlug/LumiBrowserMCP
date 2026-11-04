import test from "node:test";
import assert from "node:assert/strict";
import { pageOperation } from "../extension/page.js";
let text = "Pay invoice A";
const el = {
  tagName: "BUTTON",
  isConnected: true,
  labels: [],
  get innerText() {
    return text;
  },
  getAttribute() {
    return null;
  },
  getBoundingClientRect() {
    return {
      left: 10,
      top: 20,
      right: 110,
      bottom: 60,
      width: 100,
      height: 40,
    };
  },
  scrollIntoView() {},
  contains(node) {
    return node === this;
  },
};
globalThis.location = {
  origin: "https://example.org",
  href: "https://example.org/",
};
globalThis.document = {
  title: "Test",
  body: { isConnected: true, innerText: "Page" },
  querySelectorAll() {
    return [el];
  },
  getElementById() {
    return null;
  },
  elementFromPoint() {
    return el;
  },
};
globalThis.getComputedStyle = () => ({
  display: "block",
  visibility: "visible",
  opacity: "1",
});
globalThis.innerWidth = 1000;
globalThis.innerHeight = 700;
test("snapshot references expire, retain identity, and detect recycled DOM", () => {
  let first = pageOperation("snapshot").controls[0].ref;
  assert.deepEqual(pageOperation("prepare", { ref: first }), { x: 60, y: 40 });
  let second = pageOperation("snapshot").controls[0].ref;
  assert.notEqual(first, second);
  assert.equal(
    pageOperation("prepare", { ref: first }).error.code,
    "stale_ref",
  );
  text = "Pay invoice B";
  assert.equal(
    pageOperation("prepare", { ref: second }).error.code,
    "stale_ref",
  );
  const third = pageOperation("snapshot").controls[0].ref;
  el.isConnected = false;
  assert.equal(
    pageOperation("prepare", { ref: third }).error.code,
    "stale_ref",
  );
  el.isConnected = true;
});
test("origin check and obstruction reject before coordinates are sent", () => {
  assert.equal(
    pageOperation("snapshot", { expectedOrigin: "https://other.example" }).error
      .code,
    "origin_changed",
  );
  const ref = pageOperation("snapshot").controls[0].ref;
  document.elementFromPoint = () => ({});
  assert.equal(pageOperation("prepare", { ref }).error.code, "obstructed");
});
test("references invalidate on resolved label/name or data identity changes, not input value", () => {
  const attrs = new Map();
  let label = "Original";
  el.getAttribute = (k) => attrs.get(k) ?? null;
  el.getAttributeNames = () => [...attrs.keys()];
  document.getElementById = (id) =>
    id === "label" ? { textContent: label } : null;
  document.elementFromPoint = () => el;
  const snapshot = () => pageOperation("snapshot").controls[0].ref;
  const stale = (ref) =>
    assert.equal(pageOperation("prepare", { ref }).error.code, "stale_ref");
  attrs.set("aria-labelledby", "label");
  let ref = snapshot();
  label = "Different order";
  stale(ref);
  attrs.delete("aria-labelledby");
  el.labels = [{ innerText: "Billing address" }];
  ref = snapshot();
  el.labels[0].innerText = "Recipient address";
  stale(ref);
  el.labels = [];
  for (const attr of [
    "placeholder",
    "title",
    "data-order",
    "data-record-id",
    "orderid",
  ]) {
    attrs.set(attr, "A");
    ref = snapshot();
    attrs.set(attr, "B");
    stale(ref);
  }
  attrs.set("aria-describedby", "label");
  ref = snapshot();
  label = "New description";
  stale(ref);
  ref = snapshot();
  el.value = "New input value";
  assert.deepEqual(pageOperation("prepare", { ref }), { x: 60, y: 40 });
});
test("fill focus must remain on exact editing host, never a nested input", () => {
  const ref = pageOperation("snapshot").controls[0].ref;
  const nested = { tagName: "INPUT" };
  el.contains = (node) => node === nested || node === el;
  document.activeElement = nested;
  assert.equal(pageOperation("check_focus", { ref }).focused, false);
  document.activeElement = el;
  assert.equal(pageOperation("check_focus", { ref }).focused, true);
});
test("outer scroll ref refuses a nearer nested scroll container", () => {
  el.scrollHeight = 400;
  el.clientHeight = 100;
  globalThis.getComputedStyle = (node) => ({
    display: "block",
    visibility: "visible",
    opacity: "1",
    overflowY: "auto",
    overflowX: "visible",
  });
  const nested = { parentElement: el, scrollHeight: 500, clientHeight: 100 };
  el.contains = (node) => node === el || node === nested;
  document.elementFromPoint = () => nested;
  const ref = pageOperation("snapshot").controls[0].ref;
  assert.equal(
    pageOperation("prepare", { ref, action: "scroll" }).error.code,
    "obstructed",
  );
  document.elementFromPoint = () => el;
  assert.deepEqual(pageOperation("prepare", { ref, action: "scroll" }), {
    x: 60,
    y: 40,
  });
});
test("large Chinese snapshots stay below the UTF-8 transport budget with explicit truncation", () => {
  const nodes = Array.from({ length: 500 }, () => ({
    tagName: "INPUT",
    isConnected: true,
    type: "text",
    value: "值".repeat(1000),
    innerText: "",
    labels: [],
    getAttribute: (k) => (k === "aria-label" ? "名".repeat(500) : null),
    getAttributeNames: () => ["aria-label"],
    getBoundingClientRect: () => ({
      left: 10,
      top: 20,
      right: 110,
      bottom: 60,
      width: 100,
      height: 40,
    }),
  }));
  document.querySelectorAll = () => nodes;
  document.body.innerText = "文".repeat(60000);
  const result = pageOperation("snapshot");
  assert.equal(result.truncated, true);
  assert.ok(result.truncationReasons.includes("utf8_response_budget"));
  assert.ok(result.controls.length > 0 && result.controls.length < 500);
  const bytes = new TextEncoder().encode(JSON.stringify(result)).length;
  assert.ok(bytes < 700 * 1024, `Encoded snapshot is ${bytes} bytes`);
});

test("fresh session tokens invalidate old refs even when the document remains identical", () => {
  const first = pageOperation("snapshot", { sessionToken: "session-one" });
  const oldRef = first.controls[0].ref;
  const second = pageOperation("snapshot", { sessionToken: "session-two" });
  assert.notEqual(second.controls[0].ref, oldRef);
  assert.equal(
    pageOperation("read_text", { sessionToken: "session-two", ref: oldRef })
      .error.code,
    "stale_ref",
  );
  assert.equal(
    pageOperation("snapshot", {
      expectedOrigin: location.origin,
      expectedUrl: location.href + "blocked",
    }).error.code,
    "navigation_changed",
  );
});

test("a delegated menu label gets its own guarded click reference", (t) => {
  const label = {
    ...el,
    tagName: "SPAN",
    contains(node) {
      return node === this;
    },
    labels: [],
    getAttribute: () => null,
    getAttributeNames: () => [],
    innerText: "文章",
    textContent: "文章",
    childNodes: [{ nodeType: 3, textContent: "文章" }],
    closest: (selector) => (selector.includes("dropdown") ? label : null),
  };
  t.mock.method(document, "querySelectorAll", (selector) =>
    selector === "*" ? [label] : [],
  );
  t.mock.method(document, "elementFromPoint", () => label);
  const { controls } = pageOperation("snapshot");
  assert.deepEqual(
    controls.map(({ name }) => name),
    ["文章"],
  );
  const ref = controls[0].ref;
  assert.deepEqual(pageOperation("prepare", { ref, action: "click" }), {
    x: 60,
    y: 40,
  });
  document.elementFromPoint = () => el;
  assert.equal(
    pageOperation("prepare", { ref, action: "click" }).error.code,
    "obstructed",
  );
  label.innerText = "视频";
  assert.equal(
    pageOperation("prepare", { ref, action: "click" }).error.code,
    "stale_ref",
  );
});

test("native select exposes options and rejects disabled values before changing state", (t) => {
  const events = [];
  const select = {
    ...el,
    tagName: "SELECT",
    innerText: "Choice",
    multiple: false,
    options: [
      { value: "a", label: "A", selected: true },
      { value: "b", label: "B", selected: false },
      { value: "c", label: "C", disabled: true, selected: false },
    ],
    get selectedOptions() {
      return this.options.filter((o) => o.selected);
    },
    dispatchEvent(e) {
      events.push(e.type);
    },
    getAttribute: () => null,
    contains(node) {
      return node === this;
    },
  };
  t.mock.method(document, "querySelectorAll", () => [select]);
  t.mock.method(document, "elementFromPoint", () => select);
  const control = pageOperation("snapshot").controls[0];
  assert.equal(control.state.options.length, 3);
  assert.equal(
    pageOperation("validate", {
      ref: control.ref,
      action: "select_option",
      values: ["c"],
    }).error.code,
    "invalid_option",
  );
  assert.deepEqual(events, []);
  assert.deepEqual(
    pageOperation("select_option", { ref: control.ref, values: ["b"] }),
    { dispatched: true, values: ["b"] },
  );
  assert.deepEqual(events, ["input", "change"]);
  assert.equal(
    pageOperation("select_option", { ref: control.ref, values: ["b"] })
      .dispatched,
    false,
  );
});

test("checked-state validation rejects unrelated controls and preserves indeterminate ARIA state", (t) => {
  const checkbox = {
    ...el,
    tagName: "DIV",
    innerText: "Choice",
    getAttribute: (k) =>
      k === "role" ? "checkbox" : k === "aria-checked" ? "mixed" : null,
    contains(node) {
      return node === this;
    },
  };
  t.mock.method(document, "querySelectorAll", () => [checkbox]);
  t.mock.method(document, "elementFromPoint", () => checkbox);
  const ref = pageOperation("snapshot").controls[0].ref;
  assert.equal(pageOperation("checked_state", { ref }).checked, null);
  assert.deepEqual(
    pageOperation("validate", { ref, action: "set_checked", checked: false }),
    { ok: true },
  );
  checkbox.getAttribute = () => null;
  const other = pageOperation("snapshot").controls[0].ref;
  assert.equal(
    pageOperation("validate", {
      ref: other,
      action: "set_checked",
      checked: true,
    }).error.code,
    "not_checkable",
  );
});

test("open shadow controls are discovered and keyboard focus follows the shadow active element", (t) => {
  const input = {
    ...el,
    tagName: "INPUT",
    type: "text",
    innerText: "",
    value: "fixture",
    getAttribute: (k) => (k === "aria-label" ? "Shadow input" : null),
    contains(n) {
      return n === this;
    },
  };
  const root = {
    querySelectorAll: () => [input],
    elementFromPoint: () => input,
    activeElement: input,
  };
  const host = { ...el, tagName: "DIV", shadowRoot: root };
  t.mock.method(document, "querySelectorAll", (selector) =>
    selector === "*" ? [host] : [],
  );
  t.mock.method(document, "elementFromPoint", () => host);
  document.activeElement = host;
  const ref = pageOperation("snapshot").controls[0].ref;
  assert.deepEqual(pageOperation("check_focus", { ref }), { focused: true });
  assert.deepEqual(pageOperation("prepare", { ref, action: "click" }), {
    x: 60,
    y: 40,
  });
});
