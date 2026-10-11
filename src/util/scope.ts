/**
 * Directories that hold independent sample/tooling/test projects rather than what dependents install.
 * Shared by dependency resolution and the execution model so both agree on what counts as "the project".
 */
export const AUXILIARY_DIR =
  /(?:^|\/)(?:examples?|docs?|website|tests?|tools|scripts|benchmarks?|e2e|fixtures?|testdata|samples?|demos?)\//i;
