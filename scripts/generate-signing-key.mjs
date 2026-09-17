#!/usr/bin/env node
/**
 * generate-signing-key.mjs — generate an Ed25519 release-signing key pair.
 *
 * Cross-platform (Windows/Mac/Linux), dependency-free (node:crypto/fs only).
 * Run this LOCALLY — never on a CI runner. It:
 *   - writes the PUBLIC key to installer/trusted-keys/<keyId>.pem (commit it),
 *   - prints the PRIVATE key (base64 PKCS8 PEM) to stdout for you to paste
 *     into the GitHub Actions secret RELEASE_SIGNING_PRIVATE_KEY.
 *
 * The private key is printed, never written to disk, so it can't be
 * committed by accident. Close the terminal after copying it.
 *
 * Usage:
 *   node scripts/generate-signing-key.mjs [keyId]
 *   (keyId defaults to the next rotation id; pass one explicitly for clarity)
 */

import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const keyId = (process.argv[2] ?? "clovaforge-release-2").trim();

if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(keyId)) {
  console.error(`Invalid keyId: ${JSON.stringify(keyId)} (letters, digits, . _ - only).`);
  process.exit(1);
}

const publicKeyPath = join(repoRoot, "installer", "trusted-keys", `${keyId}.pem`);
if (existsSync(publicKeyPath)) {
  console.error(`Refusing to overwrite an existing trusted key: ${publicKeyPath}`);
  console.error("Pick a new keyId (for rotation) or remove the file deliberately first.");
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const privatePemBase64 = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");

mkdirSync(dirname(publicKeyPath), { recursive: true });
writeFileSync(publicKeyPath, publicPem);

console.log("========================================================================");
console.log(`Public key written (COMMIT THIS FILE):`);
console.log(`  installer/trusted-keys/${keyId}.pem`);
console.log("");
console.log("Now do these two things in GitHub, then tell Claude you're done:");
console.log("");
console.log(`  1. Add a repository SECRET named:  RELEASE_SIGNING_PRIVATE_KEY`);
console.log(`     with this exact value (the PRIVATE key — never commit it, never share it):`);
console.log("");
console.log(privatePemBase64);
console.log("");
console.log(`  2. Add a repository VARIABLE named:  RELEASE_SIGNING_KEY_ID`);
console.log(`     with the value:  ${keyId}`);
console.log("========================================================================");
console.log("");
console.log("gh CLI equivalents (run locally where gh is authenticated):");
console.log(`  gh secret set RELEASE_SIGNING_PRIVATE_KEY --body "${"<paste the base64 above>"}"`);
console.log(`  gh variable set RELEASE_SIGNING_KEY_ID --body "${keyId}"`);
