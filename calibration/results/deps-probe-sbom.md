# Dependency probe: deps-probe-sbom

Build: .\dist. Real repositories at their calibration-pinned commits; live OSV and deps.dev. A probe, not a calibration metric.

| repo | commit | ms | req | discovered | direct | direct registry | exact | unresolved | direct checked | checked (all) | vulnerable | osv coverage | vuln rule | lockfiles | SBOM | deps.dev | conflicts | warnings |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mongodb/node-mongodb-native | 16136bb34b | 2799 | 11 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | not_observed (unavailable) | - | - | not_needed/0+0 | 0 | too_large,too_large |
| mongodb/mongo-go-driver | b4b4372ff0 | 14861 | 84 | 51 | 9 | 9 | 9 | 0 | 9 | 40 | 4 | 1 | scored 0 | go.sum(67) go.sum(34) | CycloneDX:parsed unable_to_compare | ok/17+0 | 0 | too_large |
| mongodb/mongo-python-driver | 1f64ecdd51 | 26662 | 79 | 92 | 14 | 14 | 12 | 2 | 12 | 90 | 0 | 0.857 | scored 10 | uv.lock(90) | CycloneDX:parsed consistent | ok/12+0 | 0 | too_large |
| mongodb/mongo-tools | 4e71d0c442 | 9848 | 83 | 70 | 26 | 26 | 26 | 0 | 26 | 70 | 3 | 1 | scored 5 | go.sum(115) | CycloneDX:parsed partial | ok/26+0 | 0 | - |
| ruby/ruby.wasm | 58a51e12b1 | 9217 | 77 | 612 | 13 | 12 | 12 | 0 | 12 | 611 | 28 | 1 | scored 5 | Cargo.lock(350) package-lock.json(266) | SPDX:parsed unable_to_compare | ok/11+0 | 0 | too_large |
| onnx/onnx | 23e5394092 | 8590 | 76 | 7 | 7 | 7 | 1 | 6 | 1 | 1 | 1 | 0.143 | scored 0 | - | CycloneDX:unsupported | ok/1+0 | 0 | - |
| google/brotli | 392b261deb | 7261 | 66 | 1 | 1 | 1 | 0 | 1 | 0 | 0 | 0 | - | not_observed (not_reported) | - | CycloneDX:parsed partial | ok/0+1 | 0 | too_large |
| jrsoftware/issrc | b9a17b6b25 | 6669 | 59 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | not_observed (not_reported) | - | SPDX:parsed unable_to_compare | not_needed/0+0 | 0 | - |
