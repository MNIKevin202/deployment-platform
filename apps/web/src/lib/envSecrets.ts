/**
 * Heuristics for presenting environment variables safely and legibly.
 *
 * The API only withholds a value from the browser when the operator has
 * explicitly flagged a variable as a secret. In practice many
 * credential-bearing variables (`*_API_KEY`, `DATABASE_URL`, ...) were never
 * flagged, so their values arrive in plaintext and were previously rendered
 * in full. `looksSecret` lets the UI mask those by default — behind an
 * explicit reveal — without changing what is stored. It is deliberately a
 * display-only convenience: masking something that is not really a secret is
 * harmless (one click reveals it), so the heuristic errs toward masking.
 */

// Matched anywhere in the (upper-cased) key. These read as unambiguously
// sensitive regardless of how the key is segmented.
const STRONG_SUBSTRINGS = [
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "PASSPHRASE",
  "APIKEY",
  "PRIVATEKEY",
  "CREDENTIAL"
];

// Matched only as a whole `_`/`-` separated segment, so `KEY` fires on
// `METALS_API_KEY` but a word that merely contains one of these (e.g.
// `AUTHOR`, `KEYBOARD`) does not.
const SECRET_TOKENS = new Set([
  "KEY",
  "PWD",
  "PASS",
  "SECRET",
  "TOKEN",
  "AUTH",
  "CREDENTIALS",
  "DSN",
  "SALT",
  "CERT"
]);

// A connection string that carries an inline `user:password@host` — e.g.
// `mongodb+srv://u:p@cluster` or `postgres://u:p@db`. Requires the `@`, so a
// plain `http://host:8080/path` (a port, not a password) is not matched.
const CREDENTIALED_URI = /:\/\/[^/\s:@]+:[^/\s@]+@/;

export function looksSecret(key: string, value?: string | null): boolean {
  const upper = key.toUpperCase();

  if (STRONG_SUBSTRINGS.some((substring) => upper.includes(substring))) {
    return true;
  }

  const segments = upper.split(/[_-]+/).filter(Boolean);
  if (segments.some((segment) => SECRET_TOKENS.has(segment))) {
    return true;
  }

  if (value && CREDENTIALED_URI.test(value)) {
    return true;
  }

  return false;
}

/**
 * The grouping bucket for a key: its first `_`/`-` separated segment,
 * upper-cased so `Blueprint_API` and `BLUEPRINT_MONGO_URI` cluster together.
 * A key with no separator is its own prefix.
 */
export function groupPrefix(key: string): string {
  const [first] = key.split(/[_-]/);
  return (first || key).toUpperCase();
}
