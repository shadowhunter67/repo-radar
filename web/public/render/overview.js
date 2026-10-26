export function overview(document, data) {
  const s = document.createElement('section');
  s.className = 'card';
  s.setAttribute('aria-labelledby', 'overview-title');
  const h = document.createElement('h2');
  h.id = 'overview-title';
  h.textContent = 'Overview';
  s.append(h);
  const p = document.createElement('p');
  p.textContent = `${data.subject.owner}/${data.subject.repo}`;
  s.append(p);
  const a = document.createElement('a');
  a.href = `https://github.com/${data.subject.owner}/${data.subject.repo}`;
  a.rel = 'noopener noreferrer';
  a.textContent = 'Open repository';
  s.append(a);
  const sha = document.createElement('p');
  sha.textContent = `Analyzed SHA: ${data.analysis_manifest.commit ?? 'unavailable'}`;
  sha.className = 'muted';
  s.append(sha);
  return s;
}
