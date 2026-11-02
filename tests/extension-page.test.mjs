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
