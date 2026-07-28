import { createSign } from "node:crypto";

/**
 * Signs a GitHub App JWT (RS256, as GitHub's App-authentication scheme
 * requires) using only node:crypto — no JWT library dependency needed for
 * one narrow, well-specified use. Valid for 9 minutes (GitHub allows a
 * maximum of 10; backdated by 60s to tolerate clock skew between this host
 * and GitHub's, per GitHub's own documented recommendation).
 *
 * This JWT authenticates as the APP itself, never a specific installation —
 * it is only ever used for the two calls that require app-level identity
 * (minting an installation access token, and reading installation
 * metadata for ownership verification). It is never returned to a client,
 * never logged, and never persisted.
 */
const JWT_LIFETIME_SECONDS = 9 * 60;
const CLOCK_SKEW_TOLERANCE_SECONDS = 60;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function signGithubAppJwt(appId: string, privateKeyPem: string, now: () => Date = () => new Date()): string {
  const issuedAt = Math.floor(now().getTime() / 1000) - CLOCK_SKEW_TOLERANCE_SECONDS;
  const expiresAt = issuedAt + JWT_LIFETIME_SECONDS;

  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: issuedAt, exp: expiresAt, iss: appId };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();

  let signature: Buffer;
  try {
    signature = signer.sign(privateKeyPem);
  } catch {
    // Never surface OpenSSL's own error text — it can echo back fragments
    // of a malformed key. The caller only needs to know signing failed.
    throw new Error("Unable to sign GitHub App JWT — check GITHUB_APP_PRIVATE_KEY");
  }

  return `${signingInput}.${base64url(signature)}`;
}
