import { z } from 'zod';
import {
  compareCandidates,
  POPULAR_PACKAGE_SEEDS,
  type NameComparison,
  type NameEcosystem,
} from './names.js';
export const NameSignalSchema = z.object({
  target: z.string().max(214),
  candidate: z.string().max(214),
  ecosystem: z.enum(['npm', 'pypi', 'crates.io']),
  signals: z.array(z.string()).max(7),
  distance: z.number().int().nullable(),
  suppressed: z.boolean(),
  suppression_reason: z.string().nullable(),
  evidence: z.array(z.string()).max(5),
});
export const NameIntelligenceSchema = z.object({
  version: z.literal('1'),
  status: z.enum(['disabled', 'analyzed']),
  eligible: z.number().int().min(0),
  compared: z.number().int().min(0),
  signals: z.array(NameSignalSchema).max(200),
  not_available: z.array(z.string().max(200)).max(8),
});
export type NameIntelligence = z.infer<typeof NameIntelligenceSchema>;
export const EMPTY_NAME_INTELLIGENCE: NameIntelligence = {
  version: '1',
  status: 'disabled',
  eligible: 0,
  compared: 0,
  signals: [],
  not_available: [],
};
export function analyzeNames(
  targets: { name: string; ecosystem: NameEcosystem; evidence?: string }[],
  candidates: {
    name: string;
    ecosystem: NameEcosystem;
    history?: { sameRepositoryNames?: string[]; deprecatedUse?: string | null };
  }[],
): NameIntelligence {
  const all = [
    ...candidates,
    ...Object.entries(POPULAR_PACKAGE_SEEDS).flatMap(([ecosystem, names]) =>
      names.map((name) => ({ name, ecosystem: ecosystem as NameEcosystem })),
    ),
  ];
  const signals: NameIntelligence['signals'] = [];
  let compared = 0;
  for (const t of targets.slice(0, 25)) {
    const rows: NameComparison[] = compareCandidates(t, all);
    compared += all.filter((c) => c.ecosystem === t.ecosystem && c.name !== t.name).length;
    for (const r of rows)
      signals.push({
        target: t.name,
        candidate: r.right,
        ecosystem: r.ecosystem,
        signals: r.signals,
        distance: r.distance,
        suppressed: r.suppressed,
        suppression_reason: r.suppression_reason,
        evidence: [t.evidence ?? `dependency:${t.ecosystem}:${t.name}`],
      });
  }
  return {
    version: '1',
    status: 'analyzed',
    eligible: targets.length,
    compared,
    signals: signals.slice(0, 200),
    not_available: [],
  };
}
