import { describe, expect, it } from 'vitest';
import { validateRepository, WebInputError } from '../../src/web/validate.js';
const valid = [
  'a/r',
  'owner/repo-name',
  'A1/x.y',
  'https://github.com/owner/repo',
  'https://github.com/o/r/',
];
const invalid = [
  'gitlab.com/o/r',
  'localhost/o/r',
  '127.0.0.1/o/r',
  'https://github.com.evil.com/o/r',
  'https://user:pw@github.com/o/r',
  'https://github.com:443/o/r',
  'git@github.com:o/r',
  '../r',
  '~/r',
  'o',
  'o/r/x',
  'o/.',
  'o/..',
  '-owner/r',
  'owner-/r',
  'o/r name',
  'o/r;',
  'o/r|',
  'o/r&',
  'o/r$',
  'o/r<',
  'o/r>',
  'o/r`',
  'o/r\\x',
  'o/é',
  'а/r',
  'ｏ/r',
  'https://github.com/%2e%2e/r',
  'https://%67ithub.com/o/r',
  'https://github.com%2eevil.example/o/r',
  'file:o/r',
  'ssh:o/r',
  'https://[::1]/o/r',
  'https://169.254.1.1/o/r',
  'https://0.0.0.0/o/r',
  'https://github.com/o/r/tree/main',
  'https://github.com/o/r?x=1',
  'https://github.com/o/r#x',
  'https://github.com/o/r.git/extra',
  ' '.repeat(301),
  'o/',
];
describe('web repository validation', () => {
  it.each(valid)('accepts %s', (x) => expect(validateRepository(x)).toBeTruthy());
  it.each(invalid)('rejects %s', (x) => expect(() => validateRepository(x)).toThrow(WebInputError));
  it.each(['main/', '/main', 'main.lock', 'main..x', 'main//x', '-main', ''.padEnd(201, 'x')])(
    'rejects ref %s',
    (ref) => expect(() => validateRepository('o/r', ref)).toThrowError('invalid ref'),
  );
  it('preserves case and ref', () =>
    expect(validateRepository('Acme/Repo', 'feature/x')).toEqual({
      owner: 'Acme',
      repo: 'Repo',
      ref: 'feature/x',
    }));
});
