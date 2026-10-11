import { z } from 'zod';
import { CAPABILITIES } from '../analysis/types.js';
import { ARTIFACT_TYPES } from '../identity/taxonomy.js';
import { DependencyLabelSchema, TriSchema, type Label } from './schema.js';

/**
 * Blind-review support. A reviewer fills the form from scripts/make-review-packets.mjs WITHOUT seeing the analyzer or the
 * existing labels. Only after submission are the two label sets compared; disagreements become an adjudication worksheet.
 * Nothing here can record a review on a reviewer's behalf or mark release gate 14 as satisfied.
 */
export const ReviewSubmissionSchema = z.object({
  reviewer: z.object({
    id: z.string().min(1),
    kind: z.enum(['human-single', 'human-double']),
    labelled_on: z.string(),
  }),
  artifact_type: z.union([z.enum(ARTIFACT_TYPES), z.literal('disputed')]),
  artifact_also_acceptable: z.array(z.enum(ARTIFACT_TYPES)).default([]),
  domain: z.string(),
  capabilities: z.partialRecord(z.enum(CAPABILITIES), TriSchema),
  install_hooks: z.object({ automatic: TriSchema, names: z.array(z.string()).default([]) }),
  persistence: TriSchema,
  hard_coded_secrets: TriSchema,
  dependencies: DependencyLabelSchema.optional(),
  notes: z.string().default(''),
});
export type ReviewSubmission = z.infer<typeof ReviewSubmissionSchema>;

export interface FieldAgreement {
  field: string;
  /** Pairs where both sides gave a decided value (not unknown/disputed/not_applicable). */
  comparable: number;
  agree: number;
  /** At least one side said unknown/disputed: kept visible, never counted as agreement. */
  undecided: number;
}

export interface ReviewComparison {
  repositories: number;
  fields: FieldAgreement[];
  /** Cohen's kappa over all decided yes/no pairs of the tri-state fields (null when undefined). */
  kappaYesNo: number | null;
  /** The adjudication worksheet: every decided disagreement. */
  disagreements: { repository: string; field: string; aiAssisted: string; human: string }[];
}

const DECIDED = new Set(['yes', 'no']);
const isUndecided = (v: unknown): boolean =>
  v === 'unknown' || v === 'disputed' || v === 'not_applicable' || v === undefined;

export function compareReviews(
  labels: Label[],
  submissions: Map<string, ReviewSubmission>,
): ReviewComparison {
  const fields = new Map<string, FieldAgreement>();
  const disagreements: ReviewComparison['disagreements'] = [];
  const yn = { a: 0, b: 0, both: 0, n: 0, aYes: 0, hYes: 0 };
  let repositories = 0;
  for (const label of labels) {
    const s = submissions.get(label.repository);
    if (!s) continue;
    repositories++;
    const pairs: [string, unknown, unknown][] = [
      ['artifact_type', label.artifact_type, s.artifact_type],
      ['domain', label.domain, s.domain],
      ['install_hooks.automatic', label.install_hooks.automatic, s.install_hooks.automatic],
      ['persistence', label.persistence, s.persistence],
      ['hard_coded_secrets', label.hard_coded_secrets, s.hard_coded_secrets],
      ...CAPABILITIES.map((c): [string, unknown, unknown] => [
        `capability:${c}`,
        label.capabilities[c],
        s.capabilities[c],
      ]),
    ];
    if (label.dependencies && s.dependencies)
      for (const k of Object.keys(
        DependencyLabelSchema.shape,
      ) as (keyof typeof label.dependencies)[])
        pairs.push([
          `dependencies.${k}`,
          JSON.stringify(label.dependencies[k]),
          JSON.stringify(s.dependencies[k]),
        ]);
    for (const [field, ai, human] of pairs) {
      const f = fields.get(field) ?? { field, comparable: 0, agree: 0, undecided: 0 };
      fields.set(field, f);
      const cleaned = (v: unknown): unknown =>
        typeof v === 'string' ? v.replace(/^"|"$/g, '') : v;
      const a = cleaned(ai);
      const h = cleaned(human);
      if (isUndecided(a) || isUndecided(h)) {
        f.undecided++;
        continue;
      }
      f.comparable++;
      if (String(a) === String(h)) f.agree++;
      else
        disagreements.push({
          repository: label.repository,
          field,
          aiAssisted: String(a),
          human: String(h),
        });
      if (DECIDED.has(String(a)) && DECIDED.has(String(h))) {
        yn.n++;
        if (a === 'yes') yn.aYes++;
        if (h === 'yes') yn.hYes++;
        if (a === h) yn.both++;
      }
    }
  }
  let kappa: number | null = null;
  if (yn.n > 0) {
    const po = yn.both / yn.n;
    const pa = yn.aYes / yn.n;
    const ph = yn.hYes / yn.n;
    const pe = pa * ph + (1 - pa) * (1 - ph);
    kappa = pe === 1 ? null : (po - pe) / (1 - pe);
  }
  return { repositories, fields: [...fields.values()], kappaYesNo: kappa, disagreements };
}

export function renderAdjudication(c: ReviewComparison): string {
  const lines = [
    '# Adjudication worksheet',
    '',
    `${c.repositories} repositories reviewed. Cohen's kappa over decided yes/no pairs: ${c.kappaYesNo === null ? 'n/a' : c.kappaYesNo.toFixed(2)}.`,
    '',
    'Resolve each row by re-reading the pinned source, record the agreed value in the label file, and note who decided and why.',
    'If the two reviewers still disagree after discussion, label the field `disputed`: it is then excluded from metrics.',
    '',
    '| repository | field | AI-assisted label | human label | agreed value | decided by / reason |',
    '| --- | --- | --- | --- | --- | --- |',
    ...c.disagreements.map(
      (d) => `| ${d.repository} | ${d.field} | ${d.aiAssisted} | ${d.human} | | |`,
    ),
    '',
    '## Agreement by field',
    '',
    '| field | comparable | agree | undecided |',
    '| --- | --- | --- | --- |',
    ...c.fields.map((f) => `| ${f.field} | ${f.comparable} | ${f.agree} | ${f.undecided} |`),
    '',
  ];
  return lines.join('\n');
}
