import { t } from '../i18n.js';
export function findings(document, data) {
  const s = document.createElement('section');
  s.className = 'card';
  const h = document.createElement('h2');
  h.textContent = t('section.findings');
  s.append(h);
  const table = document.createElement('table');
  const cap = document.createElement('caption');
  cap.textContent = t('findings.caption');
  table.append(cap);
  const head = document.createElement('tr');
  for (const x of [
    t('findings.severity'),
    t('findings.category'),
    t('findings.id'),
    t('findings.title'),
    t('findings.summary'),
  ]) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = x;
    head.append(th);
  }
  table.append(head);
  for (const f of data.findings) {
    const tr = document.createElement('tr');
    tr.className = 'finding-row';
    tr.tabIndex = 0;
    for (const x of [f.severity, f.category ?? 'unknown', f.id, f.title, f.summary ?? '']) {
      const td = document.createElement('td');
      td.textContent = String(x);
      tr.append(td);
    }
    table.append(tr);
  }
  if (!data.findings.length) {
    const p = document.createElement('p');
    p.textContent = t('findings.empty');
    s.append(p);
  }
  s.append(table);
  return s;
}
