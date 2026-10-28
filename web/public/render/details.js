import { t } from '../i18n.js';
export function details(document, data) {
  const d = document.createElement('details');
  const s = document.createElement('summary');
  s.textContent = t('section.technical');
  d.append(s);
  const p = document.createElement('p');
  p.textContent = `${t('field.evidenceEntries')}: ${data.stats.evidence_count}; ${t('field.httpRequests')}: ${data.stats.http_requests}; ${t('field.integrity')}: ${data.integrity.report_sha256}`;
  d.append(p);
  return d;
}
