/* global setTimeout */
import { post, report } from './_lib.mjs';
setTimeout(() => post({ type: 'result', report }), 150);
