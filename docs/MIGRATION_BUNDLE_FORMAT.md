# Migration Bundle Format, Encryption and Key Management

Format identifier: `clovaforge-migration-bundle`, **format version 1**.
Implementation: `apps/api/src/migration/` (`crypto.ts`, `bundle.ts`, `signing.ts`,
`manifest.ts`). This document is the contract; the tests in
`apps/api/src/tests/migration-*.test.ts` pin it.

## 1. Properties, stated plainly

| Property | Guaranteed by | Needs |
|---|---|---|
| **Confidentiality** of every artifact *and* the manifest | AES-256-GCM, per-artifact keys | The passphrase |
| **Integrity** — content is exactly what the manifest says, complete, in order, untruncated | Per-chunk GCM tags + manifest hashes | The passphrase |
| **Authenticity (weak)** — whoever made it knew the passphrase | GCM keyed from the passphrase | The passphrase |
| **Authenticity (origin)** — it was produced by a *specific, known* source installation | Ed25519 signature over the manifest, **pinned** to an expected key fingerprint | A fingerprint obtained out of band |

**Integrity and authenticity are different, and are reported separately.**

- *Integrity* answers: "Is this the data the manifest describes, undamaged and complete?"
- *Authenticity* answers: "Did this come from the source I think it did?"

They can disagree, and the tooling treats them independently:

- A bundle whose artifact was bit-flipped in transit has **integrity failed** even if
  its signature is perfectly valid.
- A bundle assembled by someone who knows the passphrase (or who shares it) has
  **integrity verified** yet only **passphrase-level** authenticity. A symmetric
  passphrase cannot prove *which* of the passphrase's holders made it.
- A signature is only meaningful if the verifier **pins the expected signer
  fingerprint**. An unpinned signature merely proves the bundle is self-consistent
  with whichever key it carries — an attacker can sign their own bundle with their own
  key. The tool says so in its output instead of printing a reassuring "signed".

## 2. On-disk layout (a directory)

```
<bundle>/
  bundle.header.json     plaintext: format, version, bundleId, cipher params, key slots
  manifest.enc           the manifest, encrypted (artifact id "manifest")
  manifest.sig.json      optional plaintext: Ed25519 signature + signer public key
  artifacts/
    <artifactId>.enc     one encrypted file per artifact
```

A directory (not one archive) so an interrupted transfer resumes per file and each
artifact is verifiable and restorable independently. Transport (tar, rsync, a direct
peer stream) is orthogonal. Only the header, the signature file and file *names* are
plaintext.

**What an observer of an encrypted bundle can learn:** the format version, bundle
id, KDF parameters, number of artifacts and their approximate sizes, and (if present)
the signer's public key. They cannot learn app names, domains, volume names, versions
or counts of apps — all of that is inside `manifest.enc`. Artifact ids are therefore
opaque (`a0001`, `a0002`, …), never app or volume names.

## 3. Header (`bundle.header.json`)

```json
{
  "format": "clovaforge-migration-bundle",
  "formatVersion": 1,
  "bundleId": "<uuid v4>",
  "cipher": "aes-256-gcm-stream-v1",
  "chunkSize": 1048576,
  "keySlots": [
    {
      "type": "passphrase",
      "id": "ks-1",
      "kdf": { "algorithm": "scrypt", "N": 131072, "r": 8, "p": 1, "salt": "<b64 32B>" },
      "nonce": "<b64 12B>",
      "wrappedKey": "<b64 32B>",
      "tag": "<b64 16B>"
    }
  ]
}
```

The header is plaintext but **authenticated**: every field that matters feeds the
associated data of the key wrap and of every chunk, so substituting the `bundleId`,
the chunk size or a KDF parameter makes decryption fail rather than silently succeed.

## 4. Key-management model

