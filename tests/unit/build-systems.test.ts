import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  deriveBuildFacts,
  buildSourceFindings,
} from '../../src/collectors/build-systems/findings.js';
import { parseBuildSource, parseBuildSources } from '../../src/collectors/build-systems/parse.js';
import { extractHints } from '../../src/collectors/github/hints.js';

const root = join(process.cwd(), 'tests/fixtures/build-systems');
const fixture = (name: string): string => readFileSync(join(root, name), 'utf8');

describe('Bazel, Nix and Buck structural parsing', () => {
  it('does not treat commented rules or documentation strings as dependencies', () => {
    const bazel = parseBuildSource(
      'MODULE.bazel',
      [
        '# bazel_dep(name = "commented")',
        'DOC = "bazel_dep(name = \'in-doc\')"',
        'unused = "http_archive(name=\'unused\')"',
      ].join('\n'),
    );
    expect(bazel.dependencies.map((d) => d.name)).toEqual([]);

    const nix = parseBuildSource(
      'flake.nix',
      [
        '# fetchgit { url = "https://commented.invalid/x"; }',
        'description = "fetchurl { url = \'https://docs.invalid/x\'; }"',
        '{',
        '  inputs.real.url = "github:owner/project";',
        '}',
      ].join('\n'),
    );
    expect(nix.dependencies.map((d) => d.name)).toEqual(['real']);

    const buck = parseBuildSource(
      'BUCK',
      [
        '# http_archive(name = "commented", url = "https://commented.invalid")',
        'DOC = "git_repository(name=\'in-doc\')"',
        'unused = "http_archive(name=\'unused\')"',
      ].join('\n'),
    );
    expect(buck.dependencies.map((d) => d.name)).toEqual([]);
  });

  it('parses exact Bazel module dependency counts and overrides', () => {
    const skylib = parseBuildSource('MODULE.bazel', fixture('bazel-skylib-MODULE.bazel'));
    expect(skylib.system).toBe('bazel');
    expect(skylib.dependencies.length).toBe(8);
    expect(skylib.dependencies.map((d) => d.name).slice(0, 3)).toEqual([
      'platforms',
      'rules_license',
      'stardoc',
    ]);
    expect(skylib.dependencies.some((d) => d.name === 'bazel_skylib_gazelle_plugin')).toBe(true);
    const rulesGo = parseBuildSource('MODULE.bazel', fixture('rules_go-MODULE.bazel'));
    expect(rulesGo.dependencies.length).toBe(18);
    expect(rulesGo.dependencies.find((d) => d.name === 'protobuf')?.pinned).toBe(true);
  });
  it('parses WORKSPACE archives with exact URLs and checksums', () => {
    const w = parseBuildSource('WORKSPACE', fixture('gazelle-WORKSPACE'));
    expect(w.dependencies.length).toBe(10);
    const rulesGo = w.dependencies.find((d) => d.name === 'io_bazel_rules_go');
    expect(rulesGo?.source).toBe(
      'https://mirror.bazel.build/github.com/bazel-contrib/rules_go/releases/download/v0.59.0/rules_go-v0.59.0.zip',
    );
    expect(rulesGo?.checksum).toBe(
      '68af54cb97fbdee5e5e8fe8d210d15a518f9d62abfd71620c3eaff3b26a5ff86',
    );
    expect(rulesGo?.pinned).toBe(true);
  });
  it('parses exact Nix lock nodes, revisions and nar hashes', () => {
    const n = parseBuildSource('flake.lock', fixture('nix-direnv-flake.lock'));
    expect(n.dependencies.map((d) => d.name)).toEqual(['flake-parts', 'nixpkgs', 'treefmt-nix']);
    expect(n.dependencies.find((d) => d.name === 'nixpkgs')?.source).toContain(
      'github:NixOS/nixpkgs',
    );
    expect(n.dependencies.find((d) => d.name === 'nixpkgs')?.checksum).toBe(
      'sha256-bG1LAS3YehMzp4RSXw99o3yMEO/Ktb0Tx29RCtEU0Tk=',
    );
    expect(
      parseBuildSource('flake.lock', fixture('flake-utils-flake.lock')).dependencies[0]?.name,
    ).toBe('systems');
  });
  it('recognizes Buck files structurally without evaluating macros', () => {
    const b = parseBuildSource('BUCK', fixture('buck2-BUCK'));
    expect(b.system).toBe('buck');
    expect(b.target_count).toBeGreaterThan(0);
    expect(b.unparsed_dynamic).toBeGreaterThan(0);
    const cfg = parseBuildSource('.buckconfig', fixture('buck2-buckconfig'));
    expect(cfg.system).toBe('buck');
    expect(cfg.dependencies).toEqual([]);
  });
  it('counts hostile dynamic syntax and rejects unsafe declared retrieval paths', () => {
    const hostile = parseBuildSource(
      'MODULE.bazel',
      `${'x'.repeat(2_100_000)} load("//x", "x") path = "../escape"`,
    );
    expect(hostile.unparsed_dynamic).toBe(1);
    const hints = extractHints(
      'MODULE.bazel',
      '',
      'local_path_override(module_name = "x", path = "../escape")\nlocal_path_override(module_name = "y", path = "C:\\\\secret")',
    );
    expect(hints.exact).toEqual([]);
    expect(hints.rejected).toBe(2);
  });
  it('reports exact unpinned and HTTP signals, facts, and findings', () => {
    const bad = parseBuildSource(
      'WORKSPACE',
      'http_archive(name = "bad_archive", urls = ["http://example.invalid/a.tar.gz"])',
    );
    expect(bad.dependencies).toEqual([
      {
        name: 'bad_archive',
        source: 'http://example.invalid/a.tar.gz',
        checksum: null,
        pinned: false,
        mutable_ref: false,
        dynamic: false,
      },
    ]);
    expect(bad.signals).toEqual(['missing_checksum', 'http_url', 'remote_source_unpinned']);
    const sources = parseBuildSources([
      {
        path: 'WORKSPACE',
        content: 'http_archive(name = "bad_archive", urls = ["http://example.invalid/a.tar.gz"])',
      },
    ]);
    expect(sources.remote_source_unpinned).toBe(true);
    expect(deriveBuildFacts(sources)).toEqual([
      {
        id: 'build.remote_source_unpinned',
        value: true,
        confidence: 0.8,
        scope: 'repo',
        derived_from: ['build:WORKSPACE'],
        derived_by: 'build-systems@0.1',
      },
    ]);
    expect(buildSourceFindings(sources).map((finding) => finding.title)).toEqual([
      'Build source is not fully pinned',
    ]);
  });
});
