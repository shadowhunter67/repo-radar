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
    expect(read('docs/release/preview-policy.json')).toContain(
      '"allow_experimental_preview_with_unreviewed_calibration": false',
    );
    expect(read('docs/release/preview-policy.json')).toContain(
      '"legal_review_openpgp_action_bundle": "pending"',
    );
    expect(workflow).toContain('gh release create');
    expect(workflow).not.toMatch(/gh release create[\s\S]*dist\/action/);
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
