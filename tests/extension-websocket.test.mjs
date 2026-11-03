import test from "node:test";
import assert from "node:assert/strict";
import { createCorePort, CORE_URL } from "../extension/transport.mjs";
import {
  createNonce,
  commitPairingHello,
  createPairingHello,
  finishPairing,
  createServerProof,
  verifyClientProof,
  createSecureChannel,
} from "../extension/security.mjs";
async function until(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw Error("Synthetic handshake did not settle");
}
function harness({ saved, storageFailure = false, saveGate } = {}) {
  let socket;
  const writes = [],
    received = [],
    pairing = [];
  let disconnected = 0,
    removed = 0;
  globalThis.WebSocket = class {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    listeners = {};
    sent = [];
    constructor(url) {
      assert.equal(url, CORE_URL);
      socket = this;
    }
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    }
    send(text) {
      this.sent.push(JSON.parse(text));
    }
    close() {
      this.readyState = 3;
    }
    fire(value) {
      this.listeners.message({ data: JSON.stringify(value) });
    }
  };
  const port = createCorePort({
    storage: {
      async setAccessLevel(options) {
        assert.equal(options.accessLevel, "TRUSTED_CONTEXTS");
        if (storageFailure) throw Error("denied");
      },
      async get() {
        return saved ? { lumiCorePairing: saved } : {};
      },
      async set(value) {
        writes.push(value);
        await saveGate;
      },
      async remove(key) {
        assert.equal(key, "lumiCorePairing");
        removed++;
      },
    },
    onPairing: (value) => pairing.push(value),
  });
  port.onMessage.addListener((value) => received.push(value));
  port.onDisconnect.addListener(() => disconnected++);
  socket.listeners.open();
  return {
    socket,
    port,
    writes,
    received,
    pairing,
    disconnected: () => disconnected,
    removed: () => removed,
  };
}
async function authenticate(h, secret) {
  await until(() => h.socket.sent.some((m) => m.type === "auth_hello"));
  const hello = h.socket.sent.find((m) => m.type === "auth_hello"),
    serverNonce = createNonce();
  const channel = await createSecureChannel(
    secret,
    hello.clientNonce,
    serverNonce,
    "server",
  );
  h.socket.fire({
    type: "auth_challenge",
    serverNonce,
    proof: await createServerProof(secret, hello.clientNonce, serverNonce),
  });
  await until(() => h.socket.sent.some((m) => m.type === "auth_proof"));
  assert.ok(
    await verifyClientProof(
      secret,
      hello.clientNonce,
      serverNonce,
      h.socket.sent.find((m) => m.type === "auth_proof").proof,
    ),
  );
  return channel;
}
async function negotiate(h) {
  await until(() => h.socket.sent.some((m) => m.type === "enroll_commit"));
  const server = await createPairingHello("server");
  h.socket.fire({
    type: "enroll_commit",
    commitment: await commitPairingHello(server.hello, "server"),
  });
  await until(() => h.socket.sent.some((m) => m.type === "enroll_hello"));
  const derived = await finishPairing(
    server.state,
    h.socket.sent.find((m) => m.type === "enroll_hello").hello,
  );
  h.socket.fire({
    type: "enroll_offer",
    hello: server.hello,
    enrollmentId: derived.pairingId,
    expiresAt: Date.now() + 5000,
  });
  await until(() => h.socket.sent.some((m) => m.type === "enroll_accept"));
  h.socket.fire({ type: "enroll_complete", enrollmentId: derived.pairingId });
  return authenticate(h, derived.sharedSecret);
}
test("connects with fresh ephemeral keys despite stale persisted credentials, without saving replacements", async () => {
  for (const saved of [
    undefined,
    { secret: createNonce(), pairingId: createNonce() },
    { broken: true },
  ]) {
    const h = harness({ saved }),
      channel = await negotiate(h);
    assert.equal(h.writes.length, 0);
    assert.equal(h.removed(), 1);
    const envelope = await channel.seal({ type: "ready" });
    h.socket.fire({ type: "secure", ...envelope });
    await until(() => h.received.length);
    h.port.postMessage({ type: "sessions", sessions: [], policyEpoch: 1 });
    await until(() => h.socket.sent.some((m) => m.type === "secure"));
    const wire = h.socket.sent.find((m) => m.type === "secure");
    assert.deepEqual(await channel.open({ seq: wire.seq, data: wire.data }), {
      type: "sessions",
      sessions: [],
      policyEpoch: 1,
    });
    h.socket.fire({ type: "secure", ...envelope });
    await until(() => h.disconnected());
    assert.equal(h.received.length, 1);
    channel.close();
  }
});
test("plaintext ready and unsolicited completion never grant control", async () => {
  for (const message of [
    { type: "ready" },
    { type: "enroll_complete", enrollmentId: createNonce() },
  ]) {
    const h = harness();
    await until(() => h.socket.sent.length);
    h.socket.fire(message);
    await until(() => h.disconnected());
    assert.equal(h.received.length, 0);
    assert.equal(h.writes.length, 0);
  }
});
test("failure to delete an old credential stops before connection", async () => {
  const h = harness({ storageFailure: true });
  await until(() => h.disconnected());
  assert.equal(h.socket.sent.length, 0);
});
test("a substituted handshake commitment is rejected", async () => {
  const h = harness();
  await until(() => h.socket.sent.length);
  const server = await createPairingHello("server");
  h.socket.fire({ type: "enroll_commit", commitment: createNonce() });
  await until(() => h.socket.sent.some((m) => m.type === "enroll_hello"));
  h.socket.fire({
    type: "enroll_offer",
    hello: server.hello,
    enrollmentId: createNonce(),
    expiresAt: Date.now() + 5000,
  });
  await until(() => h.disconnected());
  assert.equal(
    h.socket.sent.some((m) => m.type === "auth_proof"),
    false,
  );
});
