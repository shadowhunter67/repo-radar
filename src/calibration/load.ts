import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { DatasetSchema, LabelSchema, assignSplit, type Label } from './schema.js';

/**
 * Label files hold only the reviewer's judgments. `commit`, `split` and `tuned_on` are DERIVED from pins.json and
 * dataset.yaml (single source of truth); if a label file states them, they must agree.
 */
export const LabelFileSchema = LabelSchema.partial({
  commit: true,
  split: true,
  tuned_on: true,
  review: true,
  labelled_on: true,
});

export const PinsSchema = z.object({
  dataset_version: z.string(),
  repos: z.record(
    z.string(),
    z.object({
      commit: z.string().optional(),
      branch: z.string().optional(),
      pinned_on: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
});

const DatasetFileSchema = DatasetSchema.extend({
  review_defaults: z.object({
    kind: z.enum(['ai-assisted-single', 'human-single', 'human-double']),
    method: z.string(),
    reviewers: z.array(z.string()).min(1),
    labelled_on: z.string(),
  }),
});
export type DatasetFile = z.infer<typeof DatasetFileSchema>;

export interface LoadedCorpus {
  dataset: DatasetFile;
  pins: z.infer<typeof PinsSchema>;
  labels: Label[];
  problems: string[];
}

export function loadCorpus(calibrationDir: string): LoadedCorpus {
  const dataset = DatasetFileSchema.parse(
    parse(readFileSync(join(calibrationDir, 'dataset.yaml'), 'utf8')),
  );
  const pins = PinsSchema.parse(
    JSON.parse(readFileSync(join(calibrationDir, 'pins.json'), 'utf8')),
  );
  const problems: string[] = [];
  const byRepo = new Map(dataset.repositories.map((r) => [r.repo, r]));
  const labels: Label[] = [];
  const dir = join(calibrationDir, 'labels');
  let files: string[] = [];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.yaml'))
      .sort();
  } catch {
    problems.push('labels/ directory missing');
  }
  const seen = new Set<string>();
  for (const f of files) {
    const parsed = LabelFileSchema.safeParse(parse(readFileSync(join(dir, f), 'utf8')));
    if (!parsed.success) {
      problems.push(
        `${f}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
      continue;
    }
    const raw = parsed.data;
    const entry = byRepo.get(raw.repository);
    const pin = pins.repos[raw.repository]?.commit;
    if (f !== `${raw.repository.replace('/', '__')}.yaml`)
      problems.push(`${f}: file name does not match repository ${raw.repository}`);
    if (!entry) problems.push(`${f}: ${raw.repository} is not in dataset.yaml`);
    if (!pin) problems.push(`${f}: ${raw.repository} has no pinned commit`);
    if (!entry || !pin) continue;
    if (seen.has(raw.repository)) problems.push(`${f}: duplicate label for ${raw.repository}`);
    seen.add(raw.repository);
    const tuned = entry.tuned_on === true;
    const split = dataset.fixed_split ?? assignSplit(raw.repository, tuned);
    if (raw.commit && raw.commit !== pin)
      problems.push(`${f}: commit ${raw.commit} differs from pin ${pin}`);
    if (raw.split && raw.split !== split)
      problems.push(`${f}: split ${raw.split} differs from rule result ${split}`);
    if (raw.tuned_on !== undefined && raw.tuned_on !== tuned)
      problems.push(`${f}: tuned_on differs from dataset.yaml`);
    const merged = LabelSchema.safeParse({
      ...raw,
      commit: pin,
      split,
      tuned_on: tuned,
      review: raw.review ?? {
        kind: dataset.review_defaults.kind,
        method: dataset.review_defaults.method,
        reviewers: dataset.review_defaults.reviewers,
      },
      labelled_on: raw.labelled_on ?? dataset.review_defaults.labelled_on,
    });
    if (merged.success) labels.push(merged.data);
    else problems.push(`${f}: ${merged.error.issues.map((i) => i.message).join('; ')}`);
  }
  for (const r of dataset.repositories)
    if (!seen.has(r.repo)) problems.push(`${r.repo}: no label file`);
  return { dataset, pins, labels, problems };
}
