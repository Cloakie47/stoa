# NOTICE

This package, `@stoa/facilitator`, is a fork of [`@oviato/x402-facilitator-hono`](https://github.com/OviatoHQ/x402-facilitator-hono) by Oviato, licensed under the Apache License, Version 2.0. The original `LICENSE` file is preserved alongside this notice.

Stoa modifications begin from the upstream `main` branch at the commit cloned on 2026-05-14. Substantive changes from upstream are tracked in this package's commit history within the parent Stoa monorepo.

## Why a fork and not a dependency

We need to route the `POST /settle` path through Stoa's on-chain [`Splitter`](../../contracts/src/Splitter.sol) contract so that the verify, split, and settle steps happen atomically within a single x402 facilitator call. The upstream design delegates settlement to scheme handlers (`@x402/core`) that perform direct USDC transfers — we either had to monkey-patch around their `settle()` or fork the routes layer to insert the Splitter call. Forking is the honest path; downstream we plan to land the relevant changes upstream as a PR if there's interest.

## License compatibility

The Stoa monorepo overall is MIT-licensed. This package retains Apache 2.0 in keeping with upstream's license. Apache 2.0 and MIT are compatible — Apache 2.0 code can be included in MIT-licensed projects provided the LICENSE and attribution are preserved. The two coexist within the same monorepo without conflict.

## Attribution

Original work © Oviato, licensed Apache 2.0. See `LICENSE`.
Stoa modifications © Stoa contributors, also licensed Apache 2.0 (this file and any newly-authored code in this package).
