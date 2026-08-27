# Deployment Platform macOS Installer

This is the downloadable Mac app for installing and managing Deployment
Platform on a fresh or existing Ubuntu VPS.

The app asks for:

- VPS IP or hostname
- SSH username and password
- panel domain
- apps base domain
- Deployment Platform admin username and password
- source GitHub repository and branch/tag

It SSHes into the VPS, clones the configured source repository, runs the
existing non-interactive installer, and optionally installs a systemd timer that
checks the same repository/ref for updates every 30 minutes. After install it
saves a non-secret local server profile and becomes a lightweight manager for
status, updates, logs, verification, restarts, and uninstall preview/execution.

The install path is intentionally non-destructive. It does not run uninstall
commands and does not delete existing platform data, deployed app containers,
app volumes, or secrets. Removing a profile from the Mac app only removes local
metadata.

Build the app and DMG:

```bash
cd macos-installer
npm install
npm run dmg
```

The DMG is written to:

```text
macos-installer/dist/Deployment Platform Installer.dmg
```
