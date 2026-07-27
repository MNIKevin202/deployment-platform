# Deployment Platform Installer

Turns a fresh Ubuntu VPS into a working Deployment Platform host: Docker,
networks, volumes, secrets, the Caddy reverse proxy, the API and web
containers, and a verified public dashboard URL.

## System requirements

- Ubuntu Server 24.04 LTS (26.04 LTS is accepted with a warning — not
  yet fully validated, since it was unreleased at the time this
  installer was written)
- x86_64 / amd64 only — ARM is explicitly rejected in this release
- Minimum: 2 CPU cores, 4 GB RAM, 20 GB free disk
- Recommended: 4 CPU cores, 8 GB RAM, 40 GB free disk
- Root access (the installer refuses to run as a non-root user)
- Ports 80 and 443 free (or an existing reverse proxy you plan to
  replace)

## Security warning — read before running anything

- **Never pipe an unreviewed remote script into `sudo bash`.** Download
  it, read it, then run it. See "Recommended download flow" below.
- The API container is granted access to `/var/run/docker.sock`. This
  is required because the platform's core feature is managing other
  Docker containers on this host — but it means anyone who can execute
  code inside the API container has root-equivalent control over this
  entire machine. This is not something the installer invents; it
  matches this codebase's existing architecture. The web and Caddy
  containers never receive the socket.
- Building a Docker image from a repository (this installer's own
  source, or any GitHub repository later deployed through the running
  platform) executes that repository's Dockerfile build instructions
  with the full capabilities of the Docker daemon. A malicious
  Dockerfile can do anything the Docker daemon can do. Only build from
  source you trust.
- The installer does **not** add your normal SSH user to the `docker`
  group. Docker-group membership is equivalent to root. The installer
  runs entirely as root instead; if you want a non-root user to run
  `docker` commands directly later, do that yourself with
  `usermod -aG docker <user>`, understanding what it grants.

## DNS preparation

Before the installer can finish public verification, create:

```
panel.example.com       A     <server IPv4>
*.apps.example.com      A     <server IPv4>
```

The installer detects your server's public IPv4 from several
independent sources and prints the exact records to create. If DNS
isn't ready yet, the installer **saves its progress and exits safely**
— nothing already completed is rolled back for incomplete DNS
propagation. Resume once DNS is live:

```bash
sudo ./installer/install.sh --resume
```

Or explicitly skip the wait (public TLS verification may then fail
until DNS actually propagates):

```bash
sudo ./installer/install.sh --continue-without-dns
```

## Recommended download flow

```bash
curl -fsSL --connect-timeout 10 --max-time 60 \
  https://example.com/install.sh \
  -o install.sh

less install.sh          # read it before running anything as root

sudo bash install.sh
```

(Replace `https://example.com/install.sh` with wherever you actually
host this repository's `installer/install.sh` — this project does not
publish one itself; see Scope Limits.)

## Interactive installation

```bash
sudo ./installer/install.sh
```

Asks for: panel domain, apps base domain, administrator username,
administrator password (hidden input, confirmed), source installation
method, and automatic-backup preferences — then shows a sanitized plan
and asks for confirmation before changing anything on the server.

## Non-interactive installation

```bash
sudo ./installer/install.sh \
  --non-interactive \
  --panel-domain panel.example.com \
  --apps-domain apps.example.com \
  --admin-username admin \
  --admin-password-file /root/platform-admin-password \
  --source-ref main
```

The administrator password is **never** accepted as a plain
command-line argument (arguments are visible in the process list and
shell history) — only via `--admin-password-file` (a file you create
yourself, e.g. `install -m 600 /dev/null /root/platform-admin-password
&& printf '...' > /root/platform-admin-password`).

## Resume

```bash
sudo ./installer/install.sh --resume
```

Every stage is idempotent and independently re-verified against real
system state (not just the state file, which can go stale after a
crash or manual intervention) — an already-created network, volume,
secret file, or running container is detected and reused rather than
recreated.

## Dry run

```bash
sudo ./installer/install.sh --dry-run
```

Prints every action the installer would take without changing the
server. Combine with any other mode/flags.

## Verification

```bash
sudo ./installer/install.sh --verify-only
# or, once installed:
deployment-platform verify
```

Checks, locally: Docker daemon reachability, the two required
networks, the database volume, all three containers running,
`CREDENTIAL_ENCRYPTION_KEY` validity (without ever printing it), the
database migration count, Caddy config validity, and that the API
answers its **real backend route** inside the container — `GET
/auth/session` must return HTTP 200 with `{"authenticated":false}`.

That last check is deliberately strict. It used to probe
`/api/auth/session` in-container and accept 200, 401, 403, or 404 as
"healthy", which meant it reported green while every panel login was
failing. The prefixed path does not exist inside the container (see the
`/api` prefix contract in `docs/RELEASE_AUTOMATION.md`), and each
outcome is now classified separately: an unauthenticated session, an
authentication-hook rejection, a missing route, a malformed body, an
unexpected shape, or a connectivity/timeout failure. Only the first is
healthy, and the failure message names the likely cause.

Publicly, over HTTPS against the panel domain:

- the panel returns HTTP 200 (retried with backoff, since TLS issuance
  can take a minute after DNS first resolves),
- `GET /api/auth/session` returns 200 `{"authenticated":false}`, which
  proves Caddy is stripping the `/api` prefix,
