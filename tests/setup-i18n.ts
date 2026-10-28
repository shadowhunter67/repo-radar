// The existing Web UI specifications are written against the English strings. The page itself defaults to Vietnamese
// (tests/unit/web-i18n.test.ts proves that), so these suites select English explicitly.
// @ts-expect-error plain browser ES module without type declarations
import { setLanguage } from '../web/public/i18n.js';

setLanguage('en');
