import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { packageRoot } from '../../src/util/paths.js';

const root = packageRoot();
const read = (file: string) => readFileSync(join(root, file), 'utf8');

describe('preview release workflow governance', () => {
  it('pins every third-party action and fails closed for the preview policy', () => {
    const workflow = read('.github/workflows/release.yml');
    expect(() => parse(workflow)).not.toThrow();
    for (const match of workflow.matchAll(/uses:\s*([^\s#]+)/g)) {
      const ref = match[1] ?? '';
      expect(ref, ref).toMatch(/@[0-9a-f]{40}$/);
    }
    expect(workflow).not.toContain('continue-on-error');
    expect(workflow).not.toContain('|| true');
    expect(workflow).toMatch(/publish:[\s\S]*startsWith\(github\.ref,\s*'refs\/tags\/v'\)/);
    expect(workflow).toContain('environment: release');
    expect(workflow).toContain('inputs.publish_npm == true');
    expect(workflow).toContain('node scripts/check-release-version.mjs');
    const policy = JSON.parse(read('docs/release/preview-policy.json')) as Record<string, unknown>;
    // preview governance: approved for source + GitHub prerelease ONLY; npm and the Action bundle stay unapproved
    expect(policy['allow_experimental_preview_with_unreviewed_calibration']).toBe(true);
    expect(policy['approved_by']).toMatch(/^[A-Za-z0-9-]+$/);
    expect(policy['approved_on']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(String(policy['rationale']).length).toBeGreaterThan(40);
    expect(policy['public_claims_review']).toBe('approved');
    expect(policy['disclaimer_in_readme']).toBe(true);
    expect(String(policy['scope'])).toContain('Does NOT authorize');
    expect(policy['npm_license_review']).toBe('pending');
    expect(policy['legal_review_openpgp_action_bundle']).toBe('pending');
    expect(workflow).toContain("p.public_claims_review !== 'approved'");
    expect(workflow).toContain("p.npm_license_review !== 'approved'");
    expect(workflow).toContain('gh release create');
    expect(workflow).not.toMatch(/gh release create[\s\S]*dist\/action/);
  });

  it('takes the release notes from the package version and rejects a mismatched tag', () => {
    const workflow = read('.github/workflows/release.yml');
    expect(workflow).not.toMatch(/RELEASE_NOTES_\d+\.\d+\.\d+-preview\.md/);
    expect(workflow).toContain('docs/release/RELEASE_NOTES_${VERSION}-preview.md');
    expect(workflow).toContain('does not match package.json version');
    const version = (JSON.parse(read('package.json')) as { version: string }).version;
    expect(() => read(`docs/release/RELEASE_NOTES_${version}-preview.md`)).not.toThrow();
  });

  it('does not attach anything from dist/web to the release', () => {
    const workflow = read('.github/workflows/release.yml');
    expect(workflow).not.toMatch(/gh release create[\s\S]*dist\/web/);
  });

  it('grants id-token and attestations only to the attest job', () => {
    const workflow = read('.github/workflows/release.yml');
    const attest = workflow.split('\n  attest:\n')[1]?.split('\n  publish:\n')[0] ?? '';
    expect(attest).toContain('id-token: write');
    expect(attest).toContain('attestations: write');
    const before = workflow.split('\n  attest:\n')[0] ?? '';
    expect(before).not.toContain('id-token: write');
    expect(before).not.toContain('attestations: write');
  });
});
