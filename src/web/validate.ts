export type WebRepo = { owner: string; repo: string; ref?: string };
export class WebInputError extends Error {
  constructor(
    public readonly code: 'INVALID_REPOSITORY' | 'INVALID_REF',
    message: string,
  ) {
    super(message);
  }
}
const owner = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const repo = /^[A-Za-z0-9._-]{1,100}$/;
const ref = /^[A-Za-z0-9._/-]{1,200}$/;
const bad = (value: string): boolean =>
  [...value].some((c) => {
    const n = c.codePointAt(0) ?? 0;
    return n <= 0x20 || [0x22, 0x24, 0x26, 0x27, 0x3b, 0x3c, 0x3e, 0x5c, 0x60, 0x7c].includes(n);
  });
export function validateRepository(value: unknown, suppliedRef?: unknown): WebRepo {
  if (typeof value !== 'string' || value.length > 300 || bad(value))
    throw new WebInputError(
      'INVALID_REPOSITORY',
      'repository must be owner/repo or an exact GitHub URL',
    );
  let parts: string[];
  if (value.startsWith('https://')) {
    try {
      const u = new URL(value);
      if (
        u.hostname !== 'github.com' ||
        u.username ||
        u.password ||
        u.port ||
        u.pathname.split('/').filter(Boolean).length !== 2
      )
        throw new Error();
      parts = u.pathname.split('/').filter(Boolean);
    } catch {
      throw new WebInputError(
        'INVALID_REPOSITORY',
        'repository must be owner/repo or an exact GitHub URL',
      );
    }
  } else {
    parts = value.split('/');
  }
  if (
    parts.length !== 2 ||
    !owner.test(parts[0] ?? '') ||
    !repo.test(parts[1] ?? '') ||
    parts[1] === '.' ||
    parts[1] === '..'
  )
    throw new WebInputError('INVALID_REPOSITORY', 'invalid repository');
  if (
    typeof suppliedRef !== 'undefined' &&
    (typeof suppliedRef !== 'string' ||
      suppliedRef.length > 200 ||
      !ref.test(suppliedRef) ||
      suppliedRef.includes('..') ||
      suppliedRef.startsWith('-') ||
      suppliedRef.startsWith('/') ||
      suppliedRef.includes('//') ||
      suppliedRef.endsWith('/') ||
      suppliedRef.endsWith('.lock'))
  )
    throw new WebInputError('INVALID_REF', 'invalid ref');
  return typeof suppliedRef === 'string'
    ? { owner: parts[0]!, repo: parts[1]!, ref: suppliedRef }
    : { owner: parts[0]!, repo: parts[1]! };
}
