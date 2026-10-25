# License review packet

`LICENSE` begins with the Apache License, Version 2.0, and `package.json` declares
Apache-2.0. The generated inventory from `scripts/license-inventory.mjs` is the
source of dependency names, versions, and license fields; it must be regenerated in
the release environment and reviewed by a person. No legal conclusion is made here.

`openpgp` is LGPL-3.0-or-later and is imported lazily for user-supplied OpenPGP
verification. The Action bundle must be inspected to determine whether that code is
included in the single-file bundle; this packet does not infer licensing treatment
from source imports alone. Review whether bundled dependencies require attribution,
NOTICE files, or license texts, including Apache/MIT/BSD items. If required,
generate notices from the inventory and package them; do not hand-author legal text.

Human questions: Is the dependency inventory complete? Does bundling alter the
licensing analysis? Are all required attributions shipped? Is LGPL use acceptable?

Reviewer: ____________________  Date: __________  LEGAL REVIEW REQUIRED: [ ]
## OpenPGP Action-bundle question — LEGAL REVIEW REQUIRED

The production npm package lists `openpgp` 6.3.2 as an external runtime
dependency. The current esbuild Action output bundles it into the single
`dist/action/repo-radar.mjs` file; inspection found 104 textual references and
the bundle is approximately 4.7 MB. This is a packaging observation, not a
legal conclusion.

A maintainer must decide whether to keep bundling and satisfy the applicable
requirements, make OpenPGP external/lazily fetched so the Action does not bundle
it, or ship the Action with an unbundled `node_modules` layout. The preview policy
records `legal_review_openpgp_action_bundle: "pending"`; no decision has been
made.
