# Releasing

Releases are built by [`.github/workflows/release.yml`](../.github/workflows/release.yml):

| Trigger | Version |
| --- | --- |
| Push to `main` that touches the app | Base version in `src-tauri/tauri.conf.json`, patch + workflow run number (e.g. `0.1.0` → `0.1.37`) |
| Push a tag `vX.Y.Z` | `X.Y.Z` |
| Manual run (Actions → release → Run workflow) | Same as a push to `main` |

Bumping the base version by hand (say to `0.2.0`) releases exactly that version on the next push.

Each release runs the full CI suite first (including the live database tests), then builds:

| Platform | Runner | Bundles |
| --- | --- | --- |
| Windows x64 | `windows-latest` | NSIS `-setup.exe`, MSI |
| macOS universal (Apple Silicon + Intel) | `macos-latest` | `.dmg`, `.app.tar.gz` (updater) |
| Linux x64 | `ubuntu-22.04` | AppImage, `.deb`, `.rpm` |
| Linux arm64 | `ubuntu-22.04-arm` | AppImage, `.deb`, `.rpm` |

The release stays a draft until every platform has uploaded. The publish job then adds
`SHA256SUMS.txt`, a build-provenance attestation for every file, and `latest.json` for the
auto-updater, and only then makes the release public.

## Secrets

Add these under **Settings → Secrets and variables → Actions** in the GitHub repository.

### Required: update signing

The auto-updater only installs bundles signed with this key. Its public half is in
`src-tauri/tauri.conf.json` (`plugins.updater.pubkey`).

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of `~/.tauri/dbms-tool.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The key's password |

Back the key up in your password manager. **If it's lost, installed copies can no longer update**:
you would have to ship a new public key and users would reinstall once.

To rotate the password or the key:

```sh
pnpm tauri signer generate -w ~/.tauri/dbms-tool.key --force
# then copy the new ~/.tauri/dbms-tool.key.pub into tauri.conf.json → plugins.updater.pubkey
```

### macOS: Developer ID signing and notarization (optional)

Without these, macOS builds are unsigned, and Gatekeeper asks users who downloaded the `.dmg` in a
browser to approve the app in System Settings → Privacy & Security on first launch.
`scripts/install-mac.sh` (see the README's install section) avoids that prompt. It reads the
release marked Latest and installs its `*_universal.app.tar.gz`. You need an
[Apple Developer Program](https://developer.apple.com/programs/) membership.

1. In Xcode or the developer portal create a **Developer ID Application** certificate and export
   it from Keychain Access as a `.p12` with a password.
2. Create an [app-specific password](https://support.apple.com/102654) for your Apple ID.

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | `base64 -i certificate.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | The `.p12` export password |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | Your Apple ID email |
| `APPLE_PASSWORD` | The app-specific password |
| `APPLE_TEAM_ID` | Your 10-character team ID |

### Windows: Azure Trusted Signing (optional)

Without these, Windows builds are unsigned and SmartScreen warns on first download.
[Azure Trusted Signing](https://learn.microsoft.com/azure/trusted-signing/) is Microsoft's
low-cost signing service (a few dollars a month); signatures build SmartScreen reputation.

1. Create a Trusted Signing account and a **public trust** certificate profile, and complete
   identity validation.
2. Create an app registration (service principal) and give it the
   *Trusted Signing Certificate Profile Signer* role on the account.

| Secret | Value |
| --- | --- |
| `AZURE_CLIENT_ID` | App registration client ID |
| `AZURE_CLIENT_SECRET` | App registration client secret |
| `AZURE_TENANT_ID` | Directory (tenant) ID |
| `AZURE_SIGNING_ENDPOINT` | e.g. `https://eus.codesigning.azure.net` |
| `AZURE_SIGNING_ACCOUNT` | Trusted Signing account name |
| `AZURE_CERTIFICATE_PROFILE` | Certificate profile name |

Free alternative for open-source projects: [SignPath Foundation](https://signpath.org/).

### Linux

Linux packages aren't code signed by convention; downloads are verified through
`SHA256SUMS.txt` and the build-provenance attestations. AppImage updates are signed with the
update key above.

## Verifying a download

```sh
gh attestation verify dbms-tool_0.1.37_x64-setup.exe --repo asofianidis/dbms-tool
sha256sum -c SHA256SUMS.txt --ignore-missing
```

## Auto-update behaviour

- Installed apps check `releases/latest/download/latest.json` shortly after launch and every
  six hours (Settings → Updates, on by default), download in the background and verify the
  signature.
- Installing waits for the user: a **Restart to update** button appears in the title bar.
- Windows (NSIS and MSI), macOS and Linux AppImage update in place. `.deb` and `.rpm` installs
  show a link to the release page instead.
