# Retrieval probe: retrieval-v3

Targeted retrieval: ON, v3. No enrichment (OSV, deps.dev, Scorecard). Sequential.

## kubernetes/kubernetes @ d8eb59f9cbf5051df9092bac2926a0634a120eb2

- time 122057 ms, 212 HTTP requests
- tree: targeted, complete=false, reason=response_too_large, github_truncated=false, tree requests=151, nodes=1942, directories listed=149, unread=501, stopped_by=request_budget, failed=0
- coverage: manifest=targeted, lockfile=targeted, sbom=targeted, ci=targeted, build_config=targeted, source=sampled, documentation=partial, release_metadata=complete
- recovered: 1 manifests (single_package), 0 workflows, 0 build projects, 1 execution hooks, 250 dependencies; source scan 9% / 42 files
- identity v2 primary: cli (0.5)
- first unread: pkg/api/job, pkg/api/legacyscheme, pkg/api/node, pkg/api/persistentvolume, pkg/api/persistentvolumeclaim, pkg/api/pod, pkg/api/resourceclaimspec, pkg/api/service, pkg/api/servicecidr, pkg/api/storage

## apache/flink @ 12b0ecfef57524ccfef8398f03bfef4110b98ce8

- time 78609 ms, 247 HTTP requests
- tree: targeted, complete=false, reason=response_too_large, github_truncated=false, tree requests=174, nodes=691, directories listed=148, unread=165, stopped_by=request_budget, failed=0
- coverage: manifest=targeted, lockfile=targeted, sbom=targeted, ci=targeted, build_config=targeted, source=sampled, documentation=partial, release_metadata=complete
- recovered: 10 manifests (multi_module), 10 workflows, 11 build projects, 6 execution hooks, 64 dependencies; source scan 32% / 60 files
- identity v2 primary: library (0.53)
- first unread: flink-metrics/flink-metrics-dropwizard, flink-metrics/flink-metrics-graphite, flink-metrics/flink-metrics-influxdb, flink-metrics/flink-metrics-jmx, flink-metrics/flink-metrics-otel, flink-metrics/flink-metrics-prometheus, flink-metrics/flink-metrics-slf4j, flink-metrics/flink-metrics-statsd, flink-models/flink-model-openai, flink-models/flink-model-triton

## torvalds/linux @ 24a19b953e2a3d0ea5a8c4951a0ab8f32720c907

- time 124267 ms, 227 HTTP requests
- tree: targeted, complete=false, reason=response_too_large, github_truncated=false, tree requests=174, nodes=16730, directories listed=138, unread=731, stopped_by=request_budget, failed=0
- coverage: manifest=targeted, lockfile=targeted, sbom=targeted, ci=targeted, build_config=targeted, source=sampled, documentation=partial, release_metadata=complete
- recovered: 0 manifests (unknown), 0 workflows, 0 build projects, 21 execution hooks, 0 dependencies; source scan 0% / 40 files
- identity v2 primary: unknown (0.15)
- first unread: drivers/sbus, drivers/scsi, drivers/sh, drivers/siox, drivers/slimbus, drivers/soc, drivers/soundwire, drivers/spi, drivers/spmi, drivers/ssb

## NixOS/nixpkgs @ 4f95d613a03654375c3d2dfed4923a17c6dde0a1

- time 67956 ms, 192 HTTP requests
- tree: targeted, complete=false, reason=response_too_large, github_truncated=false, tree requests=114, nodes=2306, directories listed=114, unread=1273, stopped_by=request_budget, failed=0
- coverage: manifest=targeted, lockfile=targeted, sbom=targeted, ci=targeted, build_config=targeted, source=sampled, documentation=partial, release_metadata=complete
- recovered: 1 manifests (single_package), 17 workflows, 0 build projects, 0 execution hooks, 7 dependencies; source scan 55% / 58 files
- identity v2 primary: unknown (0.15)
- first unread: pkgs/build-support/fetchbzr, pkgs/build-support/fetchcodeberg, pkgs/build-support/fetchcvs, pkgs/build-support/fetchdarcs, pkgs/build-support/fetchdebianpatch, pkgs/build-support/fetchdocker, pkgs/build-support/fetchfirefoxaddon, pkgs/build-support/fetchfossil, pkgs/build-support/fetchgit, pkgs/build-support/fetchgitea

