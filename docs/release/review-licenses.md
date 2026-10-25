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