```
passphrase ──scrypt(salt, N,r,p)──► KEK (32 B)
                                      │ AES-256-GCM wrap (AAD = header context)
random 32 B ─────────────────────────► bundle key (BK)   [stored only in wrapped form]
BK ──HKDF-SHA256(salt = per-file random, info = bundleId ‖ artifactId)──► artifact key
artifact key ──AES-256-GCM chunk stream──► artifact ciphertext
```

- **Bundle key (BK).** A fresh random 32-byte key per bundle. It is never stored in the
  clear. It is stored wrapped by one or more *key slots*.
- **Key slots.** Format v1 defines one slot type, `passphrase`. The array exists so a
  second slot (a recovery key, a destination public key) can be added without a format
  change, and so the passphrase can be changed by re-wrapping BK in the header without
  re-encrypting terabytes.
- **KEK derivation.** scrypt, default `N=2^17, r=8, p=1` (≈128 MiB of memory; ≈0.2 s measured on a
  developer workstation — cheap for the legitimate user, costly per guess for an attacker). The reader
  enforces bounds on header-supplied parameters: `N` from `2^14` to `2^19` and `r`, `p` capped,
  **and** the memory they imply (`128·N·r`) capped at **256 MiB** per derivation — individually
  in-range values such as `N=2^19, r=16` would otherwise demand 1 GiB — with at most
  **4 key slots**. A hostile header can therefore neither weaken the KDF below the floor nor
  exhaust memory. Passphrases are NFKC-normalised and must be **at least 12 characters**.
- **Artifact keys.** Each artifact key is `HKDF-SHA256(BK, salt = 16 random bytes stored
  in that artifact's file header, info = "cfmig-artifact-v1" ‖ bundleId ‖ artifactId)`.
  Distinct keys per artifact mean the chunk nonce only has to be unique *within* a file,
  so a counter suffices and nonce reuse across artifacts is structurally impossible.
- **The passphrase is supplied only via a mode-600 file or a hidden prompt** — never on
  the command line, never an environment variable. The file's trailing newline is
  stripped.
- **No key escrow.** There is no recovery path for a lost passphrase. That is a
  deliberate property, and it is the main operational responsibility of the operator:
  store the passphrase (and the signer fingerprint) in a password manager, separately
  from the bundle.

### What lives inside the bundle (and why that's acceptable)

At **platform scope** the bundle carries `auth.env` (including
`CREDENTIAL_ENCRYPTION_KEY`) because the destination replaces the source; without that
key every stored provider credential is unreadable. The bundle is encrypted, so the key
only ever exists in the clear on a machine that is already trusted with it. At
**application scope** the destination keeps its own key; credentials are re-wrapped
(see `MIGRATION_DESIGN.md` §6.3).

### Compromise considerations

| Event | Effect |
|---|---|
| Bundle file stolen, passphrase safe | Attacker holds ciphertext only. Cost to attack = scrypt cost × passphrase entropy. Use a long random passphrase. |
| Passphrase leaked, bundle safe | Nothing is exposed until the bundle is also obtained. Then **everything** is — including the credential key. Treat as full secret compromise and rotate. |
| Both | As above. After any such event, rotate the credential encryption key and all provider tokens. |

## 5. Artifact stream format (`artifacts/<id>.enc`, and `manifest.enc`)

```
offset 0   "CFAF"            magic (4)
       4   0x01              stream version (1)
       5   log2(chunkSize)   (1)
       6   salt              (16, random, input to HKDF)
      22   chunk 0 ... chunk N     each = ciphertext ‖ 16-byte GCM tag
```

- Plaintext is cut into `chunkSize` pieces (default 1 MiB). Every chunk except the last
  is exactly `chunkSize`; the last is `0..chunkSize` bytes. An empty artifact is one
  empty final chunk (just a tag).
- **Nonce (12 bytes)** = 11-byte big-endian chunk counter ‖ 1-byte *final flag*
  (`0x00` for every chunk except the last, `0x01` for the last).
