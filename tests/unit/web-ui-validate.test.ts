import { describe, expect, it } from 'vitest';
import { normaliseRepository } from '../../web/public/validate.js';
describe('browser validation', () => {
  it.each([
    ['a/r', 'a/r'],
    ['Owner/repo', 'Owner/repo'],
    ['https://github.com/o/r', 'o/r'],
    ['https://github.com/o/r/', 'o/r'],
    ['x1/r-z', 'x1/r-z'],
  ])('normalises %s', (input, expected) =>
    expect(normaliseRepository(input)?.value).toBe(expected),
  );
  it.each([
    '',
    'o',
    'o/',
    '-o/r',
    'o-/r',
    'o/r/extra',
    'gitlab.com/o/r',
    'http://github.com/o/r',
    'https://github.com.evil/o/r',
    'o/r name',
    'о/r',
    'o/.',
    'o/..',
    'o/r?x=1',
    'o/r#x',
    'git@github.com:o/r',
    'file:o/r',
    '../r',
    'https://github.com:443/o/r',
    'https://user@github.com/o/r',
  ])('rejects %s', (input) => expect(normaliseRepository(input)).toBeNull());
});
