// test/lobby-spectate.test.js — spectator slots (issue #76 ②③): room.create { spectate } (the host's 允许观战
// toggle, default on), room.join { asObserver } / the full-room and mid-match (中途观战) fallbacks. The observers
// ride the room's broadcasts (room.state, m.public, m.emote, m.result), never hold a seat, are refused every seat
// intent, keep their slot across a drop until the reconnect window expires, and get the result replay. The
// Match-level g.watch routing is test/match/observe.test.js.

import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { StubMatch as Match } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR, OBSERVER_MAX } from '../shared/constants.js';

/** Collects log output; errors are asserted empty unless a test expects them. */
function captureLog() {
  const errors = [];
  return { errors, log: { info() {}, warn() {}, debug() {}, error: (...a) => errors.push(a.map(String).join(' ')) } };
}

const expectOk = async (c, msg) => {
  const r = await c.request(msg);
  assert.equal(r.t, 'ok', `${msg.t}: ${JSON.stringify(r)}`);
  return r;
};
const expectError = async (c, msg, code) => {
  const r = await c.request(msg);
  assert.equal(r.t, 'error', `expected error ${code} for ${msg.t}, got ${JSON.stringify(r)}`);
  assert.equal(r.code, code, `${msg.t}: ${JSON.stringify(r)}`);
  return r;
};
const seatOf = (state, id) => state.seats.find((s) => s && s.playerId === id) || null;

