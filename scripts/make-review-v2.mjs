import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const cases = JSON.parse(readFileSync('calibration/incidents-v3/cases.json', 'utf8'));
const root = 'calibration/review-v2';
mkdirSync(join(root, 'packets'), { recursive: true });
const packets = [];
for (const c of cases) {
  const packet = {
    packet_version: 2,
    corpus: 'incident-review-v2',
    case_id: c.id,
    package: c.package,
    ecosystem: c.ecosystem,
    version_before: c.version_before,
    version_after: c.version_after,
    blind: 'No analyzer prediction, AI label, or conclusion.',
    reviewer_id: '',
    opinions: {
      label: '',
      incident_mechanism: '',
      artifact_provenance_quality: '',
      dependency_history_ground_truth: '',
    },
    timestamp: '',
    free_text: '',
  };
  const name = `${c.id}.json`;
  writeFileSync(join(root, 'packets', name), JSON.stringify(packet, null, 2) + '\n');
  packets.push({ case_id: c.id, packet: `packets/${name}` });
}
writeFileSync(
  join(root, 'index.json'),
  JSON.stringify(
    { packet_version: 2, corpus: 'incident-review-v2', blind: true, packets },
    null,
    2,
  ) + '\n',
);
process.stdout.write(`wrote ${packets.length} v2 review packets\n`);
