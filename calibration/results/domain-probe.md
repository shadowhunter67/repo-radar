# External domain probe: domain-probe

Run 2026-10-13T15:34:34.615Z. Static extraction only; no observed host was resolved or contacted. A row is a REFERENCE in a file, not a connection.

## puppeteer/puppeteer @ d8e4e363c3

- 7986 ms; scan 14% of source, 64 files read; 18 external hosts (9 in active contexts); filtered {"documentation_example":1}; unparsed 2
- **ci** (4)
  - `chromium.googlesource.com` [generic_external] .github/workflows/devtools.yml:61 conf 0.65
  - `crawler.algolia.com` [generic_external] .github/workflows/docs.yml:120 conf 0.65
  - `github.com` [github] .github/workflows/update-browser-pins.yml:47 conf 0.65
  - `registry.npmjs.org` [registry] .github/workflows/publish.yml:30 conf 0.65
- **runtime** (5)
  - `archive.mozilla.org` [generic_external] packages/browsers/src/browser-data/firefox.ts:83 conf 0.6
  - `googlechromelabs.github.io` [generic_external] packages/browsers/src/browser-data/chrome.ts:77 conf 0.6
  - `pptr.dev` [generic_external] packages/browsers/src/launch.ts:567 conf 0.6
  - `product-details.mozilla.org` [generic_external] packages/browsers/src/browser-data/firefox.ts:167 conf 0.6
  - `storage.googleapis.com` [generic_external] packages/browsers/src/browser-data/chrome-headless-shell.ts:34 conf 0.6
- **comment** (9)
  - `angular.io` [generic_external] tools/third_party/validate-licenses.ts:3 conf 0.1
  - `bugzilla.mozilla.org` [generic_external] packages/browsers/src/browser-data/firefox.ts:235 conf 0.1
  - `crontab.guru` [generic_external] .github/workflows/daily.yml:9 conf 0.1
  - `developer.mozilla.org` [generic_external] tools/sort-test-expectations.mjs:22 conf 0.1
  - `docs.github.com` [generic_external] .github/workflows/ci.yml:14 conf 0.1
  - `eslint.org` [generic_external] eslint.config.mjs:185 conf 0.1
  - `nodejs.org` [generic_external] packages/browsers/src/launch.ts:189 conf 0.1
  - `source.chromium.org` [generic_external] packages/browsers/src/browser-data/chrome.ts:169 conf 0.1
  - `v8.dev` [generic_external] eslint.config.mjs:307 conf 0.1

## lovell/sharp @ 857281ae51

- 7051 ms; scan 73% of source, 52 files read; 14 external hosts (1 in active contexts); filtered {"documentation_example":2}; unparsed 3
- **runtime** (1)
  - `sharp.pixelplumbing.com` [generic_external] install/build.js:14 conf 0.6
- **metadata** (2)
  - `github.com` [github] package.json:141 conf 0.3
  - `opencollective.com` [generic_external] package.json:227 conf 0.3
- **test** (1)
  - `raw.githubusercontent.com` [github] test/leak/leak.sh:9 conf 0.2
- **comment** (10)
  - `developer.mozilla.org` [generic_external] lib/resize.mjs:130 conf 0.1
  - `en.wikipedia.org` [generic_external] lib/resize.mjs:143 conf 0.1
  - `eprints.soton.ac.uk` [generic_external] lib/utility.mjs:47 conf 0.1
  - `johncostella.com` [generic_external] lib/resize.mjs:153 conf 0.1
  - `nodejs.org` [generic_external] lib/constructor.mjs:27 conf 0.1
  - `www.cairographics.org` [generic_external] lib/composite.mjs:60 conf 0.1
  - `www.cs.utexas.edu` [generic_external] lib/resize.mjs:150 conf 0.1
  - `www.libvips.org` [generic_external] lib/colour.mjs:83 conf 0.1
  - `www.npmjs.com` [registry] lib/input.mjs:616 conf 0.1
  - `www.npmjs.org` [generic_external] lib/colour.mjs:30 conf 0.1

## zloirock/core-js @ b70f13b9ee

