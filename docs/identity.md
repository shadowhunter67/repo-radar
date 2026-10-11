# Identity v2

`identity_v2` describes WHAT a repository is on several independent axes instead of one class label. The flat `identity` (artifact type, domain, purpose sentence) is kept for compatibility.

| Axis | Values |
| ---- | ------ |
| primary artifact | library, cli, application, service, framework, plugin, extension, sdk, driver, infrastructure, dataset, model, documentation, template, tooling, container, unknown |
| secondary roles | library_api, cli_interface, service_component, plugin_host, plugin, workspace_root, developer_tool, ... |
| packaging | single_package, workspace, multi_package, monorepo, multi_module, mixed, unknown |
| interfaces | cli, library_api, http_server, rpc, gui, plugin_interface, build_interface, package_manager_hook, container_entrypoint, background_service |
| deployment form | local_executable, library_dependency, server_service, container, ci_action, ... plus `supported` forms |

A workspace is a packaging fact, never an identity: a Cargo workspace of crates is not "a monorepo" product. A Dockerfile is a deployment form (`deployment_form.supported: [container]`), not an identity: `container` is the primary artifact only when the repository has a Dockerfile and no code or manifest at all.

## Evidence hierarchy (`src/identity/signals.ts`, `src/identity/v2.ts`)

- **Strong** (decide): executable targets (`[[bin]]`, `src/bin/*/main.rs`, Go `package main`, CMake `add_executable`, native `main.c`), package bin entries, server bootstrap (`ListenAndServe`, `createServer`, `uvicorn.run`, `HttpServer::new`...), extension-point vocabulary (routing, middleware, plugin, hooks, bootstrap) used together with a server bootstrap in a PUBLISHED package (a framework is reusable; an application that merely uses the words is not), plugin contracts, Docker `ENTRYPOINT`/`CMD` of a program without an executable target, conventional native entry files (`*-server.c`, `*-cli.c`).
- **Weak** (tie-break only, capped at 1.5): a bare Dockerfile, the keyword hint of the legacy classifier. A candidate supported by weak evidence alone is never `clear`; with no strong evidence the answer is `unknown`.
- **Never used**: the repository name, README prose, topics.

Status of the primary artifact: `clear` (a lead over the runner-up), `ambiguous` (close candidates; alternatives are listed with their own confidence) or `unknown` (an abstention). Confidence stays `heuristic_uncalibrated`.

## Measured accuracy (and what it does not show)

| Corpus | Role | Primary artifact (overall / answered) | Packaging | Notes |
| ------ | ---- | ------------------------------------- | --------- | ----- |
| dev + validation (35 repos) | tuned on | 86% / 90% dev, 93% / 100% validation | n/a | optimistic: these repositories shaped the rules |
| identity-holdout-0.5 (16) | observed once (previous cycle); NOT used for tuning in this cycle | 63% (legacy 67%) | 92% | the structure-only first version |
| **identity-holdout-0.6 (18)** | fresh, run once after the rules were frozen | **67% / 75%** (legacy single label 50% / 56%), top-2 83%, ECE 0.33 | 80% | 12 correct, 4 wrong, 2 abstained, 4 answered-but-ambiguous; interfaces precision 63% / recall 81%; deployment form 72% |

Known failures on holdout 0.6 (not tuned on): fastapi (framework read as CLI because the framework evidence needs scanned source and the sample missed it), httpie (CLI read as service from a server helper), lodash (no manifest entry shape: unknown), minio (Go service read as CLI: the `main` package is the only strong evidence), nginx (C service without manifest: unknown), traefik (service read as application: UI framework plus server). Labels are one AI-assisted reviewer, so these numbers are upper bounds on how well the labels themselves are known. Human review is still required (release gate 14).
