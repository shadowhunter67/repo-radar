/* global document, fetch, setTimeout, location, AbortController, URLSearchParams */
import { normaliseRepository } from './validate.js';
import { renderResult } from './render/result.js';
import { applyStatic, getLanguage, onLanguageChange, setLanguage, t } from './i18n.js';
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
  // What is on screen is kept as data (message keys, the job), so a language change repaints it without any request.
  const view = { status: null, error: null, job: null, command: '' };
  const normalise = () => {
    const n = normaliseRepository(repo.value);
    normal.textContent = n ? t('form.normalised', { value: n.value }) : '';
    return n;
  };
  // A free host that has been idle answers the first requests with a gateway page (502/503/504 that is not our JSON error)
  // or refuses the connection while it wakes up. That is waiting, not failure: show a neutral message and try again.
  const WAKE_TRIES = 15;
  const WAKE_DELAY_MS = 4000;
  const api = async (path, options = {}) => {
    for (let attempt = 0; ; attempt++) {
      let r, data;
      try {
        r = await getFetch(path, options);
        try {
          data = await r.json();
        } catch {
          data = undefined;
        }
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        r = undefined; // the connection itself failed (host still starting)
      }
      const waking = !r || ([502, 503, 504].includes(r.status) && !data?.error?.code);
      if (waking && attempt < WAKE_TRIES) {
        view.status = { kind: 'waking' };
        paint();
        await new Promise((resolve) => wait(resolve, WAKE_DELAY_MS));
        continue;
      }
      if (!r) {
        const e = new Error('network');
        e.code = 'NETWORK_FAILURE';
        throw e;
      }
      if (!r.ok) {
        const e = new Error(data?.error?.message ?? 'request failed');
        e.code = data?.error?.code ?? 'INTERNAL_ERROR';
        e.retryAfter = r.headers.get('retry-after');
        e.resetAt = data?.error?.reset_at;
        throw e;
      }
      return data ?? {};
    }
  };
  // YYYY-MM-DD HH:MM UTC, or '' when the server gave no usable time (a time is never invented)
  const utc = (iso) => {
    const time = Date.parse(iso ?? '');
    return Number.isFinite(time)
      ? new Date(time).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
      : '';
  };
  const message = (code) => {
    const key = `error.${code}`;
    const text = t(key);
    return text === key ? t('error.default') : text;
  };
  const stageText = (stage) => {
    const key = `stage.${stage}`;
    const text = t(key);
    return text === key ? t('status.running') : text;
  };
  const statusText = (s) => {
    if (!s) return '';
    if (s.kind === 'waking') return t('status.waking');
    if (s.kind === 'sending') return t('status.sending');
    if (s.kind === 'queued')
      return s.position ? t('status.queuedPosition', { n: s.position }) : t('status.queued');
    if (s.kind === 'running')
      return s.stage
        ? t('status.runningStage', { stage: stageText(s.stage) })
        : t('status.running');
    return t(s.kind === 'partial' ? 'status.partial' : 'status.completed');
  };
  function serviceBanner(e) {
    const b = doc.createElement('div');
    b.setAttribute('data-banner', 'service-rate-limited');
    const line = doc.createElement('p');
    const when = utc(e.resetAt);
    line.textContent = `${t('banner.serviceLimited')} ${when ? t('banner.tryAfter', { time: when }) : t('banner.tryLater')}`;
    const code = doc.createElement('code');
    code.setAttribute('data-field', 'cli-fallback');
    code.textContent = view.command;
    const note = doc.createElement('p');
    note.textContent = t('banner.cliFromClone');
    b.append(line, note, code);
    return b;
  }
  function paint() {
    status.textContent = statusText(view.status);
    if (view.error) {
      error.textContent = message(view.error.code);
      if (view.error.code === 'SERVICE_RATE_LIMITED')
        result.replaceChildren(serviceBanner(view.error));
      else if (view.error.code === 'RATE_LIMITED') {
        const b = doc.createElement('p');
        b.setAttribute('data-banner', 'rate-limited');
        b.textContent = view.error.retryAfter
          ? t('banner.rateLimitedRetry', { n: view.error.retryAfter })
          : t('banner.rateLimited');
        result.replaceChildren(b);
      }
    } else error.textContent = '';
    if (view.job) result.replaceChildren(renderResult(doc, view.job));
  }
  const showError = (e) => {
    view.error = { code: e.code, retryAfter: e.retryAfter, resetAt: e.resetAt };
    view.job = null;
    paint();
  };
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
    view.error = null;
    view.job = null;
    view.status = { kind: 'sending' };
    result.replaceChildren();
    paint();
    controller = new Controller();
    view.command = `node dist/cli.js analyze ${n.value} --format json`;
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
          view.status = { kind: 'queued', position: state.queue_position };
        else view.status = { kind: 'running', stage: state.stage };
        paint();
        if (['completed', 'partial', 'failed', 'expired'].includes(state.state)) {
          if (state.state === 'failed' || state.state === 'expired')
            showError({
              code: state.error?.code ?? 'JOB_NOT_FOUND',
              retryAfter: state.error?.retry_after,
              resetAt: state.error?.reset_at,
            });
          else if (state.report) {
            view.job = state;
            view.status = { kind: state.state === 'partial' ? 'partial' : 'completed' };
            paint();
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
  // Results are temporary and not meant to be found through a search engine; the empty landing page stays indexable.
  const noindex = () => {
    if (doc.querySelector('meta[name="robots"]')) return;
    const m = doc.createElement('meta');
    m.setAttribute('name', 'robots');
    m.setAttribute('content', 'noindex');
    doc.head?.append(m);
  };
  form.addEventListener('submit', noindex);
  form.addEventListener('submit', run);
  repo.addEventListener('input', normalise);
  for (const b of doc.querySelectorAll('[data-example]'))
    b.addEventListener('click', () => {
      repo.value = b.getAttribute('data-example') ?? '';
      normalise();
      repo.focus();
    });
  // Language switch: no reload, no request, nothing stored. The static page and what is on screen are repainted.
  const repaintLanguage = () => {
    applyStatic(doc);
    normalise();
    paint();
  };
  const stopListening = onLanguageChange(repaintLanguage);
  for (const b of doc.querySelectorAll('[data-lang]'))
    b.addEventListener('click', () => setLanguage(b.getAttribute('data-lang')));
  applyStatic(doc);
  const params = new URLSearchParams(loc.search);
  if (params.get('repo')) {
    noindex();
    repo.value = params.get('repo');
    if (params.get('ref')) ref.value = params.get('ref');
    normalise();
  }
  return {
    abort: () => controller?.abort(),
    destroy: () => stopListening(),
    language: getLanguage,
  };
}
if (typeof document !== 'undefined') init(document);