- 6795 ms; scan 1% of source, 55 files read; 15 external hosts (4 in active contexts); filtered {}; unparsed 0
- **install** (4)
  - `boosty.to` [generic_external] packages/core-js/postinstall.js:29 conf 0.55
  - `github.com` [github] packages/core-js/postinstall.js:25 conf 0.55
  - `opencollective.com` [generic_external] packages/core-js/postinstall.js:27 conf 0.55
  - `patreon.com` [generic_external] packages/core-js/postinstall.js:28 conf 0.55
- **metadata** (2)
  - `core-js.io` [generic_external] package.json:7 conf 0.3
  - `zloirock.ru` [generic_external] package.json:12 conf 0.3
- **comment** (9)
  - `developer.samsung.com` [generic_external] packages/core-js-compat/src/mapping.mjs:219 conf 0.1
  - `developers.meta.com` [generic_external] packages/core-js-compat/src/mapping.mjs:323 conf 0.1
  - `en.wikipedia.org` [generic_external] packages/core-js-compat/src/mapping.mjs:222 conf 0.1
  - `forums.opera.com` [generic_external] packages/core-js-compat/src/mapping.mjs:260 conf 0.1
  - `medium.com` [generic_external] packages/core-js-compat/src/mapping.mjs:220 conf 0.1
  - `nodejs.org` [generic_external] packages/core-js-compat/src/mapping.mjs:2 conf 0.1
  - `releases.electronjs.org` [generic_external] packages/core-js-compat/src/mapping.mjs:133 conf 0.1
  - `whatmyuseragent.com` [generic_external] packages/core-js-compat/src/mapping.mjs:326 conf 0.1
  - `www.meta.com` [generic_external] packages/core-js-compat/src/mapping.mjs:324 conf 0.1

## evanw/esbuild @ f6058f8364

- 9056 ms; scan 24% of source, 54 files read; 22 external hosts (5 in active contexts); filtered {}; unparsed 0
- **build** (4)
  - `github.com` [github] Makefile:702 conf 0.7
  - `go.dev` [generic_external] Makefile:80 conf 0.7
  - `golang.org` [generic_external] Makefile:87 conf 0.7
  - `registry.npmjs.org` [registry] Makefile:576 conf 0.7
- **runtime** (1)
  - `esbuild.github.io` [generic_external] cmd/esbuild/main.go:28 conf 0.6
- **comment** (17)
  - `bugs.webkit.org` [generic_external] compat-table/src/index.ts:514 conf 0.1
  - `bugzilla.mozilla.org` [generic_external] compat-table/src/index.ts:496 conf 0.1
  - `caniuse.com` [generic_external] compat-table/src/caniuse.ts:1 conf 0.1
  - `css-tricks.com` [generic_external] internal/css_parser/css_decls_color.go:860 conf 0.1
  - `developer.apple.com` [generic_external] compat-table/src/index.ts:499 conf 0.1
  - `developer.mozilla.org` [generic_external] compat-table/src/index.ts:466 conf 0.1
  - `drafts.csswg.org` [generic_external] internal/css_ast/css_ast.go:330 conf 0.1
  - `gist.github.com` [github] internal/config/globals.go:431 conf 0.1
  - `mathiasbynens.be` [generic_external] internal/css_parser/css_decls_font_family.go:92 conf 0.1
  - `no-color.org` [generic_external] cmd/esbuild/main.go:18 conf 0.1
  - `nodejs.org` [generic_external] compat-table/src/index.ts:476 conf 0.1
  - `speedscope.app` [generic_external] cmd/esbuild/main.go:277 conf 0.1
  - `stackoverflow.com` [generic_external] internal/config/globals.go:442 conf 0.1
  - `tc39.es` [generic_external] internal/config/globals.go:206 conf 0.1
  - `www.chromestatus.com` [generic_external] compat-table/src/index.ts:529 conf 0.1
  - `www.w3.org` [generic_external] internal/css_ast/css_ast.go:1191 conf 0.1
  - `yarnpkg.com` [generic_external] .github/workflows/ci.yml:211 conf 0.1

## typicode/husky @ 3f0023dc10

