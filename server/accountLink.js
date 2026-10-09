// server/accountLink.js — sp-accounts bridge (deploy/accounts/), env-gated: without SP_ACCOUNT_TOKEN
// every export is a no-op and the server behaves exactly as upstream (PATCH.md documents the anchors).
//
// The account gateway in front of the game injects `X-SP-User` (always overwriting a client-supplied
// value; only the gateway can reach the game) on gated connections. With a token configured this module:
//   * hands the request's account name to the session layer (net.js: `conn.account` → `session.account`),
//     which the lobby copies onto the human seat (lobby.js `humanSeat`);
//   * reports every finished match of an accounted seat to the account service:
//     POST {SP_ACCOUNT_URL}/ingest/result with `Authorization: Bearer ${SP_ACCOUNT_TOKEN}`.
// The report is fire-and-forget — a missing or failing account service never affects a match.
//
// Env: SP_ACCOUNT_URL (default http://127.0.0.1:3001), SP_ACCOUNT_TOKEN (required to enable).

const DEFAULT_URL = 'http://127.0.0.1:3001';
const TIMEOUT_MS = 5000;
const NAME_MAX = 64;

const envToken = () => String(process.env.SP_ACCOUNT_TOKEN || '');
const envBase = () => String(process.env.SP_ACCOUNT_URL || DEFAULT_URL).replace(/\/+$/, '');

/** `X-SP-User` of an upgrade request, or null when the link is disabled / the header is absent. */
export function accountFromRequest(req) {
  if (!envToken()) return null;
  const raw = req && req.headers ? req.headers['x-sp-user'] : null;
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  return name ? name.slice(0, NAME_MAX) : null;
}

/** The m.result `reason` → the account service's outcome vocabulary (see deploy/accounts). */
function outcomeOf(summary) {
  if (summary.victory) return 'win';
  return { defeat: 'loss', eliminated: 'eliminated', abandoned: 'abort', error: 'error' }[summary.reason] || 'loss';
}

/** The /ingest/result body for one seat (pure; exported for tests). */
export function buildReport(room, summary, seat) {
  return {
    account: seat.account,
    matchKey: `${room.code}:${room.matchCount}:${summary.seed ?? 0}`,
    mode: String(room.mode || ''),
    difficulty: String(room.difficulty || ''),
    rounds: Number.isInteger(summary.roundsPassed) ? summary.roundsPassed : null,
    payload: {
      outcome: outcomeOf(summary),
      victory: !!summary.victory,
      reason: summary.reason,
      hiddenReached: !!summary.hiddenReached,
      hiddenCleared: !!summary.hiddenCleared,
      durationMs: Number.isFinite(summary.durationMs) ? summary.durationMs : null,
      seed: summary.seed ?? null,
      stageId: summary.stageId ?? null,
      modeId: summary.modeId ?? null,
      players: (Array.isArray(summary.players) ? summary.players : []).map((p) => ({
        seat: p.seat, name: p.name, isBot: !!p.isBot, left: !!p.left, alive: !!p.alive,
        lp: p.lp, roundsPassed: p.roundsPassed, eliminatedRound: p.eliminatedRound,
        stats: p.stats ?? null, lineup: p.lineup ?? null,
      })),
    },
  };
}

/**
 * Fire-and-forget: one POST per human seat bound to an account. Never throws, never blocks.
 * @param {{ code: string, matchCount: number, mode?: string, difficulty?: string, seats?: Array }} room
 * @param {object | null} summary the match's onEnd summary (m.result without `t`, plus `errors`)
 * @param {{ fetchImpl?: Function, log?: object | null }} [opts]
 */
export function reportMatch(room, summary, { fetchImpl = globalThis.fetch, log = null } = {}) {
  const token = envToken();
  if (!token || !summary || !room || !Array.isArray(room.seats)) return;
  const seats = room.seats.filter((s) => s && !s.isBot && s.account);
  if (!seats.length) return;
  const base = envBase();
  for (const seat of seats) {
    let body;
    try { body = JSON.stringify(buildReport(room, summary, seat)); } catch { continue; }
    try {
      const pending = fetchImpl(`${base}/ingest/result`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body,
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined,
      });
      if (pending && typeof pending.catch === 'function') pending.catch((e) => log?.debug?.('[account] ingest failed', e?.message || e));
    } catch (e) {
      log?.debug?.('[account] ingest failed', e?.message || e);
    }
  }
}
