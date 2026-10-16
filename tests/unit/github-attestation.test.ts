import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { collectReleases } from '../../src/collectors/github/releases.js';
import { parseTrustedRootLines } from '../../src/trust/github-root.js';
import { verifyBundleWithRoot } from '../../src/trust/sigstore.js';
import { HttpClient } from '../../src/util/http.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(`tests/fixtures/attestations/${name}`, 'utf8'));
const roots = parseTrustedRootLines(
  readFileSync('tests/fixtures/attestations/github-trusted-root.jsonl', 'utf8'),
);

describe('custom Sigstore roots', () => {
  it('verifies npm provenance with the public-good root and rejects a changed digest', () => {
    const raw = fixture('npm-sigstore-3.1.0.attestations.json') as {
      attestations: Array<{ predicateType: string; bundle: unknown }>;
    };
    const root = roots.find((r) => r.label === 'sigstore_public_good');
    expect(root).toBeDefined();
    const bundle = raw.attestations.find(
      (a) => a.predicateType === 'https://slsa.dev/provenance/v1',
    )?.bundle;
    expect(bundle).toBeDefined();
    const verified = verifyBundleWithRoot(bundle, root!, {
      expectedSubjectDigest: 'not-the-registry-digest',
    });
    expect(verified.state).toBe('verified_digest_only');
    expect(verified.trust_root).toBe('sigstore_public_good');
  });

  it('keeps GitHub roots separate from public-good roots', () => {
    expect(roots.some((r) => r.label === 'github_attestation_instance')).toBe(true);
    expect(roots.some((r) => r.label === 'sigstore_public_good')).toBe(true);
  });

  it('collects and verifies the real Goreleaser GitHub attestation only under the GitHub root', async () => {
    const body = fixture('goreleaser-checksums.attestations.json') as { attestations: unknown[] };
    const digest = 'a40282e5419a5e7176c78afae243777ae0da7376e165d8cf59805910d2c84e1e';
    const release = {
      tag_name: 'v2.18.3',
      draft: false,
      prerelease: false,
      assets: [
        {
          name: 'checksums.txt',
          size: 100,
          browser_download_url:
            'https://github.com/goreleaser/goreleaser/releases/download/v2.18.3/checksums.txt',
          digest: `sha256:${digest}`,
        },
      ],
    };
    const fetch = async (url: string): Promise<Response> => {
      if (url.endsWith('/releases'))
        return new Response(JSON.stringify([release]), { status: 200 });
      if (url.includes('/git/ref/tags/'))
        return new Response(JSON.stringify({ object: { type: 'commit', sha: 'c'.repeat(40) } }), {
          status: 200,
        });
      if (url.includes(`/attestations/sha256:${digest}`))
        return new Response(JSON.stringify(body), { status: 200 });
      return new Response('{}', { status: 404 });
    };
    const run = (root: (typeof roots)[number]) =>
      collectReleases({
        http: new HttpClient({ allowedHosts: ['api.github.com'], fetch }),
        base: 'https://api.github.com/repos/goreleaser/goreleaser',
        headers: {},
        owner: 'goreleaser',
        repo: 'goreleaser',
        releases: [release] as never,
        analyzedCommit: 'c'.repeat(40),
        note: () => undefined,
        verifyCrypto: true,
        trust: { keys: [], trustedRoots: [root] },
      });
    const github = await run(roots.find((r) => r.label === 'github_attestation_instance')!);
    const githubProv = github.releases[0]?.provenance?.[0];
    expect(githubProv?.origin).toBe('github_attestation_api');
    expect(githubProv?.verification).toBe('verified');
    expect(githubProv?.verification_detail?.state).toBe('verified_github_attestation');
    expect(githubProv?.verification_detail?.trust_root).toBe('github_attestation_instance');
    expect(githubProv?.source_repository).toBe('goreleaser/goreleaser');
    expect(github.releases[0]?.correspondence).toBe('verified_build_provenance');
    const publicGood = await run(roots.find((r) => r.label === 'sigstore_public_good')!);
    const publicProv = publicGood.releases[0]?.provenance?.[0];
    expect(publicProv?.verification).not.toBe('verified_github_attestation');
    expect(publicProv?.verification_detail?.trust_root).toBe('sigstore_public_good');
  });
});
