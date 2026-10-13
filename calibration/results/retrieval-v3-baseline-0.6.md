# Retrieval probe: retrieval-v3-baseline-0.6

Targeted retrieval: ON, 0.6 behaviour (no declared-path pool, no manifest seeking). No enrichment (OSV, deps.dev, Scorecard). Sequential.

## kubernetes/kubernetes @ d8eb59f9cbf5051df9092bac2926a0634a120eb2

- time 48475 ms, 151 HTTP requests
- tree: targeted, complete=false, reason=response_too_large, github_truncated=false, tree requests=90, nodes=1413, directories listed=88, unread=311, stopped_by=request_budget, failed=0
- coverage: manifest=targeted, lockfile=targeted, sbom=targeted, ci=targeted, build_config=targeted, source=sampled, documentation=partial, release_metadata=complete
- recovered: 1 manifests (single_package), 0 workflows, 0 build projects, 1 execution hooks, 250 dependencies; source scan 14% / 42 files
- identity v2 primary: cli (0.5)
- first unread: pkg/cluster, pkg/controller, pkg/controlplane, pkg/credentialprovider, pkg/features, pkg/fieldpath, pkg/kubeapiserver, pkg/kubectl, pkg/kubelet, pkg/printers

## apache/flink @ 12b0ecfef57524ccfef8398f03bfef4110b98ce8

- time 37399 ms, 163 HTTP requests
- tree: targeted, complete=false, reason=response_too_large, github_truncated=false, tree requests=90, nodes=492, directories listed=74, unread=170, stopped_by=request_budget, failed=0
- coverage: manifest=targeted, lockfile=targeted, sbom=targeted, ci=targeted, build_config=targeted, source=sampled, documentation=partial, release_metadata=complete
- recovered: 10 manifests (multi_module), 10 workflows, 11 build projects, 7 execution hooks, 64 dependencies; source scan 76% / 60 files
- identity v2 primary: library (0.53)
- first unread: flink-end-to-end-tests/flink-queryable-state-test, flink-end-to-end-tests/flink-quickstart-test, flink-end-to-end-tests/flink-quickstart-test-dummy-dependency, flink-end-to-end-tests/flink-rocksdb-state-memory-control-test, flink-end-to-end-tests/flink-sql-client-test, flink-end-to-end-tests/flink-state-evolution-test, flink-end-to-end-tests/flink-stream-sql-test, flink-end-to-end-tests/flink-stream-state-ttl-test, flink-end-to-end-tests/flink-stream-stateful-job-upgrade-test, flink-end-to-end-tests/flink-tpcds-test

## torvalds/linux @ 24a19b953e2a3d0ea5a8c4951a0ab8f32720c907

- time 86496 ms, 143 HTTP requests
- tree: targeted, complete=false, reason=response_too_large, github_truncated=false, tree requests=90, nodes=15018, directories listed=74, unread=619, stopped_by=request_budget, failed=0
- coverage: manifest=targeted, lockfile=targeted, sbom=targeted, ci=targeted, build_config=targeted, source=sampled, documentation=partial, release_metadata=complete
- recovered: 0 manifests (unknown), 0 workflows, 0 build projects, 21 execution hooks, 0 dependencies; source scan 0% / 40 files
- identity v2 primary: unknown (0.15)
- first unread: drivers/hte, drivers/hv, drivers/hwmon, drivers/hwspinlock, drivers/i2c, drivers/i3c, drivers/idle, drivers/iio, drivers/infiniband, drivers/input

## NixOS/nixpkgs @ 4f95d613a03654375c3d2dfed4923a17c6dde0a1

- time 58387 ms, 168 HTTP requests
- tree: targeted, complete=false, reason=response_too_large, github_truncated=false, tree requests=90, nodes=2305, directories listed=90, unread=1297, stopped_by=request_budget, failed=0
- coverage: manifest=targeted, lockfile=targeted, sbom=targeted, ci=targeted, build_config=targeted, source=sampled, documentation=partial, release_metadata=complete
- recovered: 1 manifests (single_package), 17 workflows, 0 build projects, 0 execution hooks, 7 dependencies; source scan 55% / 58 files
- identity v2 primary: unknown (0.15)
- first unread: pkgs/applications/version-management, pkgs/applications/video, pkgs/applications/virtualization, pkgs/applications/window-managers, pkgs/build-support/agda, pkgs/build-support/appimage, pkgs/build-support/binary-cache, pkgs/build-support/bintools-wrapper, pkgs/build-support/build-bazel-package, pkgs/build-support/build-fhsenv-bubblewrap

