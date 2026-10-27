/* global URL */
const hosts = new Set([
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'registry.npmjs.org',
  'pypi.org',
  'crates.io',
  'osv.dev',
  'api.osv.dev',
  'deps.dev',
  'api.deps.dev',
  'api.securityscorecards.dev',
]);
const el = (doc, tag, text, attrs = {}) => {
  const n = doc.createElement(tag);
  if (text !== undefined) n.textContent = String(text);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};
const card = (doc, name, title) => {
  const s = el(doc, 'section', undefined, {
    'data-section': name,
    'aria-labelledby': `${name}-title`,
    class: 'card',
  });
  s.append(el(doc, 'h2', title, { id: `${name}-title` }));
  return s;
};
function evidencePools(report) {
  const out = new Map((report.evidence ?? []).map((x) => [x.id, x]));
  const ca = report.code_analysis ?? {};
  for (const group of [
    ca.execution?.chains,
    ca.execution?.hooks,
    ca.capabilities?.detections,
    ca.execution?.entrypoints,
    ca.execution?.projects,
  ])
    for (const x of group ?? []) if (x?.id) out.set(x.id, x);
  return out;
}
function addSafeProvenance(doc, parent, url) {
  const p = el(doc, 'p', `Provenance: ${url}`);
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && hosts.has(u.hostname)) {
      const a = el(doc, 'a', url, { href: url, rel: 'noopener noreferrer nofollow' });
      p.replaceChildren('Provenance: ', a);
    }
  } catch {
    // Invalid provenance remains visible as plain text.
  }
  parent.append(p);
}
function dialog(doc, root, report) {
  const d = el(doc, 'div', undefined, {
    role: 'dialog',
    'aria-modal': 'true',
    'data-evidence-dialog': 'true',
    hidden: 'true',
    class: 'dialog-backdrop',
  });
  const box = el(doc, 'div', undefined, { class: 'dialog', tabindex: '-1' });
  d.append(box);
  root.append(d);
  let opener;
  const pools = evidencePools(report);
  function close() {
    d.setAttribute('hidden', 'true');
    opener?.focus();
  }
  d.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      close();
      e.preventDefault();
    }
    if (e.key === 'Tab') {
      const f = [...box.querySelectorAll('button,a,[tabindex]')].filter(
        (x) => !x.hasAttribute('disabled'),
      );
      if (f.length) {
        if (e.shiftKey && doc.activeElement === f[0]) {
          f[f.length - 1].focus();
          e.preventDefault();
        } else if (!e.shiftKey && doc.activeElement === f[f.length - 1]) {
          f[0].focus();
          e.preventDefault();
        }
      }
    }
  });
  return (finding, row) => {
    opener = row;
    box.replaceChildren();
    box.append(
      el(doc, 'h2', finding.id, { 'data-field': 'finding-id' }),
      el(doc, 'p', finding.title),
    );
    const list = el(doc, 'div');
    for (const id of finding.evidence_ids ?? []) {
      const item = pools.get(id);
      const n = el(doc, 'article', undefined, { 'data-evidence-id': id, class: 'card' });
      if (!item) n.append(el(doc, 'p', `${id}: unresolved`));
      else {
        n.append(
          el(
            doc,
            'p',
            `${id}: ${item.name ?? item.file ?? item.source ?? item.kind ?? 'observed'}${item.files ? ` (${item.files.join(', ')})` : ''}`,
          ),
        );
        if (item.lines) n.append(el(doc, 'p', `lines ${item.lines.join(', ')}`));
        if (item.line) n.append(el(doc, 'p', `line ${item.line}`));
        if (item.steps) n.append(el(doc, 'p', item.steps.join('; ')));
        if (item.value !== undefined)
          n.append(el(doc, 'p', `value: ${JSON.stringify(item.value)}`));
        if (item.provenance?.url) addSafeProvenance(doc, n, item.provenance.url);
      }
      list.append(n);
    }
    box.append(list);
    if (
      String(finding.category ?? '')
        .toLowerCase()
        .includes('cap') ||
      finding.id.startsWith('RR-PERS')
    )
      box.append(el(doc, 'p', 'A capability describes what code can do, not intent.'));
    const closeButton = el(doc, 'button', 'Close', { type: 'button' });
    closeButton.addEventListener('click', close);
    box.append(closeButton);
    d.removeAttribute('hidden');
    box.focus();
  };
}
function findingsSection(doc, root, report) {
  const s = card(doc, 'findings', 'Findings');
  const controls = el(doc, 'div');
  const countField = el(doc, 'span', String((report.findings ?? []).length), {
    'data-field': 'finding-count',
  });
  controls.append(countField);
  const sev = el(doc, 'select', undefined, {
    'data-filter': 'severity',
    'aria-label': 'Filter by severity',
  });
  for (const x of ['all', 'critical', 'high', 'medium', 'low', 'info'])
    sev.append(el(doc, 'option', x, { value: x }));
  const cat = el(doc, 'select', undefined, {
    'data-filter': 'category',
    'aria-label': 'Filter by category',
  });
  const cats = ['all', ...new Set((report.findings ?? []).map((x) => x.category ?? 'unknown'))];
  for (const x of cats) cat.append(el(doc, 'option', x, { value: x }));
  const search = el(doc, 'input', undefined, {
    'data-filter': 'search',
    'aria-label': 'Search findings',
  });
  controls.append(sev, cat, search);
  s.append(controls);
  const table = el(doc, 'table');
  table.append(el(doc, 'caption', 'Observed findings within analyzed coverage'));
  const thead = el(doc, 'thead'),
    head = el(doc, 'tr');
  for (const x of ['Severity', 'Category', 'ID', 'Title', 'Summary', 'Evidence count'])
    head.append(el(doc, 'th', x, { scope: 'col' }));
  thead.append(head);
  table.append(thead);
  const body = el(doc, 'tbody');
  const rows = [];
  for (const f of report.findings ?? []) {
    const tr = el(doc, 'tr', undefined, { 'data-finding-id': f.id, tabindex: '0' });
    for (const [k, v] of [
      ['severity', f.severity],
      ['category', f.category ?? 'unknown'],
      ['id', f.id],
      ['title', f.title],
      ['summary', f.summary ?? ''],
      ['evidence-count', String((f.evidence_ids ?? []).length)],
    ])
      tr.append(el(doc, 'td', v, { 'data-col': k }));
    body.append(tr);
    rows.push({ tr, f });
  }
  table.append(body);
  s.append(table);
  const pag = el(doc, 'div', undefined, { 'data-pagination': 'controls' });
  const prev = el(doc, 'button', 'Previous', { type: 'button', 'data-pagination': 'prev' }),
    next = el(doc, 'button', 'Next', { type: 'button', 'data-pagination': 'next' }),
    stat = el(doc, 'span', '1', { 'data-pagination': 'status' });
  pag.append(prev, stat, next);
  s.append(pag);
  const empty = el(doc, 'p', 'No findings observed within analyzed coverage.', {
    'data-empty-findings': 'true',
  });
  s.append(empty);
  let page = 0;
  function update() {
    const filtered = rows.filter(
      ({ f }) =>
        (sev.value === 'all' || f.severity === sev.value) &&
        (cat.value === 'all' || (f.category ?? 'unknown') === cat.value) &&
        `${f.id} ${f.title} ${f.summary ?? ''}`.toLowerCase().includes(search.value.toLowerCase()),
    );
    const pages = Math.max(1, Math.ceil(filtered.length / 50));
    page = Math.min(page, pages - 1);
    rows.forEach((x) => x.tr.setAttribute('hidden', 'true'));
    filtered.slice(page * 50, page * 50 + 50).forEach((x) => x.tr.removeAttribute('hidden'));
    stat.textContent = `${page + 1} of ${pages}`;
    prev.disabled = page === 0;
    next.disabled = page >= pages - 1;
    empty.toggleAttribute('hidden', filtered.length !== 0);
    countField.textContent = String(filtered.length);
  }
  for (const x of [sev, cat])
    x.addEventListener('change', () => {
      page = 0;
      update();
    });
  search.addEventListener('input', () => {
    page = 0;
    update();
  });
  prev.addEventListener('click', () => {
    page--;
    update();
  });
  next.addEventListener('click', () => {
    page++;
    update();
  });
  const open = dialog(doc, s, report);
  for (const { tr, f } of rows) {
    const run = () => open(f, tr);
    tr.addEventListener('click', run);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        run();
      }
    });
  }
  update();
  return s;
}
export function renderResult(doc, job) {
  const report = job.report ?? job;
  const root = doc.createDocumentFragment();
  const overview = card(doc, 'overview', 'Overview');
  const owner = job.repository?.owner ?? 'unknown',
    repo = job.repository?.repo ?? 'unknown';
  overview.append(el(doc, 'p', `${owner}/${repo}`, { 'data-field': 'repository' }));
  overview.append(
    el(doc, 'a', 'Open repository', {
      href: `https://github.com/${owner}/${repo}`,
      'data-field': 'repo-link',
      rel: 'noopener noreferrer',
    }),
  );
  const sha = /^[a-f0-9]{40}$/i.test(job.analyzed_sha ?? '') ? job.analyzed_sha : 'unavailable';
  overview.append(el(doc, 'p', sha, { 'data-field': 'sha', class: 'muted' }));
  overview.append(
    el(doc, 'p', `Generated ${report.generated_at}`, { 'data-field': 'generated-at' }),
    el(doc, 'p', report.tool?.version ?? report.analysis_manifest?.tool_version ?? '', {
      'data-field': 'tool-version',
    }),
    el(doc, 'p', report.analysis_manifest?.schema_version ?? '', {
      'data-field': 'schema-version',
    }),
    el(
      doc,
      'p',
      report.methodology?.version ?? report.analysis_manifest?.methodology_version ?? '0.4',
      { 'data-field': 'methodology-version' },
    ),
  );
  root.append(overview);
  const sc = card(doc, 'score', 'Score');
  sc.append(
    el(doc, 'p', report.overall.score, { 'data-field': 'score', class: 'score neutral' }),
    el(doc, 'p', report.overall.grade, { 'data-field': 'grade' }),
    el(doc, 'p', 'A score is an evidence-derived heuristic, not a probability of safety.'),
  );
  root.append(sc);
  const conf = card(doc, 'confidence', 'Confidence');
  conf.append(el(doc, 'p', report.overall.confidence, { 'data-field': 'confidence' }));
  root.append(conf);
  const coverage = card(doc, 'coverage', 'Coverage');
  const pct = Math.round(report.overall.weight_covered * 100);
  coverage.append(el(doc, 'p', `${pct}%`, { 'data-field': 'coverage' }));
  const scan = report.code_analysis?.scan ?? {};
  coverage.append(
    el(
      doc,
      'p',
      `${Math.round((scan.source_coverage ?? 0) * 100)}% source coverage; ${scan.source_files_scanned ?? 0}/${scan.source_files_total ?? 0} source files`,
      { 'data-field': 'source-files' },
    ),
    el(doc, 'p', `${Math.round((scan.source_coverage ?? 0) * 100)}%`, {
      'data-field': 'source-coverage',
    }),
    el(doc, 'p', "Findings and 'not observed' statements apply only to analyzed evidence."),
  );
  for (const dim of report.dimensions ?? []) {
    const n = el(doc, 'div', undefined, { 'data-dimension': dim.dimension });
    n.append(
      el(doc, 'span', `${Math.round(dim.coverage * 1000) / 10}%`, {
        'data-field': 'dimension-coverage',
      }),
    );
    coverage.append(n);
  }
  if ((scan.source_coverage ?? 1) < 0.5)
    coverage.append(
      el(doc, 'p', 'Low source coverage within analyzed evidence.', {
        'data-notice': 'low-source-coverage',
      }),
    );
  root.append(coverage);
  const findingHost = doc.createElement('div');
  root.append(findingsSection(doc, findingHost, report));
  const deps = card(doc, 'dependencies', 'Dependencies'),
    sum = report.dependency_intel?.summary ?? {};
  deps.append(
    el(doc, 'p', sum.direct ?? 0, { 'data-field': 'direct-count' }),
    el(doc, 'p', sum.transitive ?? 0, { 'data-field': 'transitive-count' }),
    el(doc, 'p', sum.direct_resolved_exact ?? 0, { 'data-field': 'resolved-exact' }),
    el(doc, 'p', Object.keys(sum.by_ecosystem ?? {}).join(', '), { 'data-field': 'ecosystems' }),
    el(doc, 'p', sum.vulnerable_total ?? 0, { 'data-field': 'vulnerable-count' }),
  );
  root.append(deps);
  const rel = card(doc, 'release', 'Release & Provenance');
  for (const x of report.release_intel?.releases ?? [])
    rel.append(
      el(doc, 'p', `${x.tag}: not verified from presence alone`, { 'data-release-tag': x.tag }),
    );
  root.append(rel);
  const caps = card(doc, 'capabilities', 'Capabilities & execution');
  for (const x of report.code_analysis?.execution?.hooks ?? [])
    caps.append(el(doc, 'p', `${x.id} ${x.name}`, { 'data-hook-id': x.id }));
  for (const x of report.code_analysis?.execution?.chains ?? [])
    caps.append(
      el(doc, 'p', `${x.id} ${x.kind} ${x.file} ${x.steps?.join('; ')}`, { 'data-chain-id': x.id }),
    );
  caps.append(el(doc, 'p', 'A capability describes what code can do, not intent.'));
  root.append(caps);
  root.append(card(doc, 'governance', 'Governance'));
  const comp = card(doc, 'compliance', 'Compliance');
  comp.prepend(
    el(doc, 'p', 'Indicative only. Not legal advice. Not a compliance certification.', {
      'data-banner': 'indicative',
    }),
  );
  root.append(comp);
  const tech = el(doc, 'details', undefined, { 'data-section': 'technical' });
  tech.append(el(doc, 'summary', 'Technical details'));
  tech.append(
    el(doc, 'p', report.integrity?.report_sha256 ?? '', { 'data-field': 'report-sha256' }),
    el(doc, 'p', report.stats?.http_requests ?? 0, { 'data-field': 'http-requests' }),
    el(doc, 'p', report.stats?.evidence_count ?? 0, { 'data-field': 'evidence-count' }),
  );
  for (const x of report.analysis_manifest?.external_sources ?? [])
    tech.append(
      el(doc, 'p', `${x.source} ${x.classification} ${x.retrieved_at}`, {
        'data-external-source': x.source,
      }),
    );
  for (const x of report.diagnostics ?? [])
    tech.append(el(doc, 'p', `${x.level} ${x.code}: ${x.message}`, { 'data-diagnostic': x.code }));
  root.append(tech);
  const actions = el(doc, 'div');
  const dl = el(doc, 'a', 'Download JSON report', {
    href: `/api/v1/jobs/${job.job_id}/report`,
    'data-action': 'download',
  });
  const cmd = `repo-radar analyze ${owner}/${repo}${sha === 'unavailable' ? '' : ` --ref ${sha}`}`;
  const cp = el(doc, 'button', 'Copy CLI command', {
    type: 'button',
    'data-action': 'copy-cli',
    'data-command': cmd,
  });
  const command = el(doc, 'code', cmd, { 'data-field': 'cli-command' });
  const notice = el(doc, 'p', 'Results are kept for a limited time and then discarded.', {
    'data-notice': 'ephemeral',
  });
  cp.addEventListener('click', async () => {
    try {
      await doc.defaultView?.navigator.clipboard?.writeText(cmd);
      notice.textContent = 'CLI command copied.';
    } catch {
      const range = doc.createRange();
      range.selectNodeContents(command);
      const sel = doc.defaultView?.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      notice.textContent = 'Select and copy the CLI command.';
    }
  });
  actions.append(dl, cp, command, notice);
  root.append(actions);
  if (job.state === 'partial')
    root.prepend(
      el(
        doc,
        'p',
        'Analysis completed with partial evidence: one or more sources were unavailable or budgets were reached.',
        { 'data-banner': 'partial', class: 'banner partial' },
      ),
    );
  return root;
}
