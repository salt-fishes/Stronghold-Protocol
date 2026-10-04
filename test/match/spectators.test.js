// test/match/spectators.test.js — spectator slots at the Match level: an observer holds no PlayerState, may only
// send g.watch (handle routes it to _watchAsObserver), receives the watched field's frames (m.field + b.snap in
// server-run combat, the b.start spec with watch:true under client-side combat) and the final m.result.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERR, PHASE } from '../../shared/constants.js';
import { makeMatch } from './harness.js';

test('observer intents: g.watch shows a field, every other g.* is refused, strangers stay NOT_IN_ROOM', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 1, seed: 5, observers: [{ playerId: 'obs_1', name: 'Watcher' }] });
  h.autoHumans();
  h.m.start();
  h.drive(() => h.m.phase === PHASE.COMBAT);
  assert.equal(h.m.observers.has('obs_1'), true);
  // the whole table sees who is watching: m.public carries the observers with their names
  const pub = h.lastBc('m.public');
  assert.ok(pub.observers.some((o) => o.playerId === 'obs_1' && o.name === 'Watcher'), 'observers listed in m.public');

  // seat intents are refused without touching a PlayerState
  assert.equal(h.m.handle('obs_1', { t: 'g.buy', slot: 0 }).error, ERR.BAD_MSG);
  assert.equal(h.m.handle('obs_1', { t: 'g.infoReady' }).error, ERR.BAD_MSG);
  assert.equal(h.m.handle('obs_1', { t: 'g.emote', id: 'autochess_battle_happy' }).error, ERR.BAD_MSG);
  // a playerId that is neither a seat nor an observer stays out
  assert.equal(h.m.handle('stranger', { t: 'g.watch', fieldId: 'x' }).error, ERR.NOT_IN_ROOM);

  // g.watch of a live field: m.field + the first snapshot go to the observer (server-run combat)
  const fid = h.m.fields[0].fieldId;
  assert.equal(h.m.handle('obs_1', { t: 'g.watch', fieldId: fid }).ok, true);
  assert.equal(h.m.watchers.get('obs_1'), fid);
  const field = h.lastTo('obs_1', 'm.field');
  assert.ok(field, 'observer received m.field');
  assert.equal(field.fieldId, fid);
  assert.ok(h.lastTo('obs_1', 'b.snap'), 'observer received the first b.snap');
  // the observer counts as showing the field (b.end reaches it when the field ends)
  assert.ok(h.m._humansShowing(h.m.fields[0]).includes('obs_1'));
  // junk field ids are refused
  assert.equal(h.m.handle('obs_1', { t: 'g.watch', fieldId: 'n:ghost' }).error, ERR.BAD_TARGET);

  h.m.dispose();
});

test('addObserver: the lobby registers a mid-match joiner (中途观战) with the running match', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 1, seed: 9 });
  h.autoHumans();
  h.m.start();
  h.drive(() => h.m.phase === PHASE.COMBAT);
  assert.equal(h.m.observers.has('late_1'), false);
  h.m.addObserver('late_1');
  const fid = h.m.fields[0].fieldId;
  assert.equal(h.m.handle('late_1', { t: 'g.watch', fieldId: fid }).ok, true);
  assert.ok(h.lastTo('late_1', 'm.field'), 'the mid-match observer received m.field');
  assert.equal(h.m.handle('late_1', { t: 'g.buy', slot: 0 }).error, ERR.BAD_MSG);
  h.m.dispose();
});

test('observer receives the final m.result (unicast like the players)', () => {
  const h = makeMatch({ mode: 'solo', difficulty: 'FUNNY', humans: 1, bots: 0, seed: 3, observers: ['obs_1'], captureFrames: false });
  h.autoHumans();
  h.m.start();
  h.runToEnd({ maxSteps: 2e6 });
  const result = h.lastTo('obs_1', 'm.result');
  assert.ok(result, 'observer got m.result');
  assert.equal(result.t, 'm.result');
  h.m.dispose();
});

test('client-side combat: the observer gets the field spec (b.start watch:true) and is never the authority', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 0, seed: 8, observers: ['obs_1'], clientCombat: true, clients: false, captureFrames: false });
  h.autoHumans();
  h.m.start();
  h.drive(() => h.m.phase === PHASE.COMBAT);
  const fid = h.m.fields[0].fieldId;
  assert.equal(h.m.handle('obs_1', { t: 'g.watch', fieldId: fid }).ok, true);
  const start = h.lastTo('obs_1', 'b.start');
  assert.ok(start, 'observer received b.start');
  assert.equal(start.fieldId, fid);
  assert.equal(start.watch, true, 'display only');
  assert.notEqual(start.authoritative, true, 'an observer never simulates a field');
  h.m.dispose();
});
