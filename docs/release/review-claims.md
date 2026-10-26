# Public claims review packet

Each claim below needs a human checkbox before publication.

| Approve/edit | Claim | Evidence |
| --- | --- | --- |
| [x] | “Evidence-driven repository and software supply-chain intelligence for GitHub repositories.” | README; `src/analyze.ts`; CLI help |
| [x] | “static and read-only” | README; AGENTS invariants; no execution paths |
| [x] | “Unknown and incomplete coverage are reported explicitly.” | report schema, facts, failure tests |
| [x] | “Experimental / Preview” | README and release notes |
| [x] | “No telemetry collector or analytics endpoint” | `src/util/http.ts` allowlist and network-path audit |
| [x] | “Scores are not probabilities of safety or malware probabilities; compliance output is indicative and not legal advice.” | README Limitations; release notes |
| [x] | “Not observed means not observed within the analyzed coverage; it does not mean absent.” | README Limitations; docs/limitations.md |
| [x] | “Calibration labels are AI-assisted and not independently human-reviewed.” | README; release notes; gate 14 stays MANUAL |
| [x] | “Dependency history is optional, experimental and can be API-expensive.” | README; release notes; docs/public-contract.md |

Reviewer: shadowhunter67 (maintainer; approval recorded on the maintainer's written instruction)  Date: 2026-10-26
Notes: wording checked by the AI assistant (Claude Code) against the forbidden-claims list (safe, malware-free, certified, fully compliant, production ready, enterprise ready, accuracy percentages); none present. This is not an independent human review.
