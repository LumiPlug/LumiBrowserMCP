import assert from "node:assert/strict";
import {
  createPairingHello,
  commitPairingHello,
  verifyPairingCommitment,
  finishPairing,
  createNonce,
  createServerProof,
  verifyClientProof,
  createSecureChannel,
} from "../../extension/security.mjs";

let activeMock;
export async function settleWebSocketMock() {
  await activeMock?.settle();
}

// Browser WebSocket facade for existing synthetic port fixtures. Subscribe to
// their events instead of replacing fire(), preserving fixture normalization.
export function installWebSocketMock(createPort, { secure = true } = {}) {
  const storage = globalThis.chrome?.storage?.local;
  const originalGet = storage?.get;
  const originalAccess = storage?.setAccessLevel;
  if (secure && storage) {
    storage.get = async function (keys) {
      const result = await originalGet.call(this, keys);
      if (
        keys === "lumiCorePairing" ||
        keys == null ||
        (Array.isArray(keys) && keys.includes("lumiCorePairing")) ||
        (typeof keys === "object" && Object.hasOwn(keys, "lumiCorePairing"))
      )
        return {
          ...result,
          lumiCorePairing: {
            secret: "A".repeat(43),
            pairingId: "A".repeat(43),
          },
        };
      return result;
    };
    storage.setAccessLevel ||= async () => {};
    storage.remove ||= async () => {};
  }
  const previous = globalThis.WebSocket;
  const sockets = [];
  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;
    readyState = 0;
    bufferedAmount = 0;
    protocol = "";
    extensions = "";
    binaryType = "blob";
    listeners = new Map();

    incoming = Promise.resolve();
    outgoing = Promise.resolve();
    channel = null;
    generation = 0;
    constructor(url) {
      assert.equal(url, "ws://127.0.0.1:43127/ws");
      this.url = url;
      this.ready = new Promise((resolve) => {
        this.resolveReady = resolve;
      });
      this.port = createPort();
      sockets.push(this);
      this.port.onMessage.addListener((message) => {
        if (this.readyState !== MockWebSocket.OPEN) return;
        if (!secure) {
          this.emit("message", { data: JSON.stringify(message) });
          return;
        }
        this.generation++;
        this.outgoing = this.outgoing
          .then(async () => {
            await this.ready;
            if (this.readyState !== MockWebSocket.OPEN || !this.channel) return;
            this.emit("message", {
              data: JSON.stringify({
                type: "secure",
                ...(await this.channel.seal(message)),
              }),
            });
          })
          .catch((error) => {
            this.error(error);
            this.close();
          });
      });
      this.port.onDisconnect.addListener(() => {
        if (this.readyState === MockWebSocket.CLOSED) return;
        this.readyState = MockWebSocket.CLOSED;
        this.resolveReady();
        this.channel?.close();
        this.emit("close", { code: 1006, reason: "", wasClean: false });
      });
      queueMicrotask(() => this.open());
    }
    addEventListener(type, listener, options) {
      const listeners = this.listeners.get(type) || [];
      listeners.push({ listener, once: !!options?.once });
      this.listeners.set(type, listeners);
    }
    removeEventListener(type, listener) {
      this.listeners.set(
        type,
        (this.listeners.get(type) || []).filter(
          (entry) => entry.listener !== listener,
        ),
      );
    }
    emit(type, fields = {}) {
      const event = { type, target: this, currentTarget: this, ...fields };
      this[`on${type}`]?.call(this, event);
      for (const { listener, once } of [...(this.listeners.get(type) || [])]) {
        if (once) this.removeEventListener(type, listener);
        if (typeof listener === "function") listener.call(this, event);
        else listener.handleEvent(event);
      }
    }
    open() {
      if (this.readyState !== MockWebSocket.CONNECTING) return;
      this.readyState = MockWebSocket.OPEN;
      this.emit("open");
      if (!secure) this.resolveReady();
    }
    message(message) {
      this.port.onMessage.fire(message);
    }
    error(error = new Error("Synthetic WebSocket error")) {
      this.emit("error", { error });
    }
    send(data) {
      if (this.readyState !== MockWebSocket.OPEN)
        throw new Error("WebSocket is not open");
      const message = JSON.parse(data);
      if (!secure) {
        this.port.postMessage(message);
        return;
      }
      this.generation++;
      this.incoming = this.incoming
        .then(async () => {
          if (this.readyState !== MockWebSocket.OPEN) return;
          if (message.type === "enroll_commit") {
            this.pairing = await createPairingHello("server");
            this.commitment = message.commitment;
            this.emit("message", {
              data: JSON.stringify({
                type: "enroll_commit",
                commitment: await commitPairingHello(
                  this.pairing.hello,
                  "server",
                ),
              }),
            });
          } else if (message.type === "enroll_hello") {
            assert.ok(
              await verifyPairingCommitment(
                message.hello,
                "client",
                this.commitment,
              ),
            );
            const derived = await finishPairing(
              this.pairing.state,
              message.hello,
            );
            this.secret = derived.sharedSecret;
            this.enrollmentId = derived.pairingId;
            this.emit("message", {
              data: JSON.stringify({
                type: "enroll_offer",
                hello: this.pairing.hello,
                enrollmentId: derived.pairingId,
                expiresAt: Date.now() + 5000,
              }),
            });
          } else if (message.type === "enroll_accept") {
            assert.equal(message.enrollmentId, this.enrollmentId);
            this.emit("message", {
              data: JSON.stringify({
                type: "enroll_complete",
                enrollmentId: this.enrollmentId,
              }),
            });
          } else if (message.type === "auth_hello") {
            this.clientNonce = message.clientNonce;
            this.serverNonce = createNonce();
            const proof = await createServerProof(
              this.secret,
              this.clientNonce,
              this.serverNonce,
            );
            this.emit("message", {
              data: JSON.stringify({
                type: "auth_challenge",
                serverNonce: this.serverNonce,
                proof,
              }),
            });
          } else if (message.type === "auth_proof") {
            assert.equal(
              await verifyClientProof(
                this.secret,
                this.clientNonce,
                this.serverNonce,
                message.proof,
              ),
              true,
            );
            this.channel = await createSecureChannel(
              this.secret,
              this.clientNonce,
              this.serverNonce,
              "server",
            );
            this.resolveReady();
          } else if (message.type === "secure") {
            assert.ok(this.channel, "Application data requires authentication");
            const value = await this.channel.open({
              seq: message.seq,
              data: message.data,
            });
            this.port.postMessage(value);
          } else
            throw new Error(`Unexpected mock auth message: ${message.type}`);
        })
        .catch((error) => {
          this.error(error);
          this.close();
        });
    }
    async settle() {
      await this.ready;
      let quiet = 0;
      while (quiet < 3) {
        const generation = this.generation;
        await Promise.all([this.incoming, this.outgoing]);
        // Client WebCrypto work runs outside this facade; yield for its response.
        await new Promise((resolve) => setTimeout(resolve, 5));
        quiet = generation === this.generation ? quiet + 1 : 0;
      }
    }
    close() {
      if (
        this.readyState === MockWebSocket.CLOSED ||
        this.readyState === MockWebSocket.CLOSING
      )
        return;
      this.readyState = MockWebSocket.CLOSING;
      if (this.port.disconnect) this.port.disconnect();
      else this.port.onDisconnect.fire();
    }
  }
  globalThis.WebSocket = MockWebSocket;
  activeMock = {
    WebSocket: MockWebSocket,
    sockets,
    async settle() {
      await Promise.all(sockets.map((socket) => socket.settle()));
    },
    get ready() {
      return Promise.all(sockets.map((socket) => socket.ready));
    },
    restore() {
      if (secure && storage) {
        storage.get = originalGet;
        storage.setAccessLevel = originalAccess;
      }
      if (globalThis.WebSocket === MockWebSocket)
        globalThis.WebSocket = previous;
    },
  };
  return activeMock;
}