- **Additional authenticated data** for every chunk = `"cfmig-chunk-v1" ‖ 0x00 ‖
  bundleId ‖ 0x00 ‖ artifactId ‖ 0x00 ‖` the 22 header bytes above.

Consequences:

- **Reordering / duplicating / dropping a chunk** fails authentication (the counter is in
  the nonce).
- **Truncation** fails: the true last chunk is the only one authenticated with the final
  flag, so a stream cut at a chunk boundary has no valid final chunk.
- **Appending data** after the final chunk is rejected.
- **Moving an artifact into another bundle or under another id** fails (`bundleId` and
  `artifactId` are in the AAD and the key derivation).
- Decryption **emits a chunk only after it authenticates**, but a consumer that has
  already written earlier chunks to disk must still treat that output as **untrusted
  until the stream completes successfully**: write to a temporary file and promote it
  only on success. The importer does this.

## 6. Manifest (`manifest.enc`, plaintext JSON once decrypted)

Validated with a strict schema (unknown fields are rejected). Key contents:

- `bundleId` — must equal the header's (binds manifest to header).
- `scope` — `platform` | `application`; `operation` — `backup` | `copy` | `move`.
- `source` — server id, platform version, DB schema version, architecture.
- `artifacts[]` — for each: opaque `id`, `kind`, `subject`, **plaintext** size and sha-256,
  **ciphertext** size and sha-256, and free-form metadata.
- `apps[]` — name, container name, image, domain, volumes, required images, dependencies,
  per-volume consistency record.
- `consistency` — the overall level, per-subject level **with the evidence that supports
  it**, and any `acceptedRisks` the operator explicitly signed off.
- `transfer` — migration id, ownership `epoch`, source owner (used for fencing).

Artifact ids are restricted to `^[a-z0-9][a-z0-9._-]{0,63}$`; they become file names, so
this is also the path-traversal defence. Duplicate ids are rejected.

## 7. Signature (`manifest.sig.json`, optional)

```json
{
  "algorithm": "ed25519",
  "publicKey": "<b64 SPKI DER>",
  "fingerprint": "sha256:<hex>",
  "signature": "<b64>"
}
```

The signed message is `"cfmig-manifest-sig-v1" ‖ 0x00 ‖ bundleId ‖ 0x00 ‖
sha256(manifest plaintext)`. Because the manifest transitively commits to every
artifact's hash, one signature covers the whole bundle.

**Policy a verifier applies:**

| Verifier configured with | Signature absent | Signature valid | Signature invalid | Different signer |
|---|---|---|---|---|
| nothing | `passphrase-only` | `passphrase-only` + note "signer not pinned" | **failed** | n/a |
| `--expect-signer <fp>` | **failed** (a stripped signature must not downgrade silently) | `origin-verified` | **failed** | **failed** |

The signature file is not secret and is not encrypted, so an attacker can *remove* it; that
is exactly why pinning turns "absent" into a failure.

## 8. Verification depths

- **Structure** (cheap): header parses and is supported; passphrase unwraps BK; manifest
  decrypts and validates; every manifest artifact exists with the manifest's ciphertext
  size; no unlisted extra files; signature policy applied.
- **Deep** (reads everything): additionally stream-decrypts every artifact, checking every
  chunk's tag and the artifact's plaintext sha-256 and size. Deep verification buffers
  nothing to disk and is read-only.

A bundle is untrusted input at the moment it is verified, so the reader is defensive:

- The header (64 KiB), signature file (16 KiB) and `manifest.enc` (32 MiB) are **size-checked
  before they are read** into memory.
- Every bundle file must be a **regular file**; symbolic links and directories are refused, never
  followed, so a bundle cannot make the verifier read some other file on the machine.
- Error messages never echo file contents, the passphrase or key material.

## 9. Idempotent import contract (executor lands in Phase 2)

