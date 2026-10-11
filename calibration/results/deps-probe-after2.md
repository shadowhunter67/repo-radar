# Dependency probe: deps-probe-after2

Build: .\dist. Real repositories at their calibration-pinned commits; live OSV and deps.dev. A probe, not a calibration metric.

| repo | commit | ms | req | discovered | direct | direct registry | exact | unresolved | direct checked | checked (all) | vulnerable | osv coverage | vuln rule | lockfiles | SBOM | deps.dev | conflicts | warnings |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pallets/flask | d086db856b | 25684 | 87 | 114 | 61 | 61 | 51 | 10 | 51 | 99 | 7 | 0.836 | scored 3 | uv.lock(79) | - | ok/40+0 | 0 | - |
| trpc/trpc | 796700d865 | 12785 | 116 | 4055 | 284 | 279 | 279 | 0 | 279 | 1000 | 15 | 1 | scored 7 | pnpm-lock.yaml(3912) | - | ok/40+0 | 0 | too_large |
| puppeteer/puppeteer | 0805b622a4 | 10766 | 122 | 2016 | 111 | 111 | 106 | 5 | 106 | 1000 | 5 | 0.955 | scored 7 | package-lock.json(2697) package-lock.json(1401) | - | ok/40+5 | 0 | too_large |
| BurntSushi/ripgrep | 3fce3b5bb0 | 8189 | 97 | 106 | 67 | 51 | 51 | 0 | 51 | 71 | 0 | 1 | scored 10 | Cargo.lock(63) Cargo.lock(21) | - | ok/40+0 | 1 | - |
