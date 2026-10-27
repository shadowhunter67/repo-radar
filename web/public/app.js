/* global document, fetch, setTimeout, location, AbortController, URLSearchParams */
import { normaliseRepository } from './validate.js';
import { renderResult } from './render/result.js';
export function init(doc, deps = {}) {
  const getFetch = deps.fetch ?? fetch;
  const wait = deps.setTimeout ?? setTimeout;
  const loc = deps.location ?? location;
  const form = doc.getElementById('analyze-form');
  if (!form) return;
  const repo = doc.getElementById('repository'),
    ref = doc.getElementById('ref'),
    normal = doc.getElementById('normalised'),
    status = doc.getElementById('status'),
    error = doc.getElementById('error'),
    result = doc.getElementById('result'),
    button = doc.getElementById('analyze');
  let active = false,
    controller;
  const Controller = deps.AbortController ?? AbortController;
  const messages = {
    INVALID_REPOSITORY: 'Enter a public GitHub repository as owner/repo.',
    INVALID_REF: 'Enter a valid branch, tag or commit SHA.',
    REPOSITORY_NOT_FOUND: 'The repository was not found or is not accessible.',
    RATE_LIMITED: 'GitHub rate limit reached.',
    QUEUE_FULL: 'The analysis queue is full. Try again shortly.',
    ANALYSIS_TIMEOUT: 'The analysis took too long and was stopped.',
    UPSTREAM_UNAVAILABLE: 'An upstream evidence source was unavailable.',
    REPORT_TOO_LARGE: 'The report exceeded the configured size limit.',
    JOB_NOT_FOUND: 'This result expired or was not found.',
    NETWORK_FAILURE: 'The network request failed.',
  };
  const normalise = () => {
    const n = normaliseRepository(repo.value);
    normal.textContent = n ? `Normalised: ${n.value}` : '';
    return n;
  };
  const api = async (path, options = {}) => {
    const r = await getFetch(path, options);
    let data;
    try {
      data = await r.json();
    } catch {
      data = { error: { code: 'INTERNAL_ERROR' } };
    }
    if (!r.ok) {
      const e = new Error(data.error?.message ?? 'request failed');
      e.code = data.error?.code ?? 'INTERNAL_ERROR';
      e.retryAfter = r.headers.get('retry-after');
      throw e;
    }
    return data;
  };
  const showError = (e) => {
    error.textContent = messages[e.code] ?? 'The analysis failed.';
    if (e.code === 'RATE_LIMITED') {
      const b = doc.createElement('p');
      b.setAttribute('data-banner', 'rate-limited');
      b.textContent = e.retryAfter
        ? `GitHub rate limit reached. Retry in ${e.retryAfter} seconds.`
        : 'GitHub rate limit reached.';
      result.replaceChildren(b);
    }
  };
  const stageLabel = (s) =>
    ({
      repository_resolved: 'repository resolved',
      evidence_collected: 'evidence collected',
      dependencies_parsed: 'dependencies parsed',
      findings_evaluated: 'findings evaluated',
      report_built: 'report built',
    })[s] ?? 'Running';
  async function run(event) {
    event.preventDefault();
    if (active) return;
    const n = normalise();
    if (!n) {
      showError({ code: 'INVALID_REPOSITORY' });
      return;
    }
    active = true;
    button.disabled = true;
    error.textContent = '';
    result.replaceChildren();
    controller = new Controller();
    try {
      const body = { repository: n.value, ...(ref.value.trim() ? { ref: ref.value.trim() } : {}) };
      const job = await api('/api/v1/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      let delay = 1500;
      while (true) {
        await new Promise((resolve) => wait(resolve, delay));
        const state = await api(`/api/v1/jobs/${encodeURIComponent(job.job_id)}`, {
          signal: controller.signal,
        });
        if (state.state === 'queued')
          status.textContent = `Queued${state.queue_position ? `: position ${state.queue_position}` : ''}`;
        else status.textContent = state.stage ? `Running: ${stageLabel(state.stage)}` : 'Running';
        if (['completed', 'partial', 'failed', 'expired'].includes(state.state)) {
          if (state.state === 'failed' || state.state === 'expired')
            showError({
              code: state.error?.code ?? 'JOB_NOT_FOUND',
              retryAfter: state.error?.retry_after,
            });
          else if (state.report) {
            result.append(renderResult(doc, state));
            status.textContent =
              state.state === 'partial' ? 'Completed with partial evidence.' : 'Completed.';
          }
          break;
        }
        delay = Math.min(5000, delay + 500);
      }
    } catch (e) {
      if (e.name !== 'AbortError') showError(e);
    } finally {
      active = false;
      button.disabled = false;
    }
  }
  form.addEventListener('submit', run);
  repo.addEventListener('input', normalise);
  for (const b of doc.querySelectorAll('[data-example]'))
    b.addEventListener('click', () => {
      repo.value = b.getAttribute('data-example') ?? '';
      normalise();
      repo.focus();
    });
  const params = new URLSearchParams(loc.search);
  if (params.get('repo')) {
    repo.value = params.get('repo');
    if (params.get('ref')) ref.value = params.get('ref');
    normalise();
  }
  return { abort: () => controller?.abort() };
}
if (typeof document !== 'undefined') init(document);
