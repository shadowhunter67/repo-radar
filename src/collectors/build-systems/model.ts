import { z } from 'zod';
export const BuildDependencySchema = z.object({
  name: z.string().max(200),
  source: z.string().max(500).nullable(),
  checksum: z.string().max(300).nullable(),
  pinned: z.boolean(),
  mutable_ref: z.boolean(),
  dynamic: z.boolean(),
});
export type BuildDependency = z.infer<typeof BuildDependencySchema>;
export const BuildSourceFileSchema = z.object({
  system: z.enum(['bazel', 'nix', 'buck']),
  path: z.string().max(300),
  dependencies: z.array(BuildDependencySchema).max(500),
  target_count: z.number().int().min(0),
  rule_kinds: z.array(z.string().max(80)).max(100),
  remote_source_count: z.number().int().min(0),
  unparsed_dynamic: z.number().int().min(0),
  signals: z.array(z.string().max(100)).max(20),
});
export const BuildSourcesSchema = z.object({
  version: z.literal('1'),
  status: z.enum(['analyzed', 'not_scanned', 'disabled']),
  files: z.array(BuildSourceFileSchema).max(40),
  remote_source_unpinned: z.boolean().nullable(),
  declared_paths: z.array(z.string().max(300)).max(100),
  rejected_paths: z.number().int().min(0),
  not_available: z.array(z.string().max(200)).max(8),
});
export type BuildSources = z.infer<typeof BuildSourcesSchema>;
export const EMPTY_BUILD_SOURCES: BuildSources = {
  version: '1',
  status: 'disabled',
  files: [],
  remote_source_unpinned: null,
  declared_paths: [],
  rejected_paths: 0,
  not_available: [],
};
