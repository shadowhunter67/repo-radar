# Trust probe: trust-probe-v2

Sigstore public-good trust root via the library's TUF client. Time 2026-10-11T11:30:25.247Z. Sequential.

## sharkdp/fd @ 14dcd92fb76ca0ebc2e82671a275f67c790d25fc

- 25690 ms, release requests 6
- release v10.5.0 (2026-08-26), tag lightweight 4f81778774; tag signature: none
- attestations listed 3, readable 3: verified [sigstore_public_good; sharkdp/fd; certificate chain, signature and transparency-log evidence accepted] | verified [sigstore_public_good; sharkdp/fd; certificate chain, signature and transparency-log evidence accepted] | verified [sigstore_public_good; sharkdp/fd; certificate chain, signature and transparency-log evidence accepted]
- correspondence **verified_source_binding**; slsa observations {"provenance_present":true,"provenance_verified":true,"builder_identified":true,"source_revision_bound":true,"subject_digest_bound":true,"build_service_identified":true,"mapped_level":null}
- limit: tags resolved for 3 of 30 releases

## goreleaser/goreleaser @ ccaac66e8d36f5ce989ea129314af17bc26e650e

- 34310 ms, release requests 9
- release v2.18.3 (2026-10-09), tag annotated 1942d44355; tag signature: verified via github_api_assertion (local: verification_unavailable)
- attestations listed 4, readable 4: verification_failed [sigstore_public_good; no identity; timestamp could not be verified] | verification_failed [sigstore_public_good; no identity; timestamp could not be verified] | verified [sigstore_public_good; goreleaser/goreleaser; certificate chain, signature and transparency-log evidence accepted] | verification_failed [sigstore_public_good; no identity; timestamp could not be verified]
- correspondence **verified_source_binding**; slsa observations {"provenance_present":true,"provenance_verified":true,"builder_identified":true,"source_revision_bound":true,"subject_digest_bound":true,"build_service_identified":true,"mapped_level":null}
- limit: tags resolved for 3 of 30 releases

