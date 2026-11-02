import test from "node:test";
import assert from "node:assert/strict";
import {
  originOf,
  normalizePolicyUrl,
  enqueue,
  invalidate,
  assertLive,
  validateNativeRequest,
} from "../extension/core.mjs";
const session = () => ({ state: "active", epoch: 0, queue: Promise.resolve() });
test("only exact HTTP(S) origins are accepted", () => {
  assert.equal(originOf("https://example.org/a?b=1"), "https://example.org");
  assert.notEqual(
    originOf("https://example.org:8443"),
    originOf("https://example.org"),
  );
  for (const url of [
    "chrome://settings",
    "file:///tmp/x",
    "javascript:alert(1)",
    "about:blank",
  ])
    assert.throws(() => originOf(url), /Only HTTP/);
});
test("actions are serialized, including after earlier rejection", async () => {
  const s = session(),
    events = [];
  const a = enqueue(s, async () => {
    events.push(1);
    await new Promise((r) => setTimeout(r, 10));
    events.push(2);
    throw new Error("expected");
  });
  const b = enqueue(s, async () => events.push(3));
  await assert.rejects(a);
  await b;
  assert.deepEqual(events, [1, 2, 3]);
});
test("pause and immediate resume still cancel all previously queued actions", async () => {
  const s = session();
  let release;
  const blocked = new Promise((r) => (release = r));
  let executed = false;
  const first = enqueue(s, async (epoch) => {
    await blocked;
    assertLive(s, epoch);
  });
  await Promise.resolve();
  const second = enqueue(s, async () => {
    executed = true;
  });
  invalidate(s, "paused");
  invalidate(s, "active");
  release();
  await assert.rejects(first, { code: "cancelled" });
  await assert.rejects(second, { code: "cancelled" });
  assert.equal(executed, false);
  await enqueue(s, async () => {
    executed = true;
  });
  assert.equal(executed, true);
});
test("revocation rejects future work", async () => {
  const s = session();
  invalidate(s, "taken_over");
  await assert.rejects(
    enqueue(s, async () => true),
    { code: "cancelled" },
  );
});

test("native tool validation bounds names, values and encoded payload size", () => {
  assert.throws(() => validateNativeRequest({ tool: "x".repeat(33) }), {
    code: "unknown_tool",
  });
  assert.throws(
    () =>
      validateNativeRequest({
        tool: "fill",
        args: { sessionId: "s", ref: "r", text: "x".repeat(100001) },
      }),
    { code: "invalid_argument" },
  );
  assert.throws(
    () =>
      validateNativeRequest({
        tool: "fill",
        args: { sessionId: "s", ref: "r", text: "\ud800".repeat(100000) },
      }),
    { code: "invalid_argument" },
  );
  assert.throws(
    () =>
      validateNativeRequest({
        tool: "click",
        args: { sessionId: "s", ref: "r".repeat(257) },
      }),
    { code: "invalid_argument" },
  );
  assert.deepEqual(
    validateNativeRequest({ tool: "list_sessions", args: {} }),
    {},
  );
});

test("policy URL normalization ignores query/hash, preserves trailing slash, and rejects credentials", () => {
  assert.equal(
    normalizePolicyUrl("https://EXAMPLE.test:443/orders?token=synthetic#row"),
    "https://example.test/orders",
  );
  assert.notEqual(
    normalizePolicyUrl("https://example.test/orders"),
    normalizePolicyUrl("https://example.test/orders/"),
  );
  for (const url of [
    "https://user:password@example.test/orders",
    "file:///tmp/test",
    "chrome://settings",
    "javascript:alert(1)",
  ])
    assert.throws(() => normalizePolicyUrl(url));
});
