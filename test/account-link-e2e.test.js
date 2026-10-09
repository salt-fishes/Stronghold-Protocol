// test/account-link-e2e.test.js — end to end: a WebSocket client carrying the gateway's X-SP-User
// binds to its seat, and its finished match is reported to the account service (POST /ingest/result).
// Without SP_ACCOUNT_TOKEN the very same flow must stay silent (upstream behaviour, byte for byte).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';

/** A stand-in for the account service: captures POST /ingest/result. */
function fakeAccountService() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* keep {} */ }
      seen.push({ url: req.url, auth: req.headers.authorization, body });
      res.writeHead(204);
      res.end();
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    seen,
    url: `http://127.0.0.1:${srv.address().port}`,
    close: () => new Promise((r) => srv.close(r)),
  })));
}

/** One full solo stub match, on a socket that carries `headers`. */
async function soloMatch(url, headers) {  const c = await TestClient.connect(url, { wsOptions: { headers } });
  const w = await c.hello('Tester');
  c.id = w.playerId;
  c.token = w.token;
  const created = await c.request({ t: 'room.create', mode: 'solo', difficulty: 'FUNNY' });
  assert.equal(created.t, 'ok');
  const started = await c.request({ t: 'room.start' });
  assert.equal(started.t, 'ok');
  const ready = await c.request({ t: 'g.infoReady' });
  assert.equal(ready.t, 'ok');
  await c.waitFor('m.result');
  await c.terminate();
}

const restore = (key, value) => {
  if (value == null) delete process.env[key]; else process.env[key] = value;
};

test('with SP_ACCOUNT_TOKEN: the accounted seat reports its match once', async (t) => {
  const prevToken = process.env.SP_ACCOUNT_TOKEN;
  const prevUrl = process.env.SP_ACCOUNT_URL;
  const acc = await fakeAccountService();
  process.env.SP_ACCOUNT_TOKEN = 'e2e-token';
  process.env.SP_ACCOUNT_URL = acc.url;
  const srv = await startServer({ port: 0, quiet: true, MatchClass: StubMatch });
  t.after(async () => {
    await srv.close();
    await acc.close();
    restore('SP_ACCOUNT_TOKEN', prevToken);
    restore('SP_ACCOUNT_URL', prevUrl);
  });

  await soloMatch(`ws://127.0.0.1:${srv.port}/ws`, { 'x-sp-user': 'alice' });
  for (let i = 0; i < 60 && !acc.seen.length; i++) await delay(25);
  assert.equal(acc.seen.length, 1, 'exactly one report for the match');
  assert.equal(acc.seen[0].url, '/ingest/result');
  assert.equal(acc.seen[0].auth, 'Bearer e2e-token');
  assert.equal(acc.seen[0].body.account, 'alice');
  assert.equal(acc.seen[0].body.mode, 'solo');
  assert.equal(acc.seen[0].body.difficulty, 'FUNNY');
  assert.equal(acc.seen[0].body.payload.victory, false, 'the stub ends without a victory');
  assert.equal(acc.seen[0].body.payload.reason, 'confirmed');
  assert.ok(['win', 'loss', 'eliminated', 'abort', 'error'].includes(acc.seen[0].body.payload.outcome));
  assert.ok(acc.seen[0].body.matchKey.includes(':'), 'a room/match/seed key');
});

test('without a token: the same match reports nothing', async (t) => {
  const prevToken = process.env.SP_ACCOUNT_TOKEN;
  const prevUrl = process.env.SP_ACCOUNT_URL;
  delete process.env.SP_ACCOUNT_TOKEN;
  delete process.env.SP_ACCOUNT_URL;
  const acc = await fakeAccountService();
  const srv = await startServer({ port: 0, quiet: true, MatchClass: StubMatch });
  t.after(async () => {
    await srv.close();
    await acc.close();
    restore('SP_ACCOUNT_TOKEN', prevToken);
    restore('SP_ACCOUNT_URL', prevUrl);
  });

  await soloMatch(`ws://127.0.0.1:${srv.port}/ws`, { 'x-sp-user': 'alice' });
  await delay(200);
  assert.equal(acc.seen.length, 0, 'the link is off: no report');
});

test('M6: /rooms.json lists live rooms with the bound account (loopback only)', async (t) => {
  const prevToken = process.env.SP_ACCOUNT_TOKEN;
  process.env.SP_ACCOUNT_TOKEN = 'e2e-token'; // enables the X-SP-User binding (accountFromRequest)
  const srv = await startServer({ port: 0, quiet: true, MatchClass: StubMatch });
  t.after(async () => {
    await srv.close();
    restore('SP_ACCOUNT_TOKEN', prevToken);
  });

  const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`, { wsOptions: { headers: { 'x-sp-user': 'alice' } } });
  const w = await c.hello('Alice');
  c.id = w.playerId;
  c.token = w.token;
  await c.request({ t: 'room.create', mode: 'coop', difficulty: 'HARD' });
  await c.waitFor('room.state', (s) => s.hostId === c.id);

  const res = await fetch(`http://127.0.0.1:${srv.port}/rooms.json`);
  assert.equal(res.status, 200);
  const doc = await res.json();
  const room = doc.rooms.find((r) => r.seats.some((s) => s && s.account === 'alice'));
  assert.ok(room, 'the room appears with its gateway-bound account');
  assert.equal(room.mode, 'coop');
  assert.equal(room.difficulty, 'HARD');
  assert.equal(room.humans, 1);
  assert.equal(room.inMatch, false);
  assert.equal(room.seats[0].name, 'Alice');
  await c.terminate();
});
