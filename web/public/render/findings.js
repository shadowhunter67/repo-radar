export function findings(document, data) {
  const s = document.createElement('section');
  s.className = 'card';
  const h = document.createElement('h2');
  h.textContent = 'Findings';
  s.append(h);
  const table = document.createElement('table');
  const cap = document.createElement('caption');
  cap.textContent = 'Observed findings within analyzed coverage';
  table.append(cap);
  const head = document.createElement('tr');
  for (const x of ['Severity', 'Category', 'ID', 'Title', 'Summary']) {
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
    p.textContent = 'No findings observed within analyzed coverage.';
    s.append(p);
  }
  s.append(table);
  return s;
}
