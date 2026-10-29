/* global URL */
import { getLanguage, t } from '../i18n.js';
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
const field = (doc, parent, label, value, name, attrs = {}) => {
  const dl = el(doc, 'dl', undefined, { class: 'field' });
  dl.append(el(doc, 'dt', label), el(doc, 'dd', value, { 'data-field': name, ...attrs }));
  parent.append(dl);
  return dl;
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
  const p = el(doc, 'p', `${t('evidence.provenance')}: ${url}`);
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && hosts.has(u.hostname)) {
      const a = el(doc, 'a', url, { href: url, rel: 'noopener noreferrer nofollow' });
      p.replaceChildren(`${t('evidence.provenance')}: `, a);
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
    const findingDl = el(doc, 'dl', undefined, { class: 'field' });
    findingDl.append(
      el(doc, 'dt', t('field.findingId')),
      el(doc, 'dd', finding.id, { 'data-field': 'finding-id' }),
    );
    box.append(findingDl, el(doc, 'p', finding.title));
    const list = el(doc, 'div');
    for (const id of finding.evidence_ids ?? []) {
      const item = pools.get(id);
      const n = el(doc, 'article', undefined, { 'data-evidence-id': id, class: 'card' });
      if (!item) n.append(el(doc, 'p', t('evidence.unresolved', { id })));
      else {
        n.append(
          el(
            doc,
            'p',
            `${id}: ${item.name ?? item.file ?? item.source ?? item.kind ?? 'observed'}${item.files ? ` (${item.files.join(', ')})` : ''}`,
          ),
        );
        if (item.lines)
          n.append(el(doc, 'p', t('evidence.lines', { lines: item.lines.join(', ') })));
        if (item.line) n.append(el(doc, 'p', t('evidence.line', { line: item.line })));
        if (item.steps) n.append(el(doc, 'p', item.steps.join('; ')));
        if (item.value !== undefined)
          n.append(el(doc, 'p', t('evidence.value', { value: JSON.stringify(item.value) })));
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
      box.append(el(doc, 'p', t('capabilities.note')));
    const closeButton = el(doc, 'button', t('evidence.close'), { type: 'button' });
    closeButton.addEventListener('click', close);
    box.append(closeButton);
    d.removeAttribute('hidden');
    box.focus();
  };
}
function findingsSection(doc, root, report) {
  const s = card(doc, 'findings', t('section.findings'));
  const controls = el(doc, 'div');
  const countField = el(doc, 'dd', String((report.findings ?? []).length), {
    'data-field': 'finding-count',
  });
  const count = el(doc, 'dl', undefined, { class: 'field compact' });
  count.append(el(doc, 'dt', t('field.findingsShown')), countField);
  controls.append(count);
  const sev = el(doc, 'select', undefined, {
    'data-filter': 'severity',
    'aria-label': t('findings.filterSeverity'),
  });
  for (const x of ['all', 'critical', 'high', 'medium', 'low', 'info'])
    sev.append(el(doc, 'option', x === 'all' ? t('findings.all') : x, { value: x }));
  const cat = el(doc, 'select', undefined, {
    'data-filter': 'category',
    'aria-label': t('findings.filterCategory'),
  });
  const cats = ['all', ...new Set((report.findings ?? []).map((x) => x.category ?? 'unknown'))];
  for (const x of cats)
    cat.append(el(doc, 'option', x === 'all' ? t('findings.all') : x, { value: x }));
  const search = el(doc, 'input', undefined, {
    'data-filter': 'search',
    'aria-label': t('findings.search'),
    id: 'findings-search',
  });
  const severityLabel = el(doc, 'label', t('findings.severity'), { for: 'findings-severity' });
  const categoryLabel = el(doc, 'label', t('findings.category'), { for: 'findings-category' });
  sev.setAttribute('id', 'findings-severity');
  cat.setAttribute('id', 'findings-category');
  const searchLabel = el(doc, 'label', t('findings.search'), { for: 'findings-search' });
  controls.append(severityLabel, sev, categoryLabel, cat, searchLabel, search);
  s.append(controls);
  const table = el(doc, 'table');
  table.append(el(doc, 'caption', t('findings.caption')));
  const thead = el(doc, 'thead'),
    head = el(doc, 'tr');
  for (const x of [
    t('findings.severity'),
    t('findings.category'),
    t('findings.id'),
    t('findings.title'),
    t('findings.summary'),
    t('findings.evidenceCount'),
  ])
    head.append(el(doc, 'th', x, { scope: 'col' }));
  thead.append(head);
  table.append(thead);
  const body = el(doc, 'tbody');
  let open;
  // Rows are built when their page is first shown, not for every finding: a report with thousands of findings stays cheap.
  const makeRow = (f) => {
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
    const run = () => open(f, tr);
    tr.addEventListener('click', run);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        run();
      }
    });
    return tr;
  };
  const rows = (report.findings ?? []).map((f) => ({ f, tr: undefined }));
  table.append(body);
  s.append(table);
  const pag = el(doc, 'div', undefined, { 'data-pagination': 'controls' });
  const prev = el(doc, 'button', t('findings.previous'), {
      type: 'button',
      'data-pagination': 'prev',
    }),
    next = el(doc, 'button', t('findings.next'), { type: 'button', 'data-pagination': 'next' }),
    stat = el(doc, 'span', '1', { 'data-pagination': 'status' });
  pag.append(prev, stat, next);
  s.append(pag);
  const empty = el(doc, 'p', t('findings.empty'), {
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
    body.replaceChildren(
      ...filtered.slice(page * 50, page * 50 + 50).map((x) => (x.tr ??= makeRow(x.f))),
    );
    stat.textContent = t('findings.page', { page: page + 1, pages });
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
  open = dialog(doc, s, report);
  update();
  return s;
}
// A partial reason is a stable code plus numbers; the sentence is ours and localized. A code this page does not know (or a
// job that only carries prose) falls back to the plain text it came with. The English text is never parsed.
function reasonText(r) {
  if (typeof r === 'string') return r; // jobs from an older server carried plain sentences
  const key = `partial.${r?.code}`;
  const text = t(key, { count: r?.count ?? '', detail: r?.detail ?? '' });
  return text === key ? String(r?.message ?? r?.code ?? '') : text;
}
function copyButton(doc, label, command, action, note) {
  const b = el(doc, 'button', label, {
    type: 'button',
    'data-action': action,
    'data-command': command,
  });
  b.addEventListener('click', async () => {
    try {
      await doc.defaultView?.navigator.clipboard?.writeText(command);
      note.textContent = t('actions.cliCopied');
    } catch {
      note.textContent = t('actions.cliSelect');
    }
  });
  return b;
}
const onOff = (v) => (v ? t('tech.on') : t('tech.off'));
function configList(doc, report) {
  const f = report.analysis_manifest?.feature_flags ?? {};
  const ul = el(doc, 'ul', undefined, { 'data-list': 'analysis-config' });
  for (const [key] of [
    ['dependency_history'],
    ['dependency_artifacts'],
    ['verify_crypto'],
    ['verify_assets'],
    ['code_scan'],
    ['dependency_registry'],
    ['osv'],
    ['compliance'],
  ])
    ul.append(el(doc, 'li', `${t(`tech.cfg.${key}`)}: ${onOff(f[key] === true)}`));
  const b = report.analysis_manifest?.budgets ?? {};
  if (b.max_scan_bytes !== undefined)
    ul.append(el(doc, 'li', `${t('tech.scanBudget')}: ${b.max_scan_bytes}`));
  return ul;
}
export function renderResult(doc, job) {
  const report = job.report ?? job;
  const root = doc.createDocumentFragment();
  const overview = card(doc, 'overview', t('section.overview'));
  const owner = job.repository?.owner ?? 'unknown',
    repo = job.repository?.repo ?? 'unknown';
  field(doc, overview, t('field.repository'), `${owner}/${repo}`, 'repository');
  const repoLink = el(doc, 'a', t('field.openRepository'), {
    href: `https://github.com/${owner}/${repo}`,
    rel: 'noopener noreferrer',
  });
  const repoLinkDl = el(doc, 'dl', undefined, { class: 'field' });
  repoLink.setAttribute('data-field', 'repo-link');
  repoLinkDl.append(el(doc, 'dt', t('field.repositoryLink')), repoLink);
  overview.append(repoLinkDl);
  const sha = /^[a-f0-9]{40}$/i.test(job.analyzed_sha ?? '') ? job.analyzed_sha : 'unavailable';
  field(doc, overview, t('field.sha'), sha === 'unavailable' ? t('unavailable') : sha, 'sha', {
    class: 'muted',
  });
  field(
    doc,
    overview,
    t('field.analysisTime'),
    report.generated_at ?? t('unavailable'),
    'generated-at',
  );
  field(
    doc,
    overview,
    t('field.toolVersion'),
    report.tool?.version ?? report.analysis_manifest?.tool_version ?? t('unavailable'),
    'tool-version',
  );
  field(
    doc,
    overview,
    t('field.schema'),
    report.analysis_manifest?.schema_version ?? t('unavailable'),
    'schema-version',
  );
  field(
    doc,
    overview,
    t('field.methodology'),
    report.methodology?.version ?? report.analysis_manifest?.methodology_version ?? '0.4',
    'methodology-version',
  );
  root.append(overview);
  if (job.state === 'partial' && Array.isArray(job.partial_reasons) && job.partial_reasons.length) {
    const part = card(doc, 'partial', t('section.partial'));
    const ul = el(doc, 'ul');
    for (const r of job.partial_reasons) ul.append(el(doc, 'li', reasonText(r)));
    part.append(ul, el(doc, 'p', t('section.partialNote')));
    root.append(part);
  }
  const sc = card(doc, 'score', t('section.score'));
  field(doc, sc, t('field.score'), report.overall.score, 'score', { class: 'score neutral' });
  field(doc, sc, t('field.grade'), report.overall.grade, 'grade');
  sc.append(el(doc, 'p', t('score.note')));
  root.append(sc);
  const conf = card(doc, 'confidence', t('section.confidence'));
  field(doc, conf, t('field.confidence'), report.overall.confidence, 'confidence');
  conf.append(el(doc, 'p', t('confidence.note')));
  root.append(conf);
  const coverage = card(doc, 'coverage', t('section.coverage'));
  const pct = Math.round(report.overall.weight_covered * 100);
  field(doc, coverage, t('field.coverageOverall'), `${pct}%`, 'coverage');
  const scan = report.code_analysis?.scan ?? {};
  field(
    doc,
    coverage,
    t('field.sourceFiles'),
    t('coverage.sourceFiles', {
      scanned: scan.source_files_scanned ?? 0,
      total: scan.source_files_total ?? 0,
    }),
    'source-files',
  );
  field(
    doc,
    coverage,
    t('field.sourceFilesCoverage'),
    `${Math.round((scan.source_coverage ?? 0) * 100)}%`,
    'source-coverage',
  );
  const lookup = report.dependency_registry_intel?.coverage;
  if (lookup && Number(lookup.eligible) > 0)
    field(
      doc,
      coverage,
      t('field.dependencyLookup'),
      t('coverage.lookup', { queried: lookup.queried ?? 0, eligible: lookup.eligible }),
      'dependency-lookup',
    );
  coverage.append(
    el(doc, 'p', t('coverage.meaning'), { 'data-note': 'coverage-meaning' }),
    el(doc, 'p', t('coverage.note')),
  );
  for (const dim of report.dimensions ?? []) {
    const n = el(doc, 'div', undefined, { 'data-dimension': dim.dimension });
    n.append(
      el(
        doc,
        'span',
        `${getLanguage() === 'vi' && t(`dim.${dim.dimension}`) !== `dim.${dim.dimension}` ? t(`dim.${dim.dimension}`) : dim.label} `,
      ),
      el(doc, 'span', `${Math.round(dim.coverage * 1000) / 10}%`, {
        'data-field': 'dimension-coverage',
      }),
    );
    coverage.append(n);
  }
  if ((scan.source_coverage ?? 1) < 0.5)
    coverage.append(
      el(doc, 'p', t('coverage.lowSource'), {
        'data-notice': 'low-source-coverage',
      }),
    );
  root.append(coverage);
  const deepCommand = `node dist/cli.js analyze ${owner}/${repo}${sha === 'unavailable' ? '' : ` --ref ${sha}`} --mode deep`;
  // Partial or thinly scanned: the next step is made prominent. A complete Quick result only gets a small hint further down.
  const needsDeep = job.state === 'partial' || (scan.source_coverage ?? 1) < 0.5;
  if (needsDeep) {
    const cta = el(doc, 'div', undefined, { 'data-banner': 'deep-cta', class: 'card banner cta' });
    const ctaNote = el(doc, 'p', t('cta.note'), { class: 'muted' });
    const ctaCode = el(doc, 'code', deepCommand, { 'data-field': 'deep-command' });
    cta.append(
      el(doc, 'h3', t('cta.title')),
      el(doc, 'p', t('cta.body')),
      ctaCode,
      el(doc, 'div', undefined, { class: 'cta-actions' }),
      ctaNote,
    );
    const how = el(doc, 'a', t('cta.install'), {
      href: 'https://github.com/shadowhunter67/repo-radar/blob/main/docs/getting-started.md',
      rel: 'noopener noreferrer',
      'data-action': 'install-guide',
    });
    cta
      .querySelector('.cta-actions')
      ?.append(copyButton(doc, t('cta.copy'), deepCommand, 'copy-deep', ctaNote), how);
    root.append(cta);
  }
  const findingHost = doc.createElement('div');
  root.append(findingsSection(doc, findingHost, report));
  const deps = card(doc, 'dependencies', t('section.dependencies')),
    sum = report.dependency_intel?.summary ?? {};
  field(doc, deps, t('field.directDeps'), sum.direct ?? 0, 'direct-count');
  field(doc, deps, t('field.transitiveDeps'), sum.transitive ?? 0, 'transitive-count');
  field(doc, deps, t('field.resolvedExact'), sum.direct_resolved_exact ?? 0, 'resolved-exact');
  field(
    doc,
    deps,
    t('field.ecosystems'),
    Object.keys(sum.by_ecosystem ?? {}).join(', ') || t('unavailable'),
    'ecosystems',
  );
  field(doc, deps, t('field.vulnerable'), sum.vulnerable_total ?? 0, 'vulnerable-count');
  root.append(deps);
  const rel = card(doc, 'release', t('section.release'));
  for (const x of report.release_intel?.releases ?? [])
    rel.append(
      el(
        doc,
        'p',
        `${x.tag} — ${x.published_at ?? t('release.noDate')} — ${x.verification_state ?? t('release.notVerified')}`,
        { 'data-release-tag': x.tag },
      ),
    );
  root.append(rel);
  const caps = card(doc, 'capabilities', t('section.capabilities'));
  for (const x of report.code_analysis?.execution?.hooks ?? [])
    caps.append(el(doc, 'p', `${x.id} ${x.name}`, { 'data-hook-id': x.id }));
  for (const x of report.code_analysis?.execution?.chains ?? [])
    caps.append(
      el(doc, 'p', `${x.id} ${x.kind} ${x.file} ${x.steps?.join('; ')}`, { 'data-chain-id': x.id }),
    );
  caps.append(el(doc, 'p', t('capabilities.note')));
  root.append(caps);
  const gov = card(doc, 'governance', t('section.governance'));
  gov.append(
    el(doc, 'p', report.governance?.takeover_indicators?.statement ?? t('governance.noTakeover')),
  );
  field(
    doc,
    gov,
    t('field.commitsWindow'),
    report.governance?.window?.commits ?? t('unavailable'),
    'governance-commits',
  );
  field(
    doc,
    gov,
    t('field.signals'),
    report.governance?.signals?.length ?? 0,
    'governance-signals',
  );
  const limitations = el(doc, 'ul');
  for (const x of report.governance?.limitations ?? []) limitations.append(el(doc, 'li', x));
  gov.append(el(doc, 'h3', t('governance.limitations')), limitations);
  root.append(gov);
  const comp = card(doc, 'compliance', t('section.compliance'));
  comp.append(
    el(doc, 'p', t('compliance.banner'), {
      'data-banner': 'indicative',
    }),
  );
  comp.append(el(doc, 'p', report.regulatory?.disclaimer ?? t('compliance.noDisclaimer')));
  for (const pack of report.regulatory?.packs ?? []) {
    const p = el(
      doc,
      'p',
      `${pack.title ?? pack.pack}: ${pack.applicability?.state ?? t('compliance.unknown')}`,
    );
    if (pack.indicators?.length === 0) p.append(el(doc, 'span', t('compliance.notEvaluated')));
    comp.append(p);
  }
  root.append(comp);
  const tech = el(doc, 'details', undefined, { 'data-section': 'technical' });
  tech.append(el(doc, 'summary', t('section.technical')));
  field(
    doc,
    tech,
    t('field.integrity'),
    report.integrity?.report_sha256 ?? t('unavailable'),
    'report-sha256',
  );
  tech.append(el(doc, 'p', t('tech.integrityNote'), { 'data-note': 'integrity' }));
  const copyHash = el(doc, 'button', t('tech.copyIntegrity'), {
    type: 'button',
    'data-action': 'copy-integrity',
  });
  copyHash.addEventListener('click', async () => {
    try {
      await doc.defaultView?.navigator.clipboard?.writeText(report.integrity?.report_sha256 ?? '');
      copyHash.textContent = t('tech.copied');
    } catch {
      copyHash.textContent = t('tech.copyFailed');
    }
  });
  tech.append(copyHash);
  field(
    doc,
    tech,
    t('field.configDigest'),
    report.methodology?.config_digest ?? t('unavailable'),
    'config-digest',
  );
  tech.append(el(doc, 'h3', t('tech.config')));
  tech.append(configList(doc, report));
  field(doc, tech, t('field.httpRequests'), report.stats?.http_requests ?? 0, 'http-requests');
  field(doc, tech, t('field.evidenceEntries'), report.stats?.evidence_count ?? 0, 'evidence-count');
  tech.append(el(doc, 'h3', t('tech.freshness')));
  const fresh = el(doc, 'ul', undefined, { 'data-list': 'data-freshness' });
  for (const x of report.analysis_manifest?.external_sources ?? [])
    fresh.append(
      el(
        doc,
        'li',
        `${x.source}: ${x.classification === 'revision_bound' ? t('tech.freshnessBound') : t('tech.freshnessCurrent')}, ${t('tech.freshnessRetrieved')} ${x.retrieved_at}`,
        { 'data-external-source': x.source },
      ),
    );
  tech.append(fresh, el(doc, 'p', t('tech.freshnessNote'), { 'data-note': 'freshness' }));
  for (const x of report.diagnostics ?? [])
    tech.append(el(doc, 'p', `${x.level} ${x.code}: ${x.message}`, { 'data-diagnostic': x.code }));
  root.append(tech);
  const actions = el(doc, 'div');
  const dl = el(doc, 'a', t('actions.download'), {
    href: `/api/v1/jobs/${job.job_id}/report`,
    'data-action': 'download',
  });
  const cmd = `node dist/cli.js analyze ${owner}/${repo}${sha === 'unavailable' ? '' : ` --ref ${sha}`} --format json`;
  const cp = el(doc, 'button', t('actions.copyCli'), {
    type: 'button',
    'data-action': 'copy-cli',
    'data-command': cmd,
  });
  const command = el(doc, 'code', cmd);
  const commandDl = el(doc, 'dl', undefined, { class: 'field' });
  commandDl.append(
    el(doc, 'dt', t('field.cliCommand')),
    el(doc, 'dd', undefined, { 'data-field': 'cli-command' }),
  );
  commandDl.lastElementChild?.append(command);
  const notice = el(doc, 'p', t('actions.ephemeral'), {
    'data-notice': 'ephemeral',
  });
  cp.addEventListener('click', async () => {
    try {
      await doc.defaultView?.navigator.clipboard?.writeText(cmd);
      notice.textContent = t('actions.cliCopied');
    } catch {
      const range = doc.createRange();
      range.selectNodeContents(command);
      const sel = doc.defaultView?.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      notice.textContent = t('actions.cliSelect');
    }
  });
  actions.append(dl, cp, commandDl);
  if (!needsDeep)
    actions.append(
      el(doc, 'p', t('cta.hint'), { 'data-note': 'deep-hint' }),
      el(doc, 'code', deepCommand, { 'data-field': 'deep-command' }),
    );
  actions.append(notice);
  root.append(actions);
  if (job.cached)
    root.prepend(el(doc, 'p', t('banner.cached'), { 'data-banner': 'cached', class: 'banner' }));
  if (job.state === 'partial')
    root.prepend(
      el(doc, 'p', t('banner.partial'), { 'data-banner': 'partial', class: 'banner partial' }),
    );
  return root;
}
