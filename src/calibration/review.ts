import { z } from 'zod';
import { CAPABILITIES } from '../analysis/types.js';
import { ARTIFACT_TYPES } from '../identity/taxonomy.js';
import {
  DependencyLabelSchema,
  FIELD_STATUSES,
  TriSchema,
  type FieldStatus,
  type Label,
} from './schema.js';
import {
  DEPLOYMENT_FORMS,
  INTERFACES,
  PACKAGING,
  PRIMARY_ARTIFACTS,
  SECONDARY_ROLES,
} from '../identity/v2.js';

/**
 * Blind-review support. A reviewer fills the form from scripts/make-review-packets.mjs WITHOUT seeing the analyzer or the
 * existing labels. Only after submission are the two label sets compared; disagreements become an adjudication worksheet.
 * Nothing here can record a review on a reviewer's behalf or mark release gate 14 as satisfied.
 */
export const ReviewSubmissionSchema = z.object({
  reviewer: z.object({
    /** Pseudonymous handle. An e-mail address is rejected: reviews must not carry personal data. */
    id: z
      .string()
      .min(1)
      .max(64)
      .refine((v) => !v.includes('@'), 'use a pseudonymous id, not an e-mail address'),
    kind: z.enum(['human-single', 'human-double']),
    labelled_on: z.string(),
  }),
  /** When the review was completed (ISO 8601). */
  reviewed_at: z.iso.datetime({ offset: true }).optional(),
  /** Version of the label form the reviewer filled in. */
  label_version: z.string().max(32).optional(),
  /** The commit the reviewer actually read; must equal the pinned commit of the label. */
  repo_sha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  /** The reviewer's own confidence in the whole submission. */
  decision_confidence: z.enum(['high', 'medium', 'low']).optional(),
  /** Reviewer attests they did not see repo-radar output or the existing labels before finishing. */
  independent: z.boolean().optional(),
  /** Per-field confidence (field name as in the adjudication worksheet); a low value makes that field `uncertain`. */
  field_confidence: z.record(z.string(), z.enum(['high', 'medium', 'low'])).default({}),
  /** Identity v2 opinion (axes the single-class label cannot express). */
  identity_v2: z
    .object({
      primary_artifact: z.enum(PRIMARY_ARTIFACTS).optional(),
      secondary_roles: z.array(z.enum(SECONDARY_ROLES)).default([]),
      packaging: z.enum(PACKAGING).optional(),
      interfaces: z.array(z.enum(INTERFACES)).default([]),
      deployment_form: z.enum(DEPLOYMENT_FORMS).optional(),
    })
    .optional(),
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
  disagreements: {
    repository: string;
    field: string;
    aiAssisted: string;
    human: string;
    reviewer?: string;
  }[];
  /** Per repository and field: what the reviewers decided together (agreed / disagreed / uncertain / needs_adjudication). */
  consolidated: ConsolidatedField[];
  /** Problems that make a submission unusable (wrong commit, ...). Such submissions are not compared. */
  rejected: { repository: string; reviewer: string; reason: string }[];
}

export interface Opinion {
  reviewer: string;
  value: string;
  confidence?: 'high' | 'medium' | 'low';
}
export interface ConsolidatedField {
  repository: string;
  field: string;
  status: FieldStatus;
  /** The existing (AI-assisted) label value, kept visible but never counted as a human opinion. */
  label_value: string;
  opinions: Opinion[];
}

type Submissions = Map<string, ReviewSubmission | ReviewSubmission[]>;
const asList = (v: ReviewSubmission | ReviewSubmission[] | undefined): ReviewSubmission[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

/** A submission is rejected when it was made against another commit than the one the label is pinned to. */
export function validateSubmission(label: Label, s: ReviewSubmission): string | undefined {
  if (s.repo_sha && s.repo_sha !== label.commit)
    return `reviewed commit ${s.repo_sha.slice(0, 10)} is not the pinned commit ${label.commit.slice(0, 10)}`;
  return undefined;
}

/**
 * Combine human opinions for one field. The AI-assisted label is NOT an opinion: consensus is about humans only.
 * - no decided human opinion: `uncertain`
 * - humans disagree with each other: `disagreed`
 * - humans agree with each other but not with the existing label: `needs_adjudication`
 * - any decided opinion carries low confidence: `uncertain`
 * - humans agree with each other and with the label: `agreed`
 */
export function consolidateField(labelValue: string, opinions: Opinion[]): FieldStatus {
  const decided = opinions.filter((o) => !isUndecided(o.value));
  if (decided.length === 0) return 'uncertain';
  const values = new Set(decided.map((o) => o.value));
  if (values.size > 1) return 'disagreed';
  if (decided.some((o) => o.confidence === 'low')) return 'uncertain';
  return values.has(labelValue) ? 'agreed' : 'needs_adjudication';
}

const DECIDED = new Set(['yes', 'no']);
const isUndecided = (v: unknown): boolean =>
  v === 'unknown' || v === 'disputed' || v === 'not_applicable' || v === undefined;

export function compareReviews(labels: Label[], submissions: Submissions): ReviewComparison {
  const consolidated: ConsolidatedField[] = [];
  const rejected: ReviewComparison['rejected'] = [];
  const fields = new Map<string, FieldAgreement>();
  const disagreements: ReviewComparison['disagreements'] = [];
  const yn = { a: 0, b: 0, both: 0, n: 0, aYes: 0, hYes: 0 };
  let repositories = 0;
  for (const label of labels) {
    const valid: ReviewSubmission[] = [];
    for (const sub of asList(submissions.get(label.repository))) {
      const why = validateSubmission(label, sub);
      if (why)
        rejected.push({ repository: label.repository, reviewer: sub.reviewer.id, reason: why });
      else valid.push(sub);
    }
    if (valid.length === 0) continue;
    repositories++;
    const perField = new Map<string, Opinion[]>();
    const labelValue = new Map<string, string>();
    for (const s of valid) {
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
        const op: Opinion = {
          reviewer: s.reviewer.id,
          value: String(human).replace(/^"|"$/g, ''),
          ...(s.field_confidence[field] ? { confidence: s.field_confidence[field] } : {}),
        };
        perField.set(field, [...(perField.get(field) ?? []), op]);
        labelValue.set(field, String(ai).replace(/^"|"$/g, ''));
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
            reviewer: s.reviewer.id,
          });
        if (DECIDED.has(String(a)) && DECIDED.has(String(h))) {
          yn.n++;
          if (a === 'yes') yn.aYes++;
          if (h === 'yes') yn.hYes++;
          if (a === h) yn.both++;
        }
      }
    }
    for (const [field, opinions] of perField) {
      const lv = labelValue.get(field) ?? 'unknown';
      consolidated.push({
        repository: label.repository,
        field,
        status: consolidateField(lv, opinions),
        label_value: lv,
        opinions,
      });
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
  return {
    repositories,
    fields: [...fields.values()],
    kappaYesNo: kappa,
    disagreements,
    consolidated,
    rejected,
  };
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
    '## Field status (humans only; the AI-assisted label is not an opinion)',
    '',
    ...FIELD_STATUSES.map(
      (st) => `- ${st}: ${c.consolidated.filter((x) => x.status === st).length}`,
    ),
    ...(c.rejected.length > 0
      ? [
          '',
          '## Rejected submissions',
          '',
          ...c.rejected.map((r) => `- ${r.repository} (${r.reviewer}): ${r.reason}`),
        ]
      : []),
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
