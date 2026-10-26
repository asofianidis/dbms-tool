# Local patches to winauth 0.0.5

Vendored from crates.io (MIT / Apache-2.0) because the published crate depends on rand 0.7, which
is affected by RUSTSEC-2026-0097 and has no fixed 0.7 release. Changes:

- `rand` 0.7 → 0.8.6 (the only API used is `thread_rng().fill_bytes`, unchanged in 0.8).
- Dropped the dev-dependencies, which are only used by the upstream examples.

Everything else is unchanged from the published crate.
