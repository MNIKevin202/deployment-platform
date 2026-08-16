/**
 * A connection string almost always carries a password. The registry stores
 * the full value (its whole purpose is to hand it back on request), but list
 * views and logs should never show the password in the clear. `redactSecret`
 * turns a connection string into a safe preview: the password inside a
 * `scheme://user:password@host` URI becomes `••••`, and any string with no
 * recognizable URI shape is masked down to a short, non-reversible hint.
 */

const MASK = "••••"; // ••••

// scheme://[user[:password]@]rest — password is group 3 when present.
const URI_WITH_CREDENTIALS = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:/@\s]+)(:[^@/\s]+)?@(.*)$/s;

export function redactConnectionString(raw: string): string {
  const value = raw.trim();

  if (value.length === 0) {
    return "";
  }

  const match = URI_WITH_CREDENTIALS.exec(value);

  if (match) {
    const [, scheme, user, password, rest] = match;
    // Keep the shape (scheme, user, host) so the operator can still recognize
    // which connection this is, but never echo the password back.
    const maskedPassword = password ? `:${MASK}` : "";
    return `${scheme}${user}${maskedPassword}@${rest}`;
  }

  // A URI with no embedded credentials (redis://host:6379, and the like) has
  // no password to hide — show it as-is rather than masking a public host.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
    return value;
  }

  // No URI structure to key off of (a bare key, an ODBC-style string, …).
  // Show only the first few characters so it stays unidentifiable.
  if (value.length <= 8) {
    return MASK;
  }

  return `${value.slice(0, 4)}${MASK}`;
}
