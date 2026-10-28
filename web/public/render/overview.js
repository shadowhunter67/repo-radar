import { t } from '../i18n.js';
export function overview(document, data) {
  const s = document.createElement('section');
  s.className = 'card';
  s.setAttribute('aria-labelledby', 'overview-title');
  const h = document.createElement('h2');
  h.id = 'overview-title';
  h.textContent = t('section.overview');
  s.append(h);
  const p = document.createElement('p');
  p.textContent = `${data.subject.owner}/${data.subject.repo}`;
  s.append(p);
  const a = document.createElement('a');
  a.href = `https://github.com/${data.subject.owner}/${data.subject.repo}`;
  a.rel = 'noopener noreferrer';
  a.textContent = t('field.openRepository');
  s.append(a);
  const sha = document.createElement('p');
  sha.textContent = `${t('field.sha')}: ${data.analysis_manifest.commit ?? t('unavailable')}`;
  sha.className = 'muted';
  s.append(sha);
  return s;
}
