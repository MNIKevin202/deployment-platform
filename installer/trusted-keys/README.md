# Trusted release-signing keys

This directory holds the **public** halves of the Ed25519 keys ClovaForge
trusts to sign release manifests. Each file is `<keyId>.pem` (SPKI PEM); the
filename (minus `.pem`) is the `keyId` that must appear in a manifest's
signature envelope for it to be accepted.

These files are the single trust anchor for the whole self-update system.
They are read by two consumers, both from these exact bytes:

- the **API image** — baked in via `apps/api/Dockerfile`'s
  `COPY installer/trusted-keys ./trusted-keys`, loaded by
  `apps/api/src/services/trusted-keys.ts`;
- the **host updater** — the installer copies this directory to
  `${INSTALL_ROOT}/config/trusted-keys/`, and the updater's verify step
  (`installer/updater/resolve-update.mjs`) reads it.

## Security

- **Only public keys go here.** Never commit a private key. A private key
  belongs only in the CI signing secret (see below). A file whose contents
  are not a PUBLIC KEY block is ignored by both loaders.
- An **empty** directory means "trust nothing" — every manifest is rejected
  as `unknown-signing-key`. That is the correct, intended state until a real
  key is provisioned.

## Provisioning the first key

Generate a key pair **locally** (never on a CI runner), on Windows or any
machine with Node:

```
node scripts/generate-signing-key.mjs clovaforge-release-2
```

That writes the **public** key to `installer/trusted-keys/clovaforge-release-2.pem`
(commit it) and prints the **private** key (base64). Add the private key as
the GitHub Actions repository secret `RELEASE_SIGNING_PRIVATE_KEY`, and set
the repository variable `RELEASE_SIGNING_KEY_ID` to `clovaforge-release-2`.

The active key is `clovaforge-release-2`.

See `docs/SELF_UPDATE_ARCHITECTURE.md` → "Signing" for the full procedure and
key rotation.
