import { LIMITS } from '../limits.js';
import type { ScannedFile, SecretCandidate } from './types.js';

/**
 * High-precision secret patterns. Reports NEVER carry the secret: only a type, a location and a
 * redacted form (at most the first four characters). Generic "key = value" assignments are reported
 * as POSSIBLE only and are excluded from scoring.
 */
interface SecretPattern {
  type: string;
  mode: 'DIRECT' | 'POSSIBLE';
  confidence: number;
  pattern: RegExp;
  /** Reveal a prefix of the match in the redacted form (never for private keys). */
  prefix: boolean;
}

const PLACEHOLDER =
  /(?:example|sample|dummy|changeme|change_me|your[_-]|placeholder|xxxx|\*{3,}|<[^>]+>|\$\{|\{\{|process\.env|os\.environ|todo|fake|test)/i;

export const SECRET_PATTERNS: SecretPattern[] = [
  {
    type: 'aws-access-key-id',
    mode: 'DIRECT',
    confidence: 0.85,
    prefix: true,
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    type: 'github-token',
    mode: 'DIRECT',
    confidence: 0.95,
    prefix: true,
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b/,
  },
  {
    type: 'private-key-block',
    mode: 'DIRECT',
    confidence: 0.95,
    prefix: false,
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/,
  },
  {
    type: 'slack-token',
    mode: 'DIRECT',
    confidence: 0.9,
    prefix: true,
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  },
  {
    type: 'google-api-key',
    mode: 'DIRECT',
    confidence: 0.8,
    prefix: true,
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    type: 'stripe-live-key',
    mode: 'DIRECT',
    confidence: 0.9,
    prefix: true,
    pattern: /\b[sr]k_live_[0-9A-Za-z]{20,}\b/,
  },
  {
    type: 'database-url-with-password',
    mode: 'DIRECT',
    confidence: 0.75,
    prefix: false,
    pattern:
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s:@/'"]{1,64}:[^\s@/'"]{4,}@[^\s'"]{1,200}/,
  },
  {
    type: 'generic-credential-assignment',
    mode: 'POSSIBLE',
    confidence: 0.35,
    prefix: false,
    pattern:
      /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|passwd|password)\b\s*[:=]\s*['"][A-Za-z0-9/+_=-]{20,}['"]/i,
  },
];

/** File names that are secret-bearing by convention, reported from the tree without reading content. */
const SECRET_FILENAMES: { type: string; re: RegExp }[] = [
  {
    type: 'committed-env-file',
    re: /(?:^|\/)\.env(?:\.(?:local|production|prod|development|staging))?$/,
  },
  {
    type: 'key-material-file',
    re: /(?:^|\/)(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$|\.(?:pem|p12|pfx|jks|keystore)$/i,
  },
  {
    type: 'credentials-file',
    re: /(?:^|\/)(?:\.netrc|\.git-credentials|credentials\.json|service[-_]account[^/]*\.json)$/i,
  },
];

const TEST_OR_EXAMPLE =
  /(?:^|\/)(?:tests?|testing|testdata|testserver|test-server|__tests__|e2e|spec|fixtures?|examples?|samples?|docs?|mocks?|node_modules)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|_test\.go$/i;

export const isTestOrExample = (path: string): boolean => TEST_OR_EXAMPLE.test(path);

// Markers with which a project declares that a flagged line is an intentional, allowed value (secret scanners'
// own inline suppressions). We cannot verify the claim, so such a line is kept but never scored.
const DECLARED_ALLOWED = /gitleaks:allow|pragma:\s*allowlist\s*secret|nosecret|trufflehog:ignore/i;

export function redact(match: string, prefix: boolean): string {
  if (!prefix) return '[redacted]';
  return `${match.slice(0, 4)}${'*'.repeat(8)}`;
}

export function scanSecretsInFile(
  file: ScannedFile,
  out: SecretCandidate[],
  counter: { n: number },
): void {
  const testish = isTestOrExample(file.path);
  const lines = file.content.split('\n', LIMITS.maxLinesPerFile);
  for (let i = 0; i < lines.length; i++) {
    if (out.length >= LIMITS.maxSecretCandidates) return;
    const line = (lines[i] as string).slice(0, LIMITS.maxLineChars);
    for (const p of SECRET_PATTERNS) {
      const m = p.pattern.exec(line);
      if (!m) continue;
      if (PLACEHOLDER.test(m[0]) || (p.mode === 'POSSIBLE' && PLACEHOLDER.test(line))) continue;
      out.push({
        id: `SEC-${String(++counter.n).padStart(4, '0')}`,
        type: p.type,
        mode: p.mode === 'DIRECT' && DECLARED_ALLOWED.test(line) ? 'POSSIBLE' : p.mode,
        confidence: testish ? Math.min(p.confidence, 0.4) : p.confidence,
        file: file.path,
        line: i + 1,
        redacted: redact(m[0], p.prefix),
        in_test_or_example: testish,
      });
      break; // one candidate per line
    }
  }
}

const PRIVATE_KEY_NAME =
  /(?:^|\/)(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$|(?:priv|secret|key)[^/]*$|\.(?:p12|pfx|jks|keystore)$/i;

/** Filename-only candidates from the git tree (content is never fetched for these). */
export function secretFilenameCandidates(
  paths: string[],
  out: SecretCandidate[],
  counter: { n: number },
): void {
  for (const path of paths) {
    if (out.length >= LIMITS.maxSecretCandidates) return;
    const testish = isTestOrExample(path);
    for (const f of SECRET_FILENAMES) {
      if (!f.re.test(path)) continue;
      out.push({
        id: `SEC-${String(++counter.n).padStart(4, '0')}`,
        type: f.type,
        // A .pem/.crt-style name alone does not say whether it holds a private key (often a public certificate).
        mode:
          f.type === 'key-material-file' && !PRIVATE_KEY_NAME.test(path) ? 'POSSIBLE' : 'DIRECT',
        confidence: testish ? 0.3 : 0.6,
        file: path,
        line: 0,
        redacted: '[file name only]',
        in_test_or_example: testish,
      });
      break;
    }
  }
}
