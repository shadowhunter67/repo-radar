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
    card(
      'Score',
      `${data.overall.score} (${data.overall.grade})`,
      'A score is an evidence-derived heuristic, not a probability of safety.',
    ),
    card(
      'Confidence',
      String(data.overall.confidence),
      'Confidence describes evidence coverage and agreement.',
    ),
    card(
      'Coverage',
      `${Math.round(data.overall.weight_covered * 100)}%`,
      'Findings and “not observed” statements apply only to analyzed evidence.',
    ),
  );
  return wrap;
}
