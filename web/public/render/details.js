export function details(document, data) {
  const d = document.createElement('details');
  const s = document.createElement('summary');
  s.textContent = 'Technical details';
  d.append(s);
  const p = document.createElement('p');
  p.textContent = `Evidence entries: ${data.stats.evidence_count}; HTTP requests: ${data.stats.http_requests}; Report integrity: ${data.integrity.report_sha256}`;
  d.append(p);
  return d;
}
