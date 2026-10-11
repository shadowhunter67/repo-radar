import { z } from 'zod';

/**
 * Ecosystem-neutral execution model shared by npm, Python, Cargo and (Phase 6) Maven/Gradle.
 *
 * Three independent questions are answered for every place where repository-controlled or tool-controlled code can run:
 *  - STAGE:       which phase of the software lifecycle it belongs to;
 *  - TRIGGER:     what makes it run (the package manager by itself, a build tool someone invoked, the user, CI, ...);
 *  - ENVIRONMENT: where it runs.
 * Keeping them apart avoids the classic mistakes: calling a console-script entry point "install-time execution", or
 * treating every build step as if it ran on the user's host.
 */
export const EXEC_STAGES = [
  /** The package manager runs a script supplied by the package while installing it (npm lifecycle, install.sh). */
  'INSTALL_SCRIPT',
  /** Building from source (sdist, git checkout, `cargo install`): the umbrella for the stages below. */
  'SOURCE_BUILD',
  /** A PEP 517 build backend (or equivalent) is imported and its hooks are called. */
  'BUILD_BACKEND',
  /** Legacy `setup.py` executed by setuptools. */
  'LEGACY_SETUP',
  /** Compilers / native build systems (C, C++, Rust, Cython, CMake, Meson, ...). */
  'NATIVE_BUILD',
  /** The installer writes a launcher for an entry point; the entry point itself runs later. */
  'INSTALL_GENERATED_ENTRYPOINT',
  /** Normal use of the installed software. */
  'RUNTIME',
  'TEST',
  'CI',
  'UNKNOWN',
] as const;
export type ExecStage = (typeof EXEC_STAGES)[number];

export const EXEC_TRIGGERS = [
  /** The package manager runs it on its own (npm lifecycle scripts). */
  'AUTOMATIC',
  /** A build tool that someone invoked loads and runs it (pip -> build backend, cargo -> build.rs, mvn -> plugin). */
  'BUILD_TOOL_INVOKED',
  /** A person (or a program of theirs) runs it explicitly: installed CLI, install.sh, make target. */
  'USER_INVOKED',
  'CI_INVOKED',
  /** Loaded by the running software (plugin entry-point groups, dynamic imports). */
  'RUNTIME',
  'UNKNOWN',
] as const;
export type ExecTrigger = (typeof EXEC_TRIGGERS)[number];

export const EXEC_ENVIRONMENTS = [
  'HOST',
  /** An isolated, temporary build environment (PEP 517 build isolation, a Maven/Gradle daemon). */
  'BUILD_ENVIRONMENT',
  'VIRTUAL_ENV',
  'CONTAINER',
  'CI_RUNNER',
  'UNKNOWN',
] as const;
export type ExecEnvironment = (typeof EXEC_ENVIRONMENTS)[number];

export const ExecStageSchema = z.enum(EXEC_STAGES);
export const ExecTriggerSchema = z.enum(EXEC_TRIGGERS);
export const ExecEnvironmentSchema = z.enum(EXEC_ENVIRONMENTS);

/** A command or module the installer or build tool exposes to the user. It does NOT run during installation. */
export const EntrypointSchema = z.object({
  id: z.string(),
  ecosystem: z.enum(['npm', 'pypi', 'cargo']),
  name: z.string(),
  kind: z.enum(['console_script', 'gui_script', 'bin', 'plugin_group']),
  /** `package.module:callable` (Python), the bin file (npm) or the crate binary name (Cargo). */
  target: z.string(),
  /** Repository file the target resolves to, when it could be found in the git tree. */
  file: z.string().optional(),
  /** Whether the callable is defined in the resolved file (undefined = not checked / file not read). */
  callable_found: z.boolean().optional(),
  stage: ExecStageSchema,
  trigger_kind: ExecTriggerSchema,
  environment: ExecEnvironmentSchema,
  /** Always false: an entry point is not executed by installation. */
  automatic: z.literal(false),
  manifest: z.string(),
  /** Capabilities observed in the resolved file (static, may be empty). */
  capabilities: z.array(z.string()),
});
export type Entrypoint = z.infer<typeof EntrypointSchema>;

/** One build project (a directory with a build system) and what its build system can execute. */
export const BuildProjectSchema = z.object({
  id: z.string(),
  ecosystem: z.enum(['pypi', 'cargo', 'npm', 'maven', 'gradle']),
  dir: z.string(),
  /** Build-system identifier, e.g. `setuptools.build_meta`, `hatchling.build`, `maven`. */
  build_system: z.string().optional(),
  /** known_declarative: well-known backend that runs no repository code by itself. */
  kind: z.enum([
    'known_declarative',
    'known_with_repository_code',
    'in_tree_custom',
    'external_custom',
    'legacy_default',
    'unknown',
  ]),
  /** Repository-controlled code (setup.py, an in-tree backend, a custom build hook, build.rs, a plugin script) can run. */
  repository_code_runs: z.boolean(),
  native_build_systems: z.array(z.string()),
  /** Why a file that looks relevant is not part of the path (e.g. setup.py bypassed by another backend). */
  bypassed: z.array(z.string()),
  requires: z.array(z.string()),
  hook_ids: z.array(z.string()),
  notes: z.array(z.string()),
});
export type BuildProject = z.infer<typeof BuildProjectSchema>;
