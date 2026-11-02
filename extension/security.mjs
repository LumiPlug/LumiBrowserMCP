// SPDX-License-Identifier: MPL-2.0
// Generated from Lumi packages/core/src/browser/secure-crypto.ts; keep protocol vectors in sync.
const DOMAIN = "LumiBrowser/secure-channel/v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_PLAINTEXT_BYTES = 512 * 1024;
const bytes = (value) => encoder.encode(value);
function cryptoApi() {
  if (!globalThis.crypto?.subtle) throw new Error("WebCrypto unavailable");
  return globalThis.crypto;
}
function encode(value) {
  let binary = "";
  for (let i = 0; i < value.length; i += 8192) binary += String.fromCharCode(...value.subarray(i, i + 8192));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decode(value, length, maximum = length) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > Math.ceil(maximum * 4 / 3)) throw new Error("Invalid encoding");
  let result;
  try {
    result = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
  } catch {
    throw new Error("Invalid encoding");
  }
  if (result.length < length || result.length > maximum || encode(result) !== value) throw new Error("Invalid encoding");
  return result;
}
function roleCheck(role) {
  if (role !== "client" && role !== "server") throw new Error("Invalid role");
}
function helloCheck(hello) {
  if (!hello || typeof hello !== "object" || Array.isArray(hello) || Object.keys(hello).sort().join(",") !== "nonce,publicKey") throw new Error("Invalid pairing hello");
  const candidate = hello;
  decode(candidate.nonce, 32);
  const key = decode(candidate.publicKey, 65);
  if (key[0] !== 4) throw new Error("Invalid public key");
  return { publicKey: candidate.publicKey, nonce: candidate.nonce };
}
async function digest(data) {
  return new Uint8Array(await cryptoApi().subtle.digest("SHA-256", data));
}
async function hkdf(secret, salt, info, length = 32) {
  const key = await cryptoApi().subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await cryptoApi().subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: bytes(`${DOMAIN}/${info}`) }, key, length * 8));
}
function createNonce() {
  return encode(cryptoApi().getRandomValues(new Uint8Array(32)));
}
async function createPairingHello(role) {
  roleCheck(role);
  const pair = await cryptoApi().subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const hello = { publicKey: encode(new Uint8Array(await cryptoApi().subtle.exportKey("raw", pair.publicKey))), nonce: createNonce() };
  return { hello: { ...hello }, state: { role, hello, privateKey: pair.privateKey, used: false } };
}
async function commitPairingHello(hello, role) {
  roleCheck(role);
  return encode(await digest(bytes(JSON.stringify([DOMAIN, "pairing-commitment", role, helloCheck(hello)]))));
}
async function verifyPairingCommitment(hello, role, commitment) {
  try {
    decode(commitment, 32);
    return await commitPairingHello(hello, role) === commitment;
  } catch {
    return false;
  }
}
async function finishPairing(state, peerHello) {
  if (!state || state.used || !state.privateKey) throw new Error("Pairing state expired");
  state.used = true;
  roleCheck(state.role);
  const local = helloCheck(state.hello), peer = helloCheck(peerHello);
  if (local.nonce === peer.nonce || local.publicKey === peer.publicKey) throw new Error("Reflected pairing");
  const client = state.role === "client" ? local : peer;
  const server = state.role === "server" ? local : peer;
  const transcript = await digest(bytes(JSON.stringify([DOMAIN, "pairing", client, server])));
  const publicKey = await cryptoApi().subtle.importKey("raw", decode(peer.publicKey, 65), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const agreement = new Uint8Array(await cryptoApi().subtle.deriveBits({ name: "ECDH", public: publicKey }, state.privateKey, 256));
  state.privateKey = null;
  try {
    const secret = await hkdf(agreement, transcript, "pairing/credential");
    const sasBytes = await hkdf(agreement, transcript, "pairing/sas", 4);
    const sas = String(new DataView(sasBytes.buffer).getUint32(0) % 1e6).padStart(6, "0");
    return { sharedSecret: encode(secret), sas, pairingId: encode(transcript) };
  } finally {
    agreement.fill(0);
  }
}
async function authContext(clientNonce, serverNonce) {
  decode(clientNonce, 32);
  decode(serverNonce, 32);
  if (clientNonce === serverNonce) throw new Error("Reflected nonce");
  return digest(bytes(JSON.stringify([DOMAIN, "session", clientNonce, serverNonce])));
}
async function proofKey(secret, context) {
  const key = await hkdf(decode(secret, 32), context, "authentication");
  return cryptoApi().subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function makeProof(secret, c, s, role) {
  const context = await authContext(c, s);
  return encode(new Uint8Array(await cryptoApi().subtle.sign("HMAC", await proofKey(secret, context), bytes(`${DOMAIN}/proof/${role}/${encode(context)}`))));
}
async function verifyProof(secret, c, s, proof, role) {
  try {
    const signature = decode(proof, 32), context = await authContext(c, s);
    return await cryptoApi().subtle.verify("HMAC", await proofKey(secret, context), signature, bytes(`${DOMAIN}/proof/${role}/${encode(context)}`));
  } catch {
    return false;
  }
}
const createServerProof = (secret, c, s) => makeProof(secret, c, s, "server");
const createClientProof = (secret, c, s) => makeProof(secret, c, s, "client");
const verifyServerProof = (secret, c, s, proof) => verifyProof(secret, c, s, proof, "server");
const verifyClientProof = (secret, c, s, proof) => verifyProof(secret, c, s, proof, "client");
async function createSecureChannel(secret, clientNonce, serverNonce, role) {
  roleCheck(role);
  const context = await authContext(clientNonce, serverNonce);
  const session = encode(context);
  async function directional(direction) {
    const material = await hkdf(decode(secret, 32), context, `traffic/${direction}`);
    return cryptoApi().subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  const sendDirection = role === "client" ? "client-to-server" : "server-to-client";
  const receiveDirection = role === "client" ? "server-to-client" : "client-to-server";
  const sendKey = await directional(sendDirection), receiveKey = await directional(receiveDirection);
  let sendSeq = 0, receiveSeq = 0, closed = false;
  let sendQueue = Promise.resolve(), receiveQueue = Promise.resolve();
  function parameters(direction, seq) {
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setBigUint64(4, BigInt(seq));
    return { name: "AES-GCM", iv, additionalData: bytes(JSON.stringify([DOMAIN, session, direction, seq])), tagLength: 128 };
  }
  function enqueue(direction, task) {
    const queue = direction === "send" ? sendQueue : receiveQueue;
    const next = queue.then(async () => {
      if (closed) throw new Error("Secure channel closed");
      try {
        return await task();
      } catch (error) {
        closed = true;
        throw error;
      }
    });
    if (direction === "send") sendQueue = next.catch(() => {
    });
    else receiveQueue = next.catch(() => {
    });
    return next;
  }
  return {
    close() {
      closed = true;
    },
    seal(value) {
      return enqueue("send", async () => {
        if (!Number.isSafeInteger(sendSeq) || sendSeq >= Number.MAX_SAFE_INTEGER) throw new Error("Sequence exhausted");
        const text = JSON.stringify(value);
        if (typeof text !== "string") throw new Error("Invalid message");
        const plaintext = bytes(text);
        if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new Error("Message too large");
        const seq = sendSeq++;
        const encrypted = await cryptoApi().subtle.encrypt(parameters(sendDirection, seq), sendKey, plaintext);
        if (closed) throw new Error("Secure channel closed");
        return { seq, data: encode(new Uint8Array(encrypted)) };
      });
    },
    open(envelope) {
      return enqueue("receive", async () => {
        if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || Object.keys(envelope).sort().join(",") !== "data,seq" || !Number.isSafeInteger(envelope.seq) || envelope.seq !== receiveSeq || receiveSeq >= Number.MAX_SAFE_INTEGER) throw new Error("Invalid sequence");
        const ciphertext = decode(envelope.data, 16, MAX_PLAINTEXT_BYTES + 16);
        const plaintext = await cryptoApi().subtle.decrypt(parameters(receiveDirection, receiveSeq), receiveKey, ciphertext);
        if (closed) throw new Error("Secure channel closed");
        const value = JSON.parse(decoder.decode(plaintext));
        receiveSeq++;
        return value;
      });
    }
  };
}
export {
  MAX_PLAINTEXT_BYTES,
  commitPairingHello,
  createClientProof,
  createNonce,
  createPairingHello,
  createSecureChannel,
  createServerProof,
  finishPairing,
  verifyClientProof,
  verifyPairingCommitment,
  verifyServerProof
};
