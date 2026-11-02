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
  for (let n = 0; n < 2000; n++) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
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
test("first pairing derives matching local code and requires explicit matching approval before persistence", async () => {
  const h = harness();
  await until(() => h.socket.sent.some((m) => m.type === "pair_commit"));
  const server = await createPairingHello("server");
  h.socket.fire({
    type: "pair_commit",
    commitment: await commitPairingHello(server.hello, "server"),
  });
  await until(() => h.socket.sent.some((m) => m.type === "pair_hello"));
  const client = h.socket.sent.find((m) => m.type === "pair_hello").hello;
  const derived = await finishPairing(server.state, client);
  h.socket.fire({
    type: "pair_offer",
    hello: server.hello,
    pairingId: derived.pairingId,
    expiresAt: Date.now() + 60000,
  });
  await until(() => h.pairing.some((p) => p?.pairingCode));
  assert.equal(h.pairing.at(-1).pairingCode, derived.sas);
  assert.equal(h.writes.length, 0);
  assert.throws(() => h.port.confirmPairing("old"), /变化/);
  h.port.confirmPairing(derived.pairingId);
  h.socket.fire({ type: "pair_complete", pairingId: derived.pairingId });
  await until(() => h.socket.sent.some((m) => m.type === "auth_hello"));
  assert.equal(
    h.writes.length,
    0,
    "Public pair_complete alone must never persist credentials",
  );
  const channel = await authenticate(h, derived.sharedSecret);
  assert.equal(h.writes[0].lumiCorePairing.secret, derived.sharedSecret);
  const envelope = await channel.seal({ type: "ready" });
  h.socket.fire({ type: "secure", ...envelope });
  await until(() => h.received.length === 1);
  assert.deepEqual(h.received[0], { type: "ready" });
  assert.ok(
    !JSON.stringify(h.socket.sent).includes(derived.sharedSecret),
    "Secret never traverses socket",
  );
  h.port.disconnect();
  channel.close();
});
test("unapproved completion and plaintext ready cannot authorize a connection", async () => {
  const h = harness();
  await until(() => h.socket.sent.length);
  h.socket.fire({ type: "pair_complete", pairingId: "forged" });
  await until(() => h.disconnected());
  assert.equal(h.writes.length, 0);
  assert.equal(h.received.length, 0);
  const other = harness({
    saved: { secret: createNonce(), pairingId: createNonce() },
  });
  await until(() => other.socket.sent.length);
  other.socket.fire({ type: "ready" });
  await until(() => other.disconnected());
  assert.equal(other.received.length, 0);
});
test("reconnect verifies server first, encrypts all application messages and rejects replay", async () => {
  const secret = createNonce(),
    h = harness({ saved: { secret, pairingId: createNonce() } }),
    channel = await authenticate(h, secret);
  h.port.postMessage({ type: "sessions", sessions: [], policyEpoch: 1 });
  await until(() => h.socket.sent.some((m) => m.type === "secure"));
  const wire = h.socket.sent.find((m) => m.type === "secure");
  assert.deepEqual(await channel.open({ seq: wire.seq, data: wire.data }), {
    type: "sessions",
    sessions: [],
    policyEpoch: 1,
  });
  const envelope = await channel.seal({ type: "ready" });
  h.socket.fire({ type: "secure", ...envelope });
  await until(() => h.received.length);
  h.socket.fire({ type: "secure", ...envelope });
  await until(() => h.disconnected());
  assert.equal(h.received.length, 1);
  channel.close();
});
test("wrong server proof and trusted-storage failure stop before any client proof or webpage data", async () => {
  const h = harness({
    saved: { secret: createNonce(), pairingId: createNonce() },
  });
  await until(() => h.socket.sent.length);
  h.socket.fire({
    type: "auth_challenge",
    serverNonce: createNonce(),
    proof: createNonce(),
  });
  await until(() => h.disconnected());
  assert.equal(
    h.socket.sent.some((m) => m.type === "auth_proof"),
    false,
  );
  assert.equal(h.received.length, 0);
  const denied = harness({ storageFailure: true });
  await until(() => denied.disconnected());
  assert.equal(denied.socket.sent.length, 0);
});

test("pre-auth flood and commitment substitution fail closed without credentials", async () => {
  const h = harness();
  await until(() => h.socket.sent.some((m) => m.type === "pair_commit"));
  const server = await createPairingHello("server"),
    other = await createPairingHello("server");
  h.socket.fire({
    type: "pair_commit",
    commitment: await commitPairingHello(server.hello, "server"),
  });
  await until(() => h.socket.sent.some((m) => m.type === "pair_hello"));
  h.socket.fire({
    type: "pair_offer",
    hello: other.hello,
    pairingId: createNonce(),
    expiresAt: Date.now() + 60000,
  });
  await until(() => h.disconnected());
  assert.equal(h.writes.length, 0);
  const flooded = harness();
  flooded.socket.fire({ type: "pair_commit", commitment: "x".repeat(5000) });
  assert.equal(flooded.disconnected(), 1);
  assert.equal(flooded.writes.length, 0);
});

test("explicit reset disconnects and waits for in-flight credential persistence before removing only its key", async () => {
  let release;
  const saveGate = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness({ saveGate });
  await until(() => h.socket.sent.some((m) => m.type === "pair_commit"));
  const server = await createPairingHello("server");
  h.socket.fire({
    type: "pair_commit",
    commitment: await commitPairingHello(server.hello, "server"),
  });
  await until(() => h.socket.sent.some((m) => m.type === "pair_hello"));
  const derived = await finishPairing(
    server.state,
    h.socket.sent.find((m) => m.type === "pair_hello").hello,
  );
  h.socket.fire({
    type: "pair_offer",
    hello: server.hello,
    pairingId: derived.pairingId,
    expiresAt: Date.now() + 60000,
  });
  await until(() => h.pairing.some((p) => p?.pairingCode));
  h.port.confirmPairing(derived.pairingId);
  h.socket.fire({ type: "pair_complete", pairingId: derived.pairingId });
  await until(() => h.socket.sent.some((m) => m.type === "auth_hello"));
  const nonce = createNonce(),
    clientNonce = h.socket.sent.find(
      (m) => m.type === "auth_hello",
    ).clientNonce;
  h.socket.fire({
    type: "auth_challenge",
    serverNonce: nonce,
    proof: await createServerProof(derived.sharedSecret, clientNonce, nonce),
  });
  await until(() => h.writes.length === 1);
  const reset = h.port.resetPairing();
  assert.equal(h.disconnected(), 1);
  assert.equal(h.removed(), 0);
  release();
  await reset;
  assert.equal(h.removed(), 1);
  assert.equal(
    h.socket.sent.some((m) => m.type === "auth_proof"),
    false,
  );
});
