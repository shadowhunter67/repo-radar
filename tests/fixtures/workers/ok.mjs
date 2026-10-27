import { post, report } from './_lib.mjs';
post({ type: 'stage', stage: 'repository_resolved' });
post({ type: 'result', report });
