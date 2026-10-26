import { submit, poll, reportUrl, ApiError } from './api.js';
import { normaliseRepository } from './validate.js';
import { overview } from './render/overview.js';
import { score } from './render/score.js';
import { findings } from './render/findings.js';
import { details } from './render/details.js';
const d = document,
  form = d.getElementById('analyze-form'),
  repo = d.getElementById('repository'),
  ref = d.getElementById('ref'),
  normal = d.getElementById('normalised'),
  status = d.getElementById('status'),
  error = d.getElementById('error'),
  result = d.getElementById('result'),
  button = d.getElementById('analyze');
let active = false,
  aborter;
function showError(e) {
  error.textContent =
    e instanceof ApiError
      ? ({
          INVALID_REPOSITORY: 'Enter a public GitHub repository as owner/repo.',
          INVALID_REF: 'Enter a valid branch, tag or commit SHA.',
          REPOSITORY_NOT_FOUND: 'The repository was not found or is not accessible.',
          RATE_LIMITED: `GitHub rate limit reached${e.retryAfter ? ` (retry in ${e.retryAfter} seconds).` : '.'}`,
          QUEUE_FULL: 'The analysis queue is full. Try again shortly.',
          ANALYSIS_TIMEOUT: 'The analysis took too long and was stopped.',
          UPSTREAM_UNAVAILABLE: 'An upstream evidence source was unavailable.',
          REPORT_TOO_LARGE: 'The report exceeded the configured size limit.',
          JOB_NOT_FOUND: 'This result expired or was not found.',
          NETWORK_FAILURE: 'The network request failed.',
        }[e.code] ?? e.message)
      : 'The analysis failed.';
}
function setNormal() {
  const n = normaliseRepository(repo.value);
  normal.textContent = n ? `Normalised: ${n.value}` : '';
  return n;
}
function renderReport(data, job) {
  result.replaceChildren(overview(d, data), score(d, data));
  if (job.state === 'partial') {
    const b = d.createElement('p');
    b.className = 'banner partial';
    b.textContent =
      'Analysis completed with partial evidence: one or more sources were unavailable or budgets were reached';
    result.prepend(b);
  }
  result.append(findings(d, data), details(d, data));
  const actions = d.createElement('p');
  const link = d.createElement('a');
  link.href = reportUrl(job.job_id);
  link.textContent = 'Download JSON report';
  actions.append(link);
  result.append(actions);
}
async function run(e) {
  e.preventDefault();
  if (active) return;
  const n = setNormal();
  if (!n) {
    showError(new ApiError('INVALID_REPOSITORY', ''));
    return;
  }
  active = true;
  button.disabled = true;
  error.textContent = '';
  result.replaceChildren();
  status.textContent = 'Submitting analysis…';
  try {
    const j = await submit(n.value, ref.value.trim());
    aborter = new AbortController();
    let wait = 1500;
    while (true) {
      await new Promise((r) => setTimeout(r, wait));
      const job = await poll(j.job_id);
      status.textContent = job.stage
        ? `Running: ${String(job.stage).replaceAll('_', ' ')}`
        : `${job.state}`;
      if (['completed', 'partial', 'failed', 'expired'].includes(job.state)) {
        if (job.state === 'failed') {
          showError(new ApiError(job.error?.code ?? 'INTERNAL_ERROR', job.error?.message ?? ''));
        } else if (job.report) renderReport(job.report, job);
        break;
      }
      wait = Math.min(5000, wait + 500);
    }
  } catch (e) {
    showError(e);
  } finally {
    active = false;
    button.disabled = false;
  }
}
form.addEventListener('submit', run);
repo.addEventListener('input', setNormal);
for (const b of d.querySelectorAll('[data-example]'))
  b.addEventListener('click', () => {
    repo.value = b.getAttribute('data-example') ?? '';
    setNormal();
    repo.focus();
  });
const params = new URLSearchParams(location.search);
if (params.get('repo')) {
  repo.value = params.get('repo');
  if (params.get('ref')) ref.value = params.get('ref');
  setNormal();
}
addEventListener('beforeunload', () => aborter?.abort());
/* global document, AbortController, setTimeout, URLSearchParams, location, addEventListener */
