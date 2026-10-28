import { t } from '../i18n.js';
export function score(document, data) {
  const wrap = document.createElement('section');
  wrap.className = 'grid';
  const card = (title, value, detail) => {
    const s = document.createElement('section');
    s.className = 'card';
    const h = document.createElement('h2');
    h.textContent = title;
    s.append(h);
    const v = document.createElement('p');
    v.className = 'score neutral';
    v.textContent = value;
    s.append(v);
    const d = document.createElement('p');
    d.textContent = detail;
    s.append(d);
    return s;
  };
  wrap.append(
    card(t('section.score'), `${data.overall.score} (${data.overall.grade})`, t('score.note')),
    card(t('section.confidence'), String(data.overall.confidence), t('confidence.note')),
    card(
      t('section.coverage'),
      `${Math.round(data.overall.weight_covered * 100)}%`,
      t('coverage.note'),
    ),
  );
  return wrap;
}
