# Technical license inventory

This is an offline technical inventory from installed `node_modules` package metadata, generated with `node scripts/license-inventory.mjs`. Categories are labels for review, not legal conclusions. Human/legal review required before distribution.

| Package | Version | License field | Category |
| --- | --- | --- | --- |
| openpgp | 6.3.2 | LGPL-3.0+ | strong-copyleft |
| sigstore | 4.1.1 | Apache-2.0 | permissive |
| smol-toml | 1.9.1 | BSD-3-Clause | permissive |
| yaml | 2.9.1 | ISC | permissive |
| zod | 4.6.7 | MIT | permissive |

The exact machine-readable inventory is produced locally from the installed dependency metadata; it is intentionally not a legal conclusion. Sigstore remains pinned at 4.1.1, the maintained version required by the security policy.

**Human/legal review required.**

`openpgp` is a production dependency and is bundled into the Action single-file
bundle by the current esbuild configuration; the npm package also lists it as a
runtime dependency. This is a factual packaging observation, not a legal
conclusion. No separate third-party notice file was generated because the
installed production inventory did not identify a NOTICE obligation.