- `POST /api/auth/login` with deliberately invalid placeholder
  credentials returns the login handler's own `Invalid username or
  password`. If it returns `Authentication required` instead, the
  request was stopped by the authentication hook before reaching the
  handler and the prefix is not being stripped.

The login smoke test never uses real credentials: the placeholders are
fixed, self-evidently fake strings, and they are piped on stdin rather
than passed in argv so nothing password-shaped appears in a process
listing. A successful login is not automated — confirm that yourself in
the browser after a release.

## Rotating the administrator password

```bash
sudo deployment-platform reset-admin-password
```

Prompts twice (hidden input), enforces the minimum length, and computes
the hash with the same hardened scrypt helper the installer uses. A
plaintext password is **never** accepted as a command-line argument. For
unattended use, pass a mode-600 file instead:

```bash
sudo deployment-platform reset-admin-password --password-file /root/newpw
```

What it does, in order: backs up `auth.env`, rewrites only the
`ADMIN_PASSWORD_HASH` line (username, `SESSION_SECRET`, `COOKIE_SECURE`,
and `CREDENTIAL_ENCRYPTION_KEY` are copied through verbatim), atomically
replaces the file at mode 600, **recreates** the API container, and
verifies that the API starts and that the login handler rejects a wrong
password. Any failure restores the previous `auth.env` and container.

The container is recreated rather than restarted on purpose: `docker
create --env-file` reads the file once, at creation time, so a restarted
container would keep serving the old hash. Neither the password nor the
hash is ever printed or logged.

## Logs

```
/opt/deployment-platform/logs/installer.log
```

Timestamped, stage-labeled, secret-redacted (a defense-in-depth regex
pass strips anything that looks like a password/secret/token/key value
even though every caller is already expected to only log sanitized
text), and bounded to 10 MB with single-file rotation.

## Backups

Enabled by default (14 daily backups, configurable via
`--backup-retention`). A backup is taken automatically before any
migration run against an *existing* database, and on demand:

```bash
deployment-platform backup-database
```

Backups live at `/opt/deployment-platform/backups/` and inside the
`deployment-platform-api-data` Docker volume — never deleted by this
installer, including during uninstall.

## Uninstall

Preview first — this never changes anything:

```bash
sudo ./installer/install.sh --uninstall-preview
```

Default uninstall removes only what this installer is solely
responsible for (its containers, unused networks, its own built
images, its own Caddy config, its own source releases) and **preserves**
the database volume, secrets, deployed app containers, and app
volumes. Each of those requires its own explicit flag:

```bash
sudo ./installer/install.sh --uninstall \
  [--delete-platform-data] [--delete-app-containers] \
  [--delete-app-volumes] [--delete-secrets]
```

`--purge-all` implies all four and additionally requires typing
`DELETE EVERYTHING` at an interactive prompt, or passing
`--confirm-purge` in non-interactive mode.

## Troubleshooting

- **"Docker daemon is not reachable"** — `systemctl status docker`;
  the installer will not attempt to force-reinstall over a broken
  Docker installation.
- **Public verification fails after DNS looks correct** — TLS
  certificate issuance can take a minute or two after DNS first
  resolves; re-run `deployment-platform verify`.
- **"already exists but was built from a different source commit"** —
  the installer refuses to silently overwrite an immutable image tag;
  remove it deliberately (`docker rmi <tag>`) if a rebuild is truly
  intended.
- **Lost the administrator password** — there is no recovery path in
  this release beyond regenerating `auth.env`, which also rotates
  `CREDENTIAL_ENCRYPTION_KEY` and makes any already-stored provider
  credentials unreadable. Treat the administrator password like any
  other production secret.

## Known limitations

- ARM is not supported in this release.
- No automatic DNS-provider integration — DNS records are always
  created by the operator, by hand, as instructed.
- No zero-downtime cross-server migration (see below).
- `deployment-platform update` is not implemented yet — this installer
  is the first-install path only; use the existing `release.sh` for
  ongoing releases against an already-installed server.
- Non-interactive `--admin-password-file` still requires the operator
  to create that file themselves with safe permissions; the installer
  does not manage its lifecycle beyond reading and then never
  persisting its plaintext contents.

## Migration roadmap (not implemented in this milestone)

This installer deliberately organizes state so a *future* migration
command can move a full installation from one VPS to another without
reinventing where things live:

| What | Where |
|---|---|
| Database + backups | `deployment-platform-api-data` Docker volume, `/opt/deployment-platform/backups/` |
| Secrets/config | `/opt/deployment-platform/config/` |
| Source releases | `/opt/deployment-platform/source/releases/`, `source/current` |
| Caddy routes | `/opt/deployment-platform/caddy/routes/` |
| Docker volume names | `deployment-platform-api-data` (platform), app volumes labeled `com.deployment-platform.managed=true` |
| App-source metadata | Inside the SQLite database (`app_sources` table) |
| Provider credentials | Encrypted in the database, decryptable only with the *same* `CREDENTIAL_ENCRYPTION_KEY` — this is why the key is never silently rotated |

Two subcommands are reserved but intentionally **not implemented** —
running them prints a clear "not available yet" message rather than
attempting anything that could risk data loss:

```
deployment-platform migrate export
deployment-platform migrate import
```

## Exact fresh-VPS walkthrough

```bash
ssh root@203.0.113.10

curl -fsSL --connect-timeout 10 --max-time 60 \
  https://example.com/install.sh -o install.sh
less install.sh
sudo bash install.sh

# Answer the prompts: panel domain, apps domain, admin username/password,
# source method, backups.

# If DNS isn't ready yet, the installer exits and tells you the exact
# records to create. Once they're live:
sudo ./installer/install.sh --resume

# Once complete:
deployment-platform verify
```