- Resources created by an import carry labels
  `com.deployment-platform.migration-id`, `…migration-artifact` and
  `…artifact-sha256`.
- **A resource is "ours" only if its labels match this migration and artifact.** Names are
  never trusted.
- Docker volume labels are immutable. A volume created by an import is labelled at
  creation; completion is recorded in the **journal**, not the label. So:
  - labelled + journal `done` → already applied, skipped;
  - labelled + journal not `done` → ours and incomplete, safe to wipe and redo (it was never
    live);
  - **not labelled → never touched**; the plan reports a conflict.
- The importer never overwrites an unlabelled resource. Replacement is a separate,
  explicit, typed-confirmation operation that takes an automatic backup first.
- The journal (`pending | in-progress | done | failed`, attempts, verified digest) is
  durable and drives resume; the reducer that decides next actions is pure and tested.

## 10. Compatibility rules

- Reader rejects `formatVersion` greater than it supports (**no silent forward-compat**).
- Platform scope: bundle `schemaVersion` must not exceed the destination's, and the
  bundle's platform version must not be newer than the destination's (downgrade guard).
  Older bundles are brought forward by the normal migration runner, after a backup.
- Application scope: the destination's schema version must be at least the source's.
- Architecture must match for local images; registry images are reported as a warning.

## 11. Exit codes of the CLI

| Code | Meaning |
|---|---|
| 0 | Ready |
| 10 | Ready with warnings |
| 20 | Blocked / refused (at least one failing check, or an export refused before it started) |
| 4 | An export failed; every application was restored and any partial bundle removed |
| 5 | An export failed **and an application could not be restored** (needs a human now) |
| 2 | Usage error |
| 3 | Internal error |

## 12. Artifact conventions written by `migrate export`

The format in §§2–10 is unchanged. These are the conventions export uses for artifact `meta`
(free-form key/values) and `kind`, which later phases rely on.

| `kind` | Content (after decryption) | `meta` |
|---|---|---|
| `platform-database` | gzip of a SQLite file made by `VACUUM INTO` from a read-only handle and checked with `PRAGMA integrity_check` | `format=sqlite`, `compression=gzip`, `schemaVersion`, `integrity=ok`, `consistency=application-consistent`, `evidence`, `uncompressedBytes` |
| `platform-config` | gzip of a tar of the configuration directory (secrets, including the credential encryption key) | `format=tar`, `compression=gzip` |
| `caddy-routes` | gzip of a tar of the proxy routes directory | same |
| `app-definition` | JSON (`definitionVersion: 1`): the app's rows, environment values, inherited global environment, **decrypted** provider credentials to be re-encrypted for the destination, an `unexported` list, and the dependency analysis | `definitionVersion` |
| `volume` | gzip of a tar of the volume's contents | `volume`, `mountPath`, `format=tar`, `compression=gzip`, `uncompressedBytes` |
| `db-dump` | gzip of a verified logical dump | `volume`, `hook`, `format`, `compression=gzip`, `uncompressedBytes` |
| `image` | `docker save` stream, not recompressed | `tag`, `role` (`current`/`rollback`/`dependency`), `imageId`, `format=docker-save`, `compression=none` |

**Dump-backed volumes.** When an app's volume is captured as a verified dump, the manifest's volume
record points its `artifactId` at the `db-dump` artifact (and its consistency is
`application-consistent` with `logical-dump-verified` evidence). An importer must therefore decide
how to restore a volume **by the kind of its artifact**: a `volume` is unpacked; a `db-dump` is loaded
into a fresh database of the same engine.

**Consistency per volume** is recorded in the manifest as `{ level, strategy, evidence[] }`, where
every evidence entry names what was actually observed. `consistency.mode` is `rehearsal` or `cutover`;
a cutover bundle with a volume below `application-consistent` carries an explicit entry in
`consistency.acceptedRisks`. `transfer.epoch` is 0 at export (ownership and fencing begin in Phase 5).
