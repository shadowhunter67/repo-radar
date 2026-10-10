export interface TreeEntry {
  path: string;
  type: string;
  size?: number;
}

const SOURCE_EXT =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|rb|php|c|cc|cpp|cxx|h|hpp|cs|swift|scala|ex|exs|dart|lua|zig|sh)$/i;
const VENDOR_DIR =
  /(?:^|\/)(?:node_modules|vendor|third_party|dist|build|target|__pycache__|\.venv|venv|site-packages|\.git|coverage|\.next)\//i;
const TEST_PATH =
  /(?:^|\/)(?:tests?|__tests__|specs?|e2e|integration[-_]tests?)\/|(?:_test\.go|\.test\.[cm]?[jt]sx?|\.spec\.[cm]?[jt]sx?|(?:^|\/)test_[^/]*\.py|_test\.py|_spec\.rb|Tests?\.(?:java|kt|cs)|_test\.rs|_test\.exs?)$/i;

const STATIC_LANGS = new Set([
  'Go',
  'Rust',
  'Java',
  'Kotlin',
  'C',
  'C++',
  'C#',
  'Swift',
  'Scala',
  'TypeScript',
  'Dart',
  'Zig',
]);

export interface TreeFacts {
  fileCount: number;
  sourceFileCount: number;
  testFileCount: number;
  flags: Record<
    | 'security_policy'
    | 'code_of_conduct'
    | 'contributing'
    | 'changelog'
    | 'license_file'
    | 'codeowners'
    | 'issue_templates'
    | 'pr_template'
    | 'dependency_updates'
    | 'lockfile'
    | 'dockerfile'
    | 'sbom_file'
    | 'lint_config'
    | 'type_config'
    | 'env_example'
    | 'docs_dir'
    | 'examples_dir'
    | 'action_yml'
    | 'makefile'
    | 'deploy_config',
    boolean
  >;
  workflowPaths: string[];
  manifestPaths: string[];
  lockPaths: string[];
  topLevelDirs: string[];
}

const MANIFEST_BASENAMES = new Set([
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'Cargo.toml',
]);
const LOCK_BASENAMES = new Set([
  'package-lock.json',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'go.sum',
]);
const ANY_LOCK =
  /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|Gemfile\.lock|composer\.lock|pdm\.lock)$/;

/** Source file (by extension), outside vendored/build directories, tests and docs/examples. */
export function isSourcePath(path: string): boolean {
  return (
    SOURCE_EXT.test(path) &&
    !VENDOR_DIR.test(path) &&
    !TEST_PATH.test(path) &&
    !/^(?:docs?|examples?)\//i.test(path)
  );
}

export function isSafeTreePath(p: string): boolean {
  return (
    p.length > 0 &&
    p.length < 400 &&
    !p.includes('\\') &&
    !p.split('/').some((s) => s === '..' || s === '.' || s === '')
  );
}

