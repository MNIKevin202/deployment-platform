import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * A short-lived, one-time-use CSRF state store for the GitHub App
 * connect/callback flow.
 *
 * Why this exists instead of relying on the panel's session cookie on the
 * callback request: the session cookie is set with SameSite=Strict (see
 * auth.ts), and GitHub's redirect back to /github/callback is a top-level
 * cross-site navigation (its referrer is github.com) — a Strict cookie is
 * NOT sent on that request by design. So `/github/callback` cannot require
 * the session cookie the way every other route does; instead, ownership of
 * the callback is proven by the state value itself: it was handed out only
 * to an already-authenticated request to /github/connect, is unguessable
 * (32 random bytes), stored server-side (never trust a client-supplied
 * value alone), expires quickly, and is deleted the instant it's read —
 * so a replayed callback (the same state used twice) is rejected even if
 * the first use succeeded.
 *
 * In-memory and per-process by design: this state is only ever needed for
 * the few minutes between a click and GitHub's redirect back, so losing it
 * on a process restart (which would just make that one in-flight
 * connection attempt fail, safely) is an acceptable trade for never
 * persisting anything, ever, about an incomplete authorization attempt.
 */

const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_BYTES = 32;

interface StateEntry {
  username: string;
  createdAt: number;
}

export interface GithubAppStateStore {
  /** Issues a new one-time state for the given authenticated username. */
  create(username: string): string;
  /**
   * Validates and CONSUMES a state value — every call removes it from the
   * store regardless of outcome, so a value can never be checked twice
   * successfully. Returns the username the state was issued to, or null if
   * the value is unknown, expired, or already used.
   */
  consume(state: string): string | null;
}

export function createGithubAppStateStore(now: () => number = () => Date.now()): GithubAppStateStore {
  const states = new Map<string, StateEntry>();

  function sweepExpired(): void {
    const cutoff = now() - STATE_TTL_MS;
    for (const [key, entry] of states) {
      if (entry.createdAt <= cutoff) {
        states.delete(key);
      }
    }
  }

  function create(username: string): string {
    // Opportunistic cleanup — bounded by actual traffic through this
    // store, never by a background timer keeping the process alive.
    sweepExpired();

    const state = randomBytes(STATE_BYTES).toString("base64url");
    states.set(state, { username, createdAt: now() });
    return state;
  }

  function consume(state: string): string | null {
    if (typeof state !== "string" || state.length === 0 || state.length > 200) {
      return null;
    }

    // Constant-time lookup would require iterating every key, which is
    // unnecessary here: `state` is 256 bits of randomness the caller must
    // already know exactly, so a plain Map lookup leaks nothing an
    // attacker could use (there is no valid "close but wrong" state to
    // time against — every non-matching key is equally absent).
    const entry = states.get(state);

    // One-time use: delete on read, whether or not it turns out valid.
    states.delete(state);

    if (!entry) {
      return null;
    }

    if (now() - entry.createdAt > STATE_TTL_MS) {
      return null;
    }

    return entry.username;
  }

  return { create, consume };
}

/** Test-only helper: constant-time string comparison, exported for a dedicated timing-shape test. */
export function constantTimeStringEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}
