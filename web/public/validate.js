export function normaliseRepository(value) {
  const s = String(value ?? '').trim();
  if (/^https:\/\/github\.com:\d+\//i.test(s)) return null;
  try {
    const u = new URL(s);
    if (
      u.protocol === 'https:' &&
      u.hostname === 'github.com' &&
      !u.username &&
      !u.password &&
      !u.port &&
      !u.search &&
      !u.hash
    ) {
      const p = u.pathname.split('/').filter(Boolean);
      if (p.length === 2) return { owner: p[0], repo: p[1], value: `${p[0]}/${p[1]}` };
    }
  } catch {
    // The strict owner/repository form is checked below.
  }
  const p = s.split('/');
  if (
    p.length === 2 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(p[0]) &&
    /^[A-Za-z0-9._-]{1,100}$/.test(p[1]) &&
    p[1] !== '.' &&
    p[1] !== '..'
  )
    return { owner: p[0], repo: p[1], value: `${p[0]}/${p[1]}` };
  return null;
}
/* global URL */
