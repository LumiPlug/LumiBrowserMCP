// SPDX-License-Identifier: MPL-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { untilDialog } from "../extension/dialog.mjs";
function setup() {
  const listeners = new Set();
  globalThis.chrome = {
    debugger: {
      onEvent: {
        addListener: (f) => listeners.add(f),
        removeListener: (f) => listeners.delete(f),
      },
    },
  };
  return listeners;
}
test("dialog interrupts blocked input, removes listener, and ignores late completion", async () => {
  const listeners = setup();
  let resolve,
    continued = false;
  const operation = untilDialog(
    { tabId: 1 },
    () => new Promise((r) => (resolve = r)),
  ).then(() => {
    continued = true;
  });
  for (const f of listeners) f({ tabId: 2 }, "Page.javascriptDialogOpening");
  assert.equal(listeners.size, 1);
  for (const f of listeners) f({ tabId: 1 }, "Page.javascriptDialogOpening");
  await assert.rejects(operation, { code: "dialog_opened" });
  resolve({});
  await Promise.resolve();
  assert.equal(continued, false);
  assert.equal(listeners.size, 0);
});
test("pending dialogs reject new dispatch without choosing an answer", async () => {
  setup();
  let sent = false;
  await assert.rejects(
    untilDialog({ dialog: {} }, () => {
      sent = true;
    }),
    { code: "dialog_pending" },
  );
  assert.equal(sent, false);
});
test("normal completion and rejection remove modal listeners", async () => {
  const listeners = setup();
  assert.deepEqual(
    await untilDialog({ tabId: 1 }, async () => ({ ok: true })),
    { ok: true },
  );
  assert.equal(listeners.size, 0);
  await assert.rejects(
    untilDialog({ tabId: 1 }, () => {
      throw Error("failed");
    }),
    /failed/,
  );
  assert.equal(listeners.size, 0);
});
