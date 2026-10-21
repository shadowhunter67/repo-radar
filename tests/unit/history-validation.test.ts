import { describe, expect, it } from 'vitest';
import { classifyHistory } from '../../src/history/validation.js';

describe('history validation classifications', () => {
  it('distinguishes exact, wrong, ambiguous, and partial observations', () => {
    expect(classifyHistory({ observed: { commit_sha: 'a', relationship: 'direct', path: 'package.json' }, truth: { commit: 'a', relationship: 'direct', path: 'package.json' } })).toEqual({ introduction_commit: 'exact_commit', relationship: 'correct_relationship', manifest: 'correct_manifest' });
    expect(classifyHistory({ observed: { commit_sha: 'b', relationship: 'direct', path: 'package.json' }, truth: { commit: 'a', relationship: 'direct', path: 'package.json' } }).introduction_commit).toBe('incorrect');
    expect(classifyHistory({ observed: {}, truth: { ambiguous: true } }).introduction_commit).toBe('unknown_ground_truth');
    expect(classifyHistory({ observed: {}, truth: { commit: 'a' } }).introduction_commit).toBe('unknown_ground_truth');
    expect(classifyHistory({ observed: { commit_sha: 'b', history_status: 'history_partial' }, truth: { commit: 'a' } }).introduction_commit).toBe('acceptable_ancestor_or_window');
  });
});
