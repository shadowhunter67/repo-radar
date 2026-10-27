// Deterministic server for the browser e2e: the REAL web server and the REAL static UI from dist/, with the analysis runner
// replaced by a function that returns a real engine report committed as a fixture (spf13/cobra). No network is used.
import { readFileSync } from 'node:fs';
import { loadWebConfig } from '../../dist/web/config.js';
import { createWebServer } from '../../dist/web/server.js';

const report = JSON.parse(
  readFileSync(new URL('../fixtures/web/report-cobra.json', import.meta.url), 'utf8'),
);
const config = loadWebConfig({ PORT: '4173', HOST: '127.0.0.1', NODE_ENV: 'development' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createWebServer({
  config,
  runAnalysis: async (repo, onStage) => {
    if (repo.repo === 'missing') {
      const e = new Error('not found');
      e.code = 'REPOSITORY_NOT_FOUND';
      throw e;
    }
    onStage('repository_resolved');
    await wait(150);
    onStage('dependencies_parsed');
    await wait(150);
    onStage('report_built');
    return report;
  },
});
server.listen(config.port, config.host, () =>
  console.log('e2e fixture server on http://127.0.0.1:4173'),
);
/* global URL, setTimeout, console */
