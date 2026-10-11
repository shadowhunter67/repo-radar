# Retrieval probe: retrieval-probe-v2

Targeted retrieval: on. No enrichment (OSV, deps.dev, Scorecard). Sequential.

## kubernetes/kubernetes @ 137705d1d2709dbe645e26a5541827eec8c174f7

- time 77017 ms, 152 HTTP requests
- tree: targeted, complete=false, reason=response_too_large, github_truncated=false, tree requests=90, nodes=1322, directories listed=89, unread=306, stopped_by=request_budget, failed=0
- coverage: manifest=targeted, lockfile=targeted, sbom=targeted, ci=targeted, build_config=targeted, source=sampled, documentation=partial, release_metadata=complete
- recovered: 1 manifests (single_package), 0 workflows, 0 build projects, 1 execution hooks, 250 dependencies; source scan 10% / 42 files
- identity v2 primary: cli (0.5)
- first unread: pkg/registry/core, pkg/scheduler/backend, api/openapi-spec/v3, cluster/addons/addon-manager, cluster/addons/calico-policy-controller, cluster/addons/cloud-controller-manager, cluster/addons/cluster-loadbalancing, cluster/addons/dns, cluster/addons/dns-horizontal-autoscaler, cluster/addons/fluentd-gcp

## torvalds/linux @ a5ebb76233b79db01e82e061173cb73c6d2b5c6b

- time 70514 ms, 143 HTTP requests
- tree: targeted, complete=false, reason=response_too_large, github_truncated=false, tree requests=90, nodes=14474, directories listed=90, unread=731, stopped_by=request_budget, failed=0
- coverage: manifest=targeted, lockfile=targeted, sbom=targeted, ci=targeted, build_config=targeted, source=sampled, documentation=partial, release_metadata=complete
- recovered: 0 manifests (unknown), 0 workflows, 0 build projects, 20 execution hooks, 0 dependencies; source scan 0% / 40 files
- identity v2 primary: unknown (0.15)
- first unread: fs/iomap, fs/isofs, fs/jbd2, fs/jffs2, fs/jfs, fs/kernfs, fs/lockd, fs/minix, fs/netfs, fs/nfs

## NixOS/nixpkgs @ 8d7b945e0ce1d948f85c99a5e11414bc82186036

- time 56064 ms, 161 HTTP requests
- tree: targeted, complete=false, reason=response_too_large, github_truncated=false, tree requests=90, nodes=2305, directories listed=90, unread=1298, stopped_by=request_budget, failed=0
- coverage: manifest=targeted, lockfile=targeted, sbom=targeted, ci=targeted, build_config=targeted, source=sampled, documentation=partial, release_metadata=complete
- recovered: 1 manifests (single_package), 17 workflows, 0 build projects, 0 execution hooks, 7 dependencies; source scan 55% / 58 files
- identity v2 primary: unknown (0.15)
- first unread: pkgs/applications/version-management, pkgs/applications/video, pkgs/applications/virtualization, pkgs/applications/window-managers, pkgs/build-support/agda, pkgs/build-support/appimage, pkgs/build-support/binary-cache, pkgs/build-support/bintools-wrapper, pkgs/build-support/build-bazel-package, pkgs/build-support/build-fhsenv-bubblewrap

## apache/flink @ fed133939df542016dbbb0e892a11eacbf9b93ae

- time 47270 ms, 163 HTTP requests
- tree: targeted, complete=false, reason=response_too_large, github_truncated=false, tree requests=90, nodes=492, directories listed=74, unread=170, stopped_by=request_budget, failed=0
- coverage: manifest=targeted, lockfile=targeted, sbom=targeted, ci=targeted, build_config=targeted, source=sampled, documentation=partial, release_metadata=complete
- recovered: 10 manifests (multi_module), 10 workflows, 11 build projects, 7 execution hooks, 64 dependencies; source scan 76% / 60 files
- identity v2 primary: library (0.53)
- first unread: flink-end-to-end-tests/flink-queryable-state-test, flink-end-to-end-tests/flink-quickstart-test, flink-end-to-end-tests/flink-quickstart-test-dummy-dependency, flink-end-to-end-tests/flink-rocksdb-state-memory-control-test, flink-end-to-end-tests/flink-sql-client-test, flink-end-to-end-tests/flink-state-evolution-test, flink-end-to-end-tests/flink-stream-sql-test, flink-end-to-end-tests/flink-stream-state-ttl-test, flink-end-to-end-tests/flink-stream-stateful-job-upgrade-test, flink-end-to-end-tests/flink-tpcds-test

## astral-sh/ruff @ a5aee680b11d2190fbb6a72008047ae281dd2d18

- time 12642 ms, 99 HTTP requests
- tree: recursive, complete=true, reason=none, github_truncated=false, tree requests=1, nodes=12136, directories listed=0, unread=0, stopped_by=complete, failed=0
- coverage: manifest=complete, lockfile=complete, sbom=complete, ci=complete, build_config=complete, source=sampled, documentation=complete, release_metadata=complete
- recovered: 10 manifests (mixed), 23 workflows, 1 build projects, 3 execution hooks, 1081 dependencies; source scan 1% / 70 files
- identity v2 primary: cli (0.52)

## django/django @ dab0a5c47f159eb58472110dcbc10bd4a9b01adb

- time 8126 ms, 70 HTTP requests
- tree: recursive, complete=true, reason=none, github_truncated=false, tree requests=1, nodes=10356, directories listed=0, unread=0, stopped_by=complete, failed=0
- coverage: manifest=complete, lockfile=complete, sbom=complete, ci=complete, build_config=complete, source=sampled, documentation=complete, release_metadata=complete
- recovered: 2 manifests (workspace), 16 workflows, 1 build projects, 2 execution hooks, 16 dependencies; source scan 4% / 59 files
- identity v2 primary: unknown (0.15)

## mongodb/node-mongodb-native @ 16136bb34b10c48eba2a9092d6a4d27edbb10ab2

- time 10900 ms, 73 HTTP requests
- tree: recursive, complete=true, reason=none, github_truncated=false, tree requests=1, nodes=30308, directories listed=0, unread=0, stopped_by=complete, failed=0
- coverage: manifest=complete, lockfile=complete, sbom=complete, ci=complete, build_config=complete, source=sampled, documentation=complete, release_metadata=complete
- recovered: 1 manifests (single_package), 12 workflows, 0 build projects, 1 execution hooks, 692 dependencies; source scan 19% / 54 files
- identity v2 primary: library (0.48)

