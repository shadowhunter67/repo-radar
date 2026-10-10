import { z } from 'zod';
import { EvidenceSchema } from './evidence/types.js';
import { ReportSchema } from './report/schema.js';
import { ProfileSchema, RuleFileSchema } from './scoring/types.js';

/** JSON Schemas published in schemas/ are generated from the zod definitions (single source of truth). */
export function buildJsonSchemas(): Record<string, object> {
  const out = (s: z.ZodType, io: 'input' | 'output', title: string): object => ({
    ...z.toJSONSchema(s, { io, target: 'draft-2020-12' }),
    title,
  });
  return {
    'report.schema.json': out(ReportSchema, 'output', 'repo-radar report'),
    'evidence.schema.json': out(EvidenceSchema, 'output', 'repo-radar evidence item'),
    'rules.schema.json': out(RuleFileSchema, 'input', 'repo-radar rule file'),
    'profile.schema.json': out(ProfileSchema, 'input', 'repo-radar profile'),
  };
}
