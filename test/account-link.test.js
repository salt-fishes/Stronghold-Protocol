// server/accountLink.js — the env-gated sp-accounts bridge. Disabled it must be a no-op; enabled it
// reports one POST per accounted human seat, fire-and-forget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountFromRequest, buildReport, reportMatch } from '../server/accountLink.js';

function withEnv(env, fn) {
  const prev = { token: process.env.SP_ACCOUNT_TOKEN, url: process.env.SP_ACCOUNT_URL };
  if (env.token == null) delete process.env.SP_ACCOUNT_TOKEN; else process.env.SP_ACCOUNT_TOKEN = env.token;
  if (env.url == null) delete process.env.SP_ACCOUNT_URL; else process.env.SP_ACCOUNT_URL = env.url;
  try { return fn(); } finally {
    if (prev.token == null) delete process.env.SP_ACCOUNT_TOKEN; else process.env.SP_ACCOUNT_TOKEN = prev.token;
    if (prev.url == null) delete process.env.SP_ACCOUNT_URL; else process.env.SP_ACCOUNT_URL = prev.url;
  }
}

const ROOM = {
  code: 'AB12', matchCount: 3, mode: 'coop', difficulty: 'HARD',
  seats: [
    { seat: 0, isBot: false, account: 'alice', name: 'A' },
    { seat: 1, isBot: false, account: null, name: 'B' },
    { seat: 2, isBot: true, account: 'ai', name: 'AI' },
    null,
  ],
};
const SUMMARY = {
  victory: true, reason: 'victory', roundsPassed: 12, seed: 777, durationMs: 1_320_000,
  hiddenReached: false, hiddenCleared: false, stageId: 's_1', modeId: 'coop_hard',
  players: [{ seat: 0, name: 'A', isBot: false, left: false, alive: true, lp: 10, roundsPassed: 12, stats: { kills: 3 } }],
};

test('disabled: the header and reports are ignored', () => {
  withEnv({ token: null, url: null }, () => {
    assert.equal(accountFromRequest({ headers: { 'x-sp-user': 'alice' } }), null);
    let calls = 0;
    reportMatch(ROOM, SUMMARY, { fetchImpl: () => { calls += 1; } });
    assert.equal(calls, 0);
  });
});

test('enabled: X-SP-User is read, trimmed and clamped', () => {
  withEnv({ token: 'tok' }, () => {
    assert.equal(accountFromRequest({ headers: { 'x-sp-user': '  alice  ' } }), 'alice');
    assert.equal(accountFromRequest({ headers: {} }), null);
    assert.equal(accountFromRequest({}), null);
    assert.equal(accountFromRequest({ headers: { 'x-sp-user': 'x'.repeat(100) } }).length, 64);
  });
});

test('buildReport: the summary maps to the account service contract', () => {
  const report = buildReport(ROOM, SUMMARY, ROOM.seats[0]);
  assert.equal(report.account, 'alice');
  assert.equal(report.matchKey, 'AB12:3:777');
  assert.equal(report.mode, 'coop');
  assert.equal(report.difficulty, 'HARD');
  assert.equal(report.rounds, 12);
  assert.equal(report.payload.outcome, 'win');
  assert.equal(report.payload.durationMs, 1_320_000);
  assert.equal(report.payload.players.length, 1);
  assert.equal(buildReport(ROOM, { ...SUMMARY, victory: false, reason: 'eliminated' }, ROOM.seats[0]).payload.outcome, 'eliminated');
  assert.equal(buildReport(ROOM, { ...SUMMARY, victory: false, reason: 'abandoned' }, ROOM.seats[0]).payload.outcome, 'abort');
  assert.equal(buildReport(ROOM, { ...SUMMARY, victory: false, reason: 'defeat' }, ROOM.seats[0]).payload.outcome, 'loss');
  assert.equal(buildReport(ROOM, { ...SUMMARY, seed: undefined }, ROOM.seats[0]).matchKey, 'AB12:3:0');
});

test('enabled: one POST per accounted human seat, to the configured base with the bearer', () => {
  withEnv({ token: 'secret', url: 'http://acc.test:9/' }, () => {
    const calls = [];
    reportMatch(ROOM, SUMMARY, { fetchImpl: (url, init) => { calls.push({ url, init }); return Promise.resolve({ ok: true }); } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://acc.test:9/ingest/result');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.authorization, 'Bearer secret');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.account, 'alice');
    assert.equal(body.matchKey, 'AB12:3:777');
    assert.equal(body.payload.outcome, 'win');
  });
});

test('a failing account service never throws', async () => {
  withEnv({ token: 'secret' }, () => {
    reportMatch(ROOM, SUMMARY, { fetchImpl: () => Promise.reject(new Error('down')) });
    reportMatch(ROOM, SUMMARY, { fetchImpl: () => { throw new Error('sync boom'); } });
  });
  await new Promise((r) => setImmediate(r));
});
