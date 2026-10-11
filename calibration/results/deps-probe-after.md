# Dependency probe: deps-probe-after

Build: .\dist. Real repositories at their calibration-pinned commits; live OSV and deps.dev. A probe, not a calibration metric.

| repo | commit | ms | req | discovered | direct | direct registry | exact | unresolved | direct checked | checked (all) | vulnerable | osv coverage | vuln rule | lockfiles | SBOM | deps.dev | conflicts | warnings |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sindresorhus/execa | 63ddae6aeb | 4418 | 78 | 24 | 24 | 24 | 0 | 24 | 0 | 0 | 0 | - | not_observed (not_reported) | - | - | ok/0+24 | 0 | - |
| pallets/flask | d086db856b | 6114 | 85 | 114 | 61 | 61 | 53 | 8 | 53 | 93 | 5 | 0.869 | scored 3 | uv.lock(79) | - | ok/40+0 | 6 | - |
| psf/requests | 611c6162cb | 4354 | 48 | 21 | 21 | 21 | 2 | 19 | 2 | 2 | 0 | 0.095 | not_observed (insufficient_coverage) | - | - | ok/2+0 | 0 | - |
| Textualize/rich | 9d8f9a372c | 5252 | 76 | 54 | 15 | 15 | 14 | 1 | 14 | 53 | 5 | 0.933 | scored 3 | poetry.lock(49) | - | ok/14+0 | 0 | - |
| BurntSushi/ripgrep | 3fce3b5bb0 | 6260 | 93 | 111 | 67 | 51 | 51 | 0 | 51 | 71 | 0 | 1 | scored 10 | Cargo.lock(63) Cargo.lock(21) | - | ok/40+0 | 0 | - |
| sharkdp/fd | 14dcd92fb7 | 5324 | 68 | 130 | 24 | 24 | 24 | 0 | 24 | 130 | 2 | 1 | scored 7 | Cargo.lock(131) | - | ok/24+0 | 0 | - |
| dtolnay/anyhow | 2cbb4e1bcb | 3502 | 34 | 6 | 6 | 5 | 0 | 5 | 0 | 0 | 0 | - | not_observed (not_reported) | - | - | ok/0+5 | 0 | - |
| gitleaks/gitleaks | b58d3f102c | 3821 | 74 | 72 | 16 | 16 | 16 | 0 | 16 | 72 | 4 | 1 | scored 3 | go.sum(344) | - | ok/16+0 | 0 | too_large |
| caddyserver/caddy | c31d9a71ed | 7181 | 103 | 165 | 54 | 54 | 54 | 0 | 54 | 165 | 1 | 1 | scored 7 | go.sum(367) | - | ok/40+0 | 0 | too_large |
| junegunn/fzf | 25adb67453 | 3983 | 70 | 11 | 7 | 7 | 7 | 0 | 7 | 11 | 2 | 1 | scored 0 | go.sum(43) | - | ok/7+0 | 0 | - |
| juice-shop/juice-shop | 0e6d909b74 | 5195 | 107 | 175 | 175 | 175 | 6 | 169 | 6 | 6 | 3 | 0.034 | scored 0 | - | - | ok/6+30 | 0 | - |
| puppeteer/puppeteer | 0805b622a4 | 6914 | 120 | 2016 | 111 | 111 | 110 | 1 | 110 | 1000 | 5 | 0.991 | scored 7 | package-lock.json(2697) package-lock.json(1401) | - | ok/40+1 | 2 | too_large |
| trpc/trpc | 796700d865 | 7521 | 120 | 284 | 284 | 279 | 32 | 247 | 32 | 14 | 0 | 0.115 | not_observed (insufficient_coverage) | - | - | ok/10+30 | 0 | too_large,lockfile_unparsed |
| louislam/uptime-kuma | b61b322c12 | 6686 | 118 | 1187 | 155 | 155 | 155 | 0 | 155 | 1000 | 21 | 1 | scored 5 | package-lock.json(1303) | - | ok/40+0 | 0 | - |
| anchore/syft | 33419c8f39 | 6387 | 104 | 343 | 98 | 98 | 98 | 0 | 98 | 340 | 2 | 1 | scored 7 | go.sum(5) go.sum(1254) | unknown:not_an_sbom unknown:not_an_sbom unknown:not_an_sbom | ok/40+0 | 0 | - |
| expressjs/express | a419aa7350 | 5077 | 66 | 44 | 44 | 44 | 8 | 36 | 8 | 8 | 0 | 0.182 | not_observed (insufficient_coverage) | - | - | ok/8+30 | 0 | - |
| ossf/scorecard | b7acea69f1 | 7053 | 112 | 800 | 53 | 53 | 53 | 0 | 53 | 697 | 7 | 1 | scored 7 | go.sum(1193) go.sum(881) | - | ok/40+0 | 0 | too_large |