export function analyzeTree(entries: TreeEntry[]): TreeFacts {
  const blobs = entries
    .slice(0, 100_000)
    .filter((e) => e.type === 'blob' && isSafeTreePath(e.path));
  const flags = {
    security_policy: false,
    code_of_conduct: false,
    contributing: false,
    changelog: false,
    license_file: false,
    codeowners: false,
    issue_templates: false,
    pr_template: false,
    dependency_updates: false,
    lockfile: false,
    dockerfile: false,
    sbom_file: false,
    lint_config: false,
    type_config: false,
    env_example: false,
    docs_dir: false,
    examples_dir: false,
    action_yml: false,
    makefile: false,
    deploy_config: false,
  };
  const facts: TreeFacts = {
    fileCount: blobs.length,
    sourceFileCount: 0,
    testFileCount: 0,
    flags,
    workflowPaths: [],
    manifestPaths: [],
    lockPaths: [],
    topLevelDirs: [],
  };
  const dirs = new Set<string>();
  for (const { path } of blobs) {
    const base = path.slice(path.lastIndexOf('/') + 1);
    const depth = path.split('/').length - 1;
    if (depth > 0) dirs.add(path.split('/')[0] as string);
    const inRootOrGithub = depth === 0 || path.startsWith('.github/') || path.startsWith('docs/');

    if (SOURCE_EXT.test(path) && !VENDOR_DIR.test(path)) {
      if (TEST_PATH.test(path)) facts.testFileCount++;
      else if (!/^(?:docs?|examples?)\//i.test(path)) facts.sourceFileCount++;
    }
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(path)) facts.workflowPaths.push(path);
    if (depth <= 2 && MANIFEST_BASENAMES.has(base) && !VENDOR_DIR.test(path))
      facts.manifestPaths.push(path);
    if (depth <= 1 && LOCK_BASENAMES.has(base) && !VENDOR_DIR.test(path))
      facts.lockPaths.push(path);

    if (ANY_LOCK.test(path) && depth <= 2) flags.lockfile = true;
    if (inRootOrGithub) {
      if (/^SECURITY(?:\.[a-z]+)?$/i.test(base)) flags.security_policy = true;
      if (/^CODE[_-]OF[_-]CONDUCT(?:\.[a-z]+)?$/i.test(base)) flags.code_of_conduct = true;
      if (/^CONTRIBUTING(?:\.[a-z]+)?$/i.test(base)) flags.contributing = true;
      if (/^(?:CHANGELOG|CHANGES|HISTORY|NEWS|RELEASES?)(?:\.[a-z]+)?$/i.test(base))
        flags.changelog = true;
      if (/^(?:LICEN[CS]E|COPYING|UNLICENSE)(?:[.-][A-Za-z0-9]+)?$/i.test(base))
        flags.license_file = true;
      if (/^CODEOWNERS$/.test(base)) flags.codeowners = true;
    }
    if (
      /^\.github\/ISSUE_TEMPLATE\//i.test(path) ||
      /^(?:\.github\/)?ISSUE_TEMPLATE\.md$/i.test(path)
    )
      flags.issue_templates = true;
    if (/^(?:\.github\/|docs\/)?PULL_REQUEST_TEMPLATE(?:\.md|\/)/i.test(path))
      flags.pr_template = true;
    if (
      /^\.github\/dependabot\.ya?ml$/i.test(path) ||
      /^(?:\.github\/)?renovate\.json5?$/i.test(path) ||
      /^\.renovaterc(?:\.json5?)?$/i.test(path)
    )
      flags.dependency_updates = true;
    if (/^Dockerfile(?:\.[\w.-]+)?$/i.test(base) || /\.dockerfile$/i.test(base))
      flags.dockerfile = true;
    if (
      /(?:^|\/)(?:sbom|bom)(?:\.[a-z-]+)*\.(?:json|xml)$/i.test(path) ||
      /\.(?:spdx|cdx)(?:\.json)?$/i.test(path)
    )
      flags.sbom_file = true;
    if (
      /^(?:\.eslintrc(?:\.[a-z]+)?|eslint\.config\.[cm]?[jt]s|\.golangci\.ya?ml|ruff\.toml|\.ruff\.toml|\.flake8|\.pylintrc|clippy\.toml|\.clippy\.toml|biome\.jsonc?|\.rubocop\.yml|\.php-cs-fixer\.php|phpstan\.neon|\.swiftlint\.yml|detekt\.ya?ml)$/.test(
        base,
      )
    )
      flags.lint_config = true;
    if (
      /^(?:tsconfig(?:\.[\w-]+)?\.json|jsconfig\.json|mypy\.ini|\.mypy\.ini|pyrightconfig\.json|py\.typed)$/.test(
        base,
      )
    )
      flags.type_config = true;
    if (/^\.env\.(?:example|sample|template)$/i.test(base) || /^env\.example$/i.test(base))
      flags.env_example = true;
    if (/^docs?\//i.test(path)) flags.docs_dir = true;
    if (/^examples?\//i.test(path) || /^samples?\//i.test(path)) flags.examples_dir = true;
    if (depth === 0 && /^action\.ya?ml$/.test(base)) flags.action_yml = true;
    if (depth === 0 && /^(?:GNUmakefile|Makefile|makefile)$/.test(base)) flags.makefile = true;
    if (
      /^(?:docker-compose[\w.-]*\.ya?ml|compose\.ya?ml|Chart\.yaml|fly\.toml|vercel\.json|netlify\.toml|Procfile|app\.ya?ml|serverless\.ya?ml|render\.yaml|railway\.json)$/i.test(
        base,
      ) ||
      /^(?:k8s|kubernetes|deploy|helm|charts?)\//i.test(path)
    )
      flags.deploy_config = true;
  }
  facts.topLevelDirs = [...dirs].sort();
  return facts;
}

export function isStaticallyTyped(language: string | undefined): boolean {
  return !!language && STATIC_LANGS.has(language);
}