describe('spectator slots', () => {
  let srv;
  let pool;
  const cap = captureLog();

  before(async () => {
    srv = await startServer({ port: 0, host: '127.0.0.1', log: cap.log, MatchClass: Match });
    pool = clientPool(() => `ws://127.0.0.1:${srv.port}/ws`);
  });
  afterEach(async () => { await pool.closeAll(); });
  after(async () => {
    await srv?.close();
    assert.deepEqual(cap.errors, [], 'no server errors logged');
  });

  function clientPool(getUrl) {
    const open = new Set();
    return {
      async connect(opts) {
        const c = await TestClient.connect(getUrl(), opts);
        open.add(c);
        return c;
      },
      async player(name, token) {
        const c = await this.connect();
        const w = await c.hello(name, token);
        c.id = w.playerId;
        c.token = w.token;
        return c;
      },
      async closeAll() {
        for (const c of [...open]) await c.close();
        open.clear();
      },
    };
  }
  async function createRoom(c, mode = 'coop', difficulty = 'NORMAL', extra = {}) {
    const r = await c.request({ t: 'room.create', mode, difficulty, ...extra });
    assert.equal(r.t, 'ok', JSON.stringify(r));
    return c.waitFor('room.state', (s) => s.hostId === c.id && s.mode === mode);
  }
  const observerOf = (state, id) => (Array.isArray(state.observers) ? state.observers.find((o) => o.playerId === id) : null);

  test('full room: the extra friend joins the spectator slots (default on), no seat', async () => {
    const host = await pool.player('H');
    const st = await createRoom(host);
    for (let i = 0; i < 2; i++) {
      const g = await pool.player(`G${i}`);
      await expectOk(g, { t: 'room.join', code: st.code });
    }
    await expectOk(host, { t: 'room.addBot' });
    await host.waitFor('room.state', (s) => s.seats.every(Boolean));

    const late = await pool.player('Late');
    await expectOk(late, { t: 'room.join', code: st.code });
    const state = await late.waitFor('room.state', (s) => !!observerOf(s, late.id));
    assert.equal(seatOf(state, late.id), null, 'the observer holds no seat');
    assert.equal(state.observers.length, 1);
    assert.equal(state.observers[0].name, 'Late');
    assert.equal(state.observers[0].connected, true);
    assert.equal(state.spectate, true);
    await host.waitFor('room.state', (s) => !!observerOf(s, late.id));
  });

  test('explicit asObserver takes a slot even when a seat is free; spectate: false refuses as before', async () => {
    const host = await pool.player('H2');
    const st = await createRoom(host);
    const guest = await pool.player('G');
    await expectOk(guest, { t: 'room.join', code: st.code, asObserver: true });
    const state = await guest.waitFor('room.state', (s) => !!observerOf(s, guest.id));
    assert.equal(seatOf(state, guest.id), null, 'asObserver never takes the free seat');

    const host2 = await pool.player('H3');
    const st2 = await createRoom(host2, 'coop', 'NORMAL', { spectate: false });
    assert.equal(st2.spectate, false);
    const guest2 = await pool.player('G2');
    await expectError(guest2, { t: 'room.join', code: st2.code, asObserver: true }, ERR.ROOM_FULL);
    // spectate: false only closes the spectator slots — the seat path is untouched
    await expectOk(guest2, { t: 'room.join', code: st2.code });
    // the room's observer list stays empty on the host's next visible change
    await expectOk(host2, { t: 'room.ready', ready: true });
    const st2b = await host2.waitFor('room.state', (s) => s.code === st2.code && s.seats.some((x) => x && x.ready));
    assert.equal((st2b.observers || []).length, 0);
  });

  test('observer cap: OBSERVER_MAX slots, a disconnected observer keeps its slot and can resume into it', async () => {
    const host = await pool.player('H4');
    const st = await createRoom(host);
    const observers = [];
    for (let i = 0; i < OBSERVER_MAX; i++) {
      const o = await pool.player(`O${i}`);
      await expectOk(o, { t: 'room.join', code: st.code, asObserver: true });
      await o.waitFor('room.state', (s) => !!observerOf(s, o.id));
      observers.push(o);
    }
    const fifth = await pool.player('O5');
    await expectError(fifth, { t: 'room.join', code: st.code, asObserver: true }, ERR.ROOM_FULL);

    // a drop keeps the slot (the reconnect window holds it); the fresh socket resumes into it
    const first = observers[0];
    const token = first.token;
    await first.terminate();
    await host.waitFor('room.state', (s) => observerOf(s, first.id)?.connected === false);
    await expectError(fifth, { t: 'room.join', code: st.code, asObserver: true }, ERR.ROOM_FULL);
    const back = await pool.connect();
    const w = await back.hello('O0', token);
    back.id = w.playerId;
    back.token = w.token;
    const resumed = await back.waitFor('room.state', (s) => observerOf(s, back.id)?.connected === true);
    assert.equal(seatOf(resumed, back.id), null, 'still no seat after the resume');
    observers[0] = back;
  });

  test('mid-match join (中途观战): room.state + the latest m.public, then every broadcast and the result', async () => {
    const host = await pool.player('H5');
    const st = await createRoom(host, 'coop', 'NORMAL');
    const guest = await pool.player('G5');
    await expectOk(guest, { t: 'room.join', code: st.code });
    await expectOk(guest, { t: 'room.ready', ready: true });
    await expectOk(host, { t: 'room.start' });
    await guest.waitFor('m.public');

    const watcher = await pool.player('W');
    await expectOk(watcher, { t: 'room.join', code: st.code }); // the match is running: straight to the slots
    const joined = await watcher.waitFor('room.state', (s) => !!observerOf(s, watcher.id) && s.inMatch);
    assert.equal(seatOf(joined, watcher.id), null);
    const pub = await watcher.waitFor('m.public'); // the lastPublic frame of the running match
    assert.equal(pub.phase, 'INFO_CHECK');

    // the observer rides every broadcast
    await expectOk(guest, { t: 'g.emote', id: 'autochess_battle_happy' });
    const emote = await watcher.waitFor('m.emote');
    assert.equal(emote.playerId, guest.id);

    // seat intents stay refused for the observer
    await expectError(watcher, { t: 'room.ready', ready: true }, ERR.ROOM_STARTED); // a running match refuses everyone
    await expectError(watcher, { t: 'g.infoReady' }, ERR.NOT_IN_ROOM); // the stub match has no such player

    // the match ends: the observer gets the m.result like the players
    await expectOk(host, { t: 'g.infoReady' });
    await expectOk(guest, { t: 'g.infoReady' });
    const result = await watcher.waitFor('m.result');
    assert.equal(result.stub, true);

    // and a later resync replays the result until the observer acts (ready-like intents are refused, so it
    // stays until they leave or the room moves on)
    watcher.clearInbox();
    await watcher.hello('W', watcher.token);
    const replayed = await watcher.waitFor('m.result');
    assert.equal(replayed.stub, true);
  });

  test('leaving frees the slot; the last human leaving disposes the room even with observers', async () => {
    const host = await pool.player('H6');
    const st = await createRoom(host);
    const watcher = await pool.player('W6');
    await expectOk(watcher, { t: 'room.join', code: st.code, asObserver: true });
    await watcher.waitFor('room.state', (s) => !!observerOf(s, watcher.id));
    await expectOk(watcher, { t: 'room.leave' });
    const empty = await host.waitFor('room.state', (s) => !observerOf(s, watcher.id));
    assert.equal(empty.observers.length, 0);

    // observers never keep a room alive: the host leaves → the room is disposed (silently, like the seats:
    // reason 'empty' sends no room.closed), the observer's next action finds no room
    const w2 = await pool.player('W7');
    await expectOk(w2, { t: 'room.join', code: st.code, asObserver: true });
    await w2.waitFor('room.state', (s) => !!observerOf(s, w2.id));
    await expectOk(host, { t: 'room.leave' });
    await expectError(w2, { t: 'room.join', code: st.code, asObserver: true }, ERR.ROOM_NOT_FOUND);
  });

  test('局间补位: an observer re-joining the room code takes a free seat while the room is in LOBBY', async () => {
    const host = await pool.player('H8');
    const st = await createRoom(host);
    const watcher = await pool.player('W8');
    await expectOk(watcher, { t: 'room.join', code: st.code, asObserver: true });
    await watcher.waitFor('room.state', (s) => !!observerOf(s, watcher.id));

    // LOBBY + a free seat: re-joining the same code promotes the observer to a full member
    await expectOk(watcher, { t: 'room.join', code: st.code });
    const seated = await watcher.waitFor('room.state', (s) => !!seatOf(s, watcher.id));
    assert.equal(observerOf(seated, watcher.id), undefined, 'the slot is freed');
    assert.equal(seatOf(seated, watcher.id).seat, 1);
    assert.equal(seatOf(seated, watcher.id).ready, false, 'the new seat starts unready');
    assert.equal((seated.observers || []).length, 0);

    // the promoted player is a full member: ready gate and start flow work as usual
    await expectOk(watcher, { t: 'room.ready', ready: true });
    await host.waitFor('room.state', (s) => seatOf(s, watcher.id)?.ready === true);
  });

  test('no promotion while a match runs or with an explicit asObserver', async () => {
    const host = await pool.player('H9');
    const st = await createRoom(host, 'coop', 'NORMAL');
    const guest = await pool.player('G9');
    await expectOk(guest, { t: 'room.join', code: st.code });
    await expectOk(guest, { t: 'room.ready', ready: true });
    await expectOk(host, { t: 'room.start' });
    await guest.waitFor('m.public');

    const watcher = await pool.player('W9');
    await expectOk(watcher, { t: 'room.join', code: st.code }); // mid-match: straight to the slots
    await watcher.waitFor('room.state', (s) => !!observerOf(s, watcher.id) && s.inMatch);

    // a running match's roster is frozen: a plain re-join stays in the slots …
    await expectOk(watcher, { t: 'room.join', code: st.code });
    const still = await watcher.waitFor('room.state', (s) => !!observerOf(s, watcher.id));
    assert.equal(seatOf(still, watcher.id), null);
    // … and an explicit asObserver re-join does not promote either
    await expectOk(watcher, { t: 'room.join', code: st.code, asObserver: true });
    const still2 = await watcher.waitFor('room.state', (s) => !!observerOf(s, watcher.id));
    assert.equal(seatOf(still2, watcher.id), null);
  });
});