- 5711 ms; scan 100% of source, 22 files read; 4 external hosts (1 in active contexts); filtered {}; unparsed 0
- **ci** (1)
  - `registry.npmjs.org` [registry] .github/workflows/npm_publish.yml:33 conf 0.65
- **metadata** (1)
  - `github.com` [github] package.json:13 conf 0.3
- **comment** (2)
  - `docs.github.com` [generic_external] .github/workflows/npm_publish.yml:2 conf 0.1
  - `help.github.com` [generic_external] .github/workflows/node.js.yml:1 conf 0.1

## sass/node-sass @ 107ded9434

- 8047 ms; scan 12% of source, 47 files read; 2 external hosts (1 in active contexts); filtered {"documentation_example":1}; unparsed 0
- **install** (1)
  - `github.com` [github] lib/extensions.js:252 conf 0.55
- **metadata** (1)
  - `andrew.github.com` [generic_external] package.json:16 conf 0.3

## prisma/prisma @ 9d489d5d24

- 10393 ms; scan 2% of source, 68 files read; 5 external hosts (3 in active contexts); filtered {"localhost":1}; unparsed 3
- **ci** (3)
  - `api.github.com` [github] .github/workflows/publish.yml:310 conf 0.65
  - `github.com` [github] .github/workflows/record-cli.yml:47 conf 0.65
  - `registry.npmjs.org` [registry] .github/workflows/publish.yml:84 conf 0.65
- **comment** (2)
  - `docs.prisma.io` [generic_external] scripts/list-error-codes.mjs:5 conf 0.1
  - `git.io` [generic_external] .github/workflows/codeql-analysis.yml:31 conf 0.1

## microsoft/playwright @ 6284a53618

- 8459 ms; scan 4% of source, 70 files read; 21 external hosts (7 in active contexts); filtered {"localhost":1}; unparsed 1
- **build** (4)
  - `dl.google.com` [generic_external] utils/avd_install.sh:18 conf 0.7
  - `emscripten.org` [generic_external] utils/libwebp-wasm/build.sh:100 conf 0.7
  - `github.com` [github] utils/libwebp-wasm/build.sh:42 conf 0.7
  - `storage.googleapis.com` [generic_external] utils/avd_start.sh:32 conf 0.7
- **ci** (3)
  - `oauth2.googleapis.com` [generic_external] .github/workflows/publish_extension.yml:27 conf 0.65
  - `registry.npmjs.org` [registry] .github/workflows/publish_release.yml:26 conf 0.65
  - `www.googleapis.com` [generic_external] .github/workflows/publish_extension.yml:41 conf 0.65
- **unknown** (4)
  - `img.shields.io` [generic_external] utils/doclint/cli.js:59 conf 0.4
  - `webkit.org` [generic_external] utils/doclint/cli.js:61 conf 0.4
  - `www.chromium.org` [generic_external] utils/doclint/cli.js:59 conf 0.4
  - `www.mozilla.org` [generic_external] utils/doclint/cli.js:60 conf 0.4
- **metadata** (1)
  - `playwright.dev` [generic_external] package.json:10 conf 0.3
- **comment** (9)
  - `developer.android.com` [generic_external] utils/avd_install.sh:17 conf 0.1
  - `developer.mozilla.org` [generic_external] browser_patches/firefox/juggler/Helper.js:117 conf 0.1
  - `docs.github.com` [generic_external] .github/workflows/tests_mcp.yml:22 conf 0.1
  - `github.blog` [generic_external] .github/workflows/tests_docker.yml:70 conf 0.1
  - `mozilla.org` [generic_external] browser_patches/firefox/juggler/ChannelEventSink.sys.mjs:3 conf 0.1
  - `portal.microsofticm.com` [generic_external] utils/docker/publish_docker.sh:75 conf 0.1
  - `searchfox.org` [generic_external] browser_patches/firefox/juggler/ChannelEventSink.sys.mjs:12 conf 0.1
  - `www.apache.org` [generic_external] packages/playwright-browser-firefox/install.js:8 conf 0.1
  - `www.npmjs.com` [registry] .github/workflows/tests_mcp.yml:27 conf 0.1

