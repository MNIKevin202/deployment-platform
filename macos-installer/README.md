# Deployment Platform macOS Installer

This is the downloadable Mac app for installing Deployment Platform on a fresh
or existing Ubuntu VPS.

The app asks for:

- VPS IP or hostname
- SSH username and password
- panel domain
- apps base domain
- Deployment Platform admin username and password
- source GitHub repository and branch/tag

It SSHes into the VPS, clones the configured source repository, runs the
existing non-interactive installer, and optionally installs a systemd timer that
checks the same repository/ref for updates every 30 minutes.

The install path is intentionally non-destructive. It does not run uninstall
commands and does not delete existing platform data, deployed app containers,
app volumes, or secrets.

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
