import {
  createPairingHello,
  commitPairingHello,
  verifyPairingCommitment,
  finishPairing,
  createNonce,
  verifyServerProof,
  createClientProof,
  createSecureChannel,
} from "./security.mjs";

export const CORE_URL = "ws://127.0.0.1:43127/ws";
const CREDENTIAL_KEY = "lumiCorePairing";
let credentialPersistence = Promise.resolve();
export async function resetCorePairing(storage) {
  await storage.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  await credentialPersistence.catch(() => {});
  await storage.remove(CREDENTIAL_KEY);
}
const MAX_FRAME = 1024 * 1024;
const event = () => {
  const listeners = [];
  return {
    addListener(fn) {
      listeners.push(fn);
    },
    fire(value) {
      for (const fn of listeners) fn(value);
    },
  };
};
// One fixed loopback socket, no process launch and no bearer token in URLs/logs.
// All application data, including ready/policy, is authenticated and encrypted.
export function createCorePort({ storage }) {
  const socket = new WebSocket(CORE_URL);
  let closed = false,
    state = "opening",
    credential,
    pairing,
    channel,
    clientNonce;
  let incoming = Promise.resolve(),
    incomingCount = 0,
    incomingBytes = 0,
    draining = false,
    credentialWrite = Promise.resolve();
  const outgoing = [];
  const port = {
    onMessage: event(),
    onDisconnect: event(),
    error: "Lumi 连接已断开。",
    postMessage(value) {
      if (closed || state !== "secure")
        throw new Error("Lumi 尚未完成安全连接。");
      // Coalesce unsent session snapshots; never coalesce action responses.
      const last = outgoing.at(-1);
      if (value?.type === "sessions" && last?.type === "sessions")
        outgoing[outgoing.length - 1] = value;
      else outgoing.push(value);
      if (outgoing.length > 64) {
        close("Lumi 发送队列已满，连接已停止。");
        return;
      }
      void drain();
    },
    async resetPairing() {
      close("正在重新配对；还需在 Lumi 中确认重新配对。");
      await credentialWrite.catch(() => {});
      await resetCorePairing(storage);
    },
    disconnect() {
      close("Lumi 连接已关闭。");
    },
  };
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (!closed && outgoing.length) {
        const value = outgoing.shift();
        send({ type: "secure", ...(await channel.seal(value)) });
      }
    } catch {
      close("Lumi 安全连接已中断。");
    } finally {
      draining = false;
    }
  }
  function close(message) {
    if (closed) return;
    closed = true;
    state = "closed";
    port.error = message;
    channel?.close();
    outgoing.length = 0;
    port.onDisconnect.fire();
    socket.close();
  }
  function send(value) {
    if (closed || socket.readyState !== WebSocket.OPEN)
      throw new Error("Socket closed");
    const data = JSON.stringify(value);
    if (
      new TextEncoder().encode(data).length > MAX_FRAME ||
      socket.bufferedAmount > 2 * MAX_FRAME
    )
      throw new Error("Frame budget exceeded");
    socket.send(data);
  }
  async function authenticate() {
    clientNonce = createNonce();
    state = "auth";
    send({ type: "auth_hello", clientNonce });
  }
  async function receive(message) {
    if (closed) return;
    if (!message || typeof message !== "object" || Array.isArray(message))
      throw new Error("Invalid frame");
    if (message.type === "auth_error") {
      close(
        message.code === "pairing_required"
          ? "请升级 Lumi 和 Lumi Browser 后重试本机连接。"
          : "Lumi 暂未接受连接，请检查连接设置。",
      );
      return;
    }
    if (state === "commit" && message.type === "enroll_commit") {
      if (!/^[A-Za-z0-9_-]{43}$/.test(message.commitment || ""))
        throw new Error("Invalid pairing commitment");
      pairing.serverCommitment = message.commitment;
      state = "offer";
      send({ type: "enroll_hello", hello: pairing.hello });
      return;
    }
    if (state === "offer" && message.type === "enroll_offer") {
      if (
        !(await verifyPairingCommitment(
          message.hello,
          "server",
          pairing.serverCommitment,
        ))
      )
        throw new Error("Pairing commitment mismatch");
      const derived = await finishPairing(pairing.state, message.hello);
      if (closed) return;
      if (
        derived.pairingId !== message.enrollmentId ||
        !Number.isSafeInteger(message.expiresAt) ||
        message.expiresAt <= Date.now() ||
        message.expiresAt > Date.now() + 5 * 60000
      )
        throw new Error("Invalid pairing offer");
      pairing = {
        id: derived.pairingId,
        secret: derived.sharedSecret,
        expiresAt: message.expiresAt,
        accepted: true,
      };
      state = "pairing";
      // Trust on first use: this proves key continuity, not the identity of
      // the first local peer. Core restricts enrollment to its explicit window.
      send({ type: "enroll_accept", enrollmentId: pairing.id });
      return;
    }
    if (state === "pairing" && message.type === "enroll_complete") {
      if (
        !pairing.accepted ||
        pairing.id !== message.enrollmentId ||
        Date.now() >= pairing.expiresAt
      )
        throw new Error("Unaccepted pairing");
      credential = { secret: pairing.secret, pairingId: pairing.id };
      if (closed) return;
      await authenticate();
      return;
    }
    if (state === "auth" && message.type === "auth_challenge") {
      if (
        !(await verifyServerProof(
          credential.secret,
          clientNonce,
          message.serverNonce,
          message.proof,
        ))
      ) {
        close("本机临时连接校验失败，将重新连接。");
        return;
      }
      if (closed) return;
      channel = await createSecureChannel(
        credential.secret,
        clientNonce,
        message.serverNonce,
        "client",
      );
      const proof = await createClientProof(
        credential.secret,
        clientNonce,
        message.serverNonce,
      );
      if (closed) return;
      state = "secure";
      send({ type: "auth_proof", proof });
      return;
    }
    if (state === "secure" && message.type === "secure") {
      const value = await channel.open({
        seq: message.seq,
        data: message.data,
      });
      if (closed) return;
      if (value?.type === "ping") {
        port.postMessage({ type: "pong" });
        return;
      }
      port.onMessage.fire(value);
      return;
    }
    throw new Error("Unexpected protocol state");
  }
  socket.addEventListener("open", () => {
    incoming = incoming
      .then(async () => {
        await storage.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
        // Old persisted pins no longer participate in connection establishment.
        await resetCorePairing(storage);
        if (closed) return;
        const hello = await createPairingHello("client");
        if (closed) return;
        pairing = { state: hello.state, hello: hello.hello };
        const commitment = await commitPairingHello(hello.hello, "client");
        if (closed) return;
        state = "commit";
        send({ type: "enroll_commit", commitment });
      })
      .catch(() => close("无法建立受保护的 Lumi 连接。"));
  });
  socket.addEventListener("message", (event) => {
    if (closed) return;
    const size =
      typeof event.data === "string"
        ? new TextEncoder().encode(event.data).length
        : Infinity;
    if (
      size > (state === "secure" ? MAX_FRAME : 4096) ||
      incomingCount >= 16 ||
      incomingBytes + size > 2 * MAX_FRAME
    ) {
      close("Lumi 消息超出安全限制，连接已停止。");
      return;
    }
    incomingCount++;
    incomingBytes += size;
    incoming = incoming
      .then(async () => {
        await receive(JSON.parse(event.data));
      })
      .catch(() => close("Lumi 连接验证失败，已停止页面操作。"))
      .finally(() => {
        incomingCount--;
        incomingBytes -= size;
      });
  });
  socket.addEventListener("close", () => close("Lumi 未连接。"));
  socket.addEventListener("error", () =>
    close("Lumi 未连接，请检查 Lumi 中的连接设置。"),
  );
  return port;
}
