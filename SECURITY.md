# Security policy

dbms-tool holds database credentials and connects to production systems, so security reports are
taken seriously and handled before feature work.

## Supported versions

Only the latest release receives fixes. Installed apps update themselves, so a fix ships to
everyone as a new release.

## Reporting a vulnerability

**Please don't open a public issue.** Report privately through GitHub:
[Security → Report a vulnerability](https://github.com/asofianidis/dbms-tool/security/advisories/new).

Include what you found, how to reproduce it, the version and OS, and the impact you expect. You
can expect an acknowledgement within a few days and a fix or a plan within 30 days for confirmed
issues. Once a fix is released, the advisory is published and you're credited unless you'd rather
not be.

dbms-tool is a free, volunteer-maintained project and has no bug bounty.

## Scope

In scope:

- The desktop app (the Tauri backend in `src-tauri/` and the frontend in `src/`), for example
  credential leaks, the webview escaping its capabilities, read-only connections that can write,
  or SSH host-key checks that can be bypassed.
- The release and update pipeline: anything that could get an unsigned or tampered build to
  users, including `scripts/install-mac.sh`.

Out of scope:

- Scripts you choose to run yourself in the query or Mongo shell editors, which run with the
  permissions of the connection you opened.
- Vulnerabilities in the database servers, cloud CLIs or third-party services the app talks to.
  Report those upstream.

## Verifying downloads

Every release file is listed in `SHA256SUMS.txt` and has a GitHub build-provenance attestation:

```sh
gh attestation verify <file> --repo asofianidis/dbms-tool
```

Updates are signed, and the app verifies the signature before installing them.
