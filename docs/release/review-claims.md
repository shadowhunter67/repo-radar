# Public claims review packet

Each claim below needs a human checkbox before publication.

| Approve/edit | Claim | Evidence |
| --- | --- | --- |
| [ ] | “Evidence-driven repository and software supply-chain intelligence for GitHub repositories.” | README; `src/analyze.ts`; CLI help |
| [ ] | “static and read-only” | README; AGENTS invariants; no execution paths |
| [ ] | “Unknown and incomplete coverage are reported explicitly.” | report schema, facts, failure tests |
| [ ] | “Experimental / Preview” | README and release notes |
| [ ] | “No telemetry collector or analytics endpoint” | `src/util/http.ts` allowlist and network-path audit |

Reviewer: ____________________  Date: __________  Notes: ____________________
