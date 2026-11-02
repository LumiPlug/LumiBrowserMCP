import test from 'node:test';
import assert from 'node:assert/strict';
import * as security from '../extension/security.mjs';
const secret = Buffer.alloc(32, 7).toString('base64url');
const c = Buffer.alloc(32, 8).toString('base64url');
const s = Buffer.alloc(32, 9).toString('base64url');
async function channels() { return Promise.all(['client', 'server'].map(role => security.createSecureChannel(secret, c, s, role))); }
test('pairing agrees on credential and SAS, with single-use private state', async () => {
  const client = await security.createPairingHello('client');
  const server = await security.createPairingHello('server');
  const left = await security.finishPairing(client.state, server.hello);
  const right = await security.finishPairing(server.state, client.hello);
  assert.deepEqual(left, right);
  assert.match(left.sas, /^\d{6}$/);
  assert.equal(left.sharedSecret.length, 43);
  await assert.rejects(security.finishPairing(client.state, server.hello));
});
test('changed pairing peer yields different SAS context and secret', async () => {
  const a = await security.createPairingHello('client'), b = await security.createPairingHello('server'), impostor = await security.createPairingHello('server');
  const legitimate = await security.finishPairing(b.state, a.hello);
  const altered = await security.finishPairing(a.state, impostor.hello);
  assert.notEqual(altered.pairingId, legitimate.pairingId);
  assert.notEqual(altered.sharedSecret, legitimate.sharedSecret);
});
test('reject malformed and reflected pairing', async () => {
  let a = await security.createPairingHello('client');
  await assert.rejects(security.finishPairing(a.state, a.hello));
  a = await security.createPairingHello('client');
  await assert.rejects(security.finishPairing(a.state, { publicKey: 'invalid', nonce: c }));
});
test('server proof is role, credential and fresh nonce bound', async () => {
  const proof = await security.createServerProof(secret, c, s);
  assert.equal(await security.verifyServerProof(secret, c, s, proof), true);
  assert.equal(await security.verifyClientProof(secret, c, s, proof), false);
  assert.equal(await security.verifyServerProof(c, c, s, proof), false);
  assert.equal(await security.verifyServerProof(secret, s, c, proof), false);
  assert.equal(await security.verifyServerProof(secret, c, s, proof + '='), false);
  assert.equal(await security.verifyServerProof(secret, c, c, proof), false);
});
test('parallel frames serialize and round-trip unicode both directions', async () => {
  const [client, server] = await channels();
  const envelopes = await Promise.all([client.seal({ text: '你好' }), client.seal({ seq: 'two' })]);
  assert.deepEqual(envelopes.map(frame => frame.seq), [0, 1]);
  assert.deepEqual(await Promise.all(envelopes.map(frame => server.open(frame))), [{ text: '你好' }, { seq: 'two' }]);
  assert.deepEqual(await client.open(await server.seal({ response: true })), { response: true });
});
test('reject replay and poison channel', async () => {
  const [client, server] = await channels(), frame = await client.seal({ test: true });
  await server.open(frame);
  await assert.rejects(server.open(frame));
  await assert.rejects(server.open(await client.seal({ validNext: true })));
});
test('reject out-of-order, reflection, ciphertext tampering and other-session frames', async () => {
  for (const mutation of ['order', 'reflection', 'tamper', 'session']) {
    const [client, server] = await channels();
    const frame = await client.seal({ value: 123 });
    if (mutation === 'order') frame.seq = 1;
    if (mutation === 'tamper') frame.data = (frame.data[0] === 'A' ? 'B' : 'A') + frame.data.slice(1);
    const receiver = mutation === 'reflection' ? client : mutation === 'session' ? await security.createSecureChannel(secret, s, c, 'server') : server;
    await assert.rejects(receiver.open(frame));
  }
});
test('reject oversize and unsafe sequences, extra envelope fields', async () => {
  const [client] = await channels();
  await assert.rejects(client.seal('x'.repeat(security.MAX_PLAINTEXT_BYTES)));
  for (const seq of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1]) {
    const [, server] = await channels();
    await assert.rejects(server.open({ seq, data: 'AAAA' }));
  }
  const [sender, receiver] = await channels();
  await assert.rejects(receiver.open({ ...await sender.seal({}), injected: true }));
});
test('close invalidates queued and in-flight work', async () => {
  const [client, server] = await channels();
  const sealing = client.seal({ value: true }); client.close();
  await assert.rejects(sealing);
  server.close(); await assert.rejects(server.open({ seq: 0, data: 'AAAA' }));
});

// Public fixed interoperability vector; these are NOT production credentials.
const vector = {
  "secret": "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc",
  "clientNonce": "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg",
  "serverNonce": "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk",
  "serverProof": "PuJNXw88KIocr5jZOnHfuWvsdXtpiribMsFooI_gDO0",
  "clientProof": "_TuQrhJJrnfo-jmIrvpesQIfpnNECEUqSbikHhRUXkM",
  "plaintext": {
    "text": "Lumi 中文 interoperability",
    "number": 42
  },
  "envelope": {
    "seq": 0,
    "data": "yizW7KLc1uYWIK26HV3XE8YN3gF1nIPLRVy7GyblJlXXndFJ9NtQeZ5kiunXknRJ_JGpdA5ezhp_5A6YIP2akLiLMQ"
  }
};
test('v1 fixed interoperability vector matches both distributed implementations', async () => {
  assert.equal(await security.createServerProof(vector.secret, vector.clientNonce, vector.serverNonce), vector.serverProof);
  assert.equal(await security.createClientProof(vector.secret, vector.clientNonce, vector.serverNonce), vector.clientProof);
  const client = await security.createSecureChannel(vector.secret, vector.clientNonce, vector.serverNonce, 'client');
  const server = await security.createSecureChannel(vector.secret, vector.clientNonce, vector.serverNonce, 'server');
  assert.deepEqual(await client.seal(vector.plaintext), vector.envelope);
  assert.deepEqual(await server.open(vector.envelope), vector.plaintext);
});

test('pairing commitments bind role and exact hello before reveal', async () => {
  const { hello } = await security.createPairingHello('client');
  const commitment = await security.commitPairingHello(hello, 'client');
  assert.equal(await security.verifyPairingCommitment(hello, 'client', commitment), true);
  assert.equal(await security.verifyPairingCommitment(hello, 'server', commitment), false);
  assert.equal(await security.verifyPairingCommitment({ ...hello, nonce: security.createNonce() }, 'client', commitment), false);
  assert.equal(await security.verifyPairingCommitment(hello, 'client', commitment + '='), false);
});
