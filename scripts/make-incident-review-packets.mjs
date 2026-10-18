import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'calibration', 'incidents');
const cases = JSON.parse(readFileSync(join(root, 'cases.json'), 'utf8'));
const out = join(root, 'review');
mkdirSync(join(out, 'packets'), { recursive: true });
const index = [];
for (const c of cases.filter(
  (x) => x.id.endsWith('-v2-history') || x.id.endsWith('-incident-window'),
)) {
  const packet = {
    packet_version: 1,
    corpus: 'incident-calibration-v2',
    case_id: c.id,
    package: c.package,
    ecosystem: c.ecosystem,
    raw_file: c.raw_file,
    incident_window: c.incident_window,
    known_good_window: c.known_good_window,
    resolved_version_candidates: c.resolved_version_candidates,
    blind:
      'This packet contains no analyzer output, label, conclusion, reviewer name, or claimed independent validation.',
    reviewer: '',
    label: '',
    conclusion: '',
    notes: '',
  };
  const name = `${c.id}.json`;
  writeFileSync(join(out, 'packets', name), JSON.stringify(packet, null, 2) + '\n');
  index.push({ case_id: c.id, packet: `packets/${name}` });
}
writeFileSync(
  join(out, 'index.json'),
  JSON.stringify(
    { packet_version: 2, corpus: 'incident-calibration-v2', blind: true, packets: index },
    null,
    2,
  ) + '\n',
);
process.stdout.write(`wrote ${index.length} blind incident packets\n`);
