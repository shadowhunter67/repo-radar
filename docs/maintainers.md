# Maintainer notes

Suggested issue labels: `false-positive`, `false-negative`, `identity`, `dependency`,
`history`, `provenance`, and `performance`. Security reports belong in GitHub
private vulnerability reporting, not public issues. Gate 14 and public release
claims require human review.

Dependabot's grouped dev-dependency update currently reports a Vitest 5 upgrade
conflict: `npm i -D vitest@5.0.5` fails with `ERESOLVE` against the installed peer
set. Do not force it during a release. The dev-only advisories for
`@vitest/mocker` (GHSA-82fw-gwwq-j7x9) and the tinypool prototype-pollution/RCE
gadget remain tracked until a compatible Vitest major upgrade is resolved. They
affect test developers, not the published runtime package.
