import { LIMITS } from '../limits.js';
import {
  DETECTORS,
  EXEC_FETCHED,
  EXTRACT,
  PIPE_TO_SHELL,
  fileKind,
  isCommentLine,
  type FileKind,
} from './detectors.js';
import type { Chain, Detection, ScannedFile } from './types.js';

export type RawDetection = Omit<Detection, 'id' | 'contexts'>;
export type RawChain = Omit<Chain, 'id' | 'contexts'>;

export interface FileScan {
  path: string;
  kind: FileKind;
  detections: RawDetection[];
  chains: RawChain[];
  linesScanned: number;
  truncated: boolean;
}

const DOWNLOAD_IDS = new Set(['sh.download', 'docker.add-url', 'any.shell-download-string']);
const NET_IDS = new Set(['js.net-client', 'py.net-client', 'go.net-client', 'rs.net-client']);
const EVAL_IDS = new Set(['sh.eval', 'js.eval', 'py.eval']);
const CHMOD_IDS = ['sh.chmod-x', 'js.chmod', 'py.chmod', 'go.chmod', 'rs.chmod'];
/** The steps of a multi-step chain must be close together; unrelated functions far apart are not one path. */
export const CHAIN_WINDOW_LINES = 40;
const MAX_DOWNLOAD_ANCHORS = 6;

/** Line-oriented scan of one file. Pure and bounded: input size and per-line length are capped. */
export function scanFile(file: ScannedFile): FileScan {
  const kind = fileKind(file.path);
  const rawLines = file.content.split('\n', LIMITS.maxLinesPerFile + 1);
  const truncated = rawLines.length > LIMITS.maxLinesPerFile;
  const lines = truncated ? rawLines.slice(0, LIMITS.maxLinesPerFile) : rawLines;
  const detections: RawDetection[] = [];
  const perDetector = new Map<string, number>();
  const hitLines = new Map<string, number[]>();
  const pipeLines: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).replace(/\r$/, '').slice(0, LIMITS.maxLineChars);
    if (!line.trim() || isCommentLine(kind, line)) continue;
    if (PIPE_TO_SHELL.test(line)) pipeLines.push(i + 1);
    for (const d of DETECTORS) {
      if (d.kinds !== '*' && !d.kinds.includes(kind)) continue;
      if (!d.pattern.test(line)) continue;
      const hits = hitLines.get(d.id) ?? [];
      if (hits.length < 20) hits.push(i + 1);
      hitLines.set(d.id, hits);
      // Keep up to two locations per detector per file; more adds noise, not information.
      const n = perDetector.get(d.id) ?? 0;
      if (n >= 2) continue;
      perDetector.set(d.id, n + 1);
      // Persistence or privilege changes inside a container image build do not apply to the user's host.
      const containerOnly =
        kind === 'docker' &&
        ((d.persistence !== undefined && d.persistence !== 'container_restart_policy') ||
          d.capability === 'PRIVILEGE_CHANGE');
      detections.push({
        detector: d.id,
        capability: d.capability,
        mode: containerOnly ? 'POSSIBLE' : d.mode,
        confidence: containerOnly ? Math.min(d.confidence, 0.35) : d.confidence,
        file: file.path,
        line: i + 1,
        ...(d.persistence ? { persistence_kind: d.persistence } : {}),
      });
    }
  }

  return {
    path: file.path,
    kind,
    detections,
    chains: detectChains(file.path, kind, lines, hitLines, pipeLines),
    linesScanned: lines.length,
    truncated,
  };
}

/**
 * Compound findings: a complete download -> (extract) -> make-executable/execute path matters far more
 * than any single keyword. Single-line pipe-to-shell is DIRECT. Multi-step chains are INFERRED and require
 * the steps to sit within CHAIN_WINDOW_LINES lines of a download, so unrelated functions of one big script
 * are not stitched together.
 */
function detectChains(
  path: string,
  kind: FileKind,
  lines: string[],
  hits: Map<string, number[]>,
  pipeLines: number[],
): RawChain[] {
  const chains: RawChain[] = [];
  for (const l of pipeLines.slice(0, 3)) {
    chains.push({
      kind: 'pipe-to-shell',
      mode: 'DIRECT',
      confidence: 0.95,
      file: path,
      lines: [l],
      steps: ['remote download', 'piped directly into a shell/interpreter'],
    });
  }
  if (pipeLines.length > 0) return chains;

  const downloads = [...DOWNLOAD_IDS, ...NET_IDS]
    .flatMap((id) => hits.get(id) ?? [])
    .sort((a, b) => a - b)
    .filter((n, i, arr) => arr.indexOf(n) === i)
    .slice(0, MAX_DOWNLOAD_ANCHORS);
  const chmods = CHMOD_IDS.flatMap((id) => hits.get(id) ?? []).sort((x, y) => x - y);
  const evals = [...EVAL_IDS].flatMap((id) => hits.get(id) ?? []);
  const shellish = kind === 'sh' || kind === 'docker' || kind === 'make' || kind === 'yaml';
  const seen = new Set<string>();
  const push = (c: RawChain): void => {
    if (!seen.has(c.kind)) {
      seen.add(c.kind);
      chains.push(c);
    }
  };
  const within = (n: number, from: number): boolean => n >= from && n <= from + CHAIN_WINDOW_LINES;

  for (const d of downloads) {
    const chmod = chmods.find((n) => within(n, d));
    const evalLine = evals.find((n) => within(n, d));
    const execLine = findExec(lines, d, d + CHAIN_WINDOW_LINES);
    const extract = findMatch(lines, d, d + CHAIN_WINDOW_LINES, EXTRACT);
    if (chmod !== undefined && (execLine !== undefined || shellish)) {
      push({
        kind: 'download-chmod-exec',
        mode: 'INFERRED',
        confidence: execLine !== undefined ? 0.7 : 0.55,
        file: path,
        lines: [d, chmod, ...(execLine !== undefined ? [execLine] : [])],
        steps: [
          'remote download',
          'make executable',
          ...(execLine !== undefined ? ['execute'] : []),
        ],
      });
    }
    if (evalLine !== undefined) {
      push({
        kind: 'download-eval',
        mode: 'INFERRED',
        confidence: 0.5,
        file: path,
        lines: [d, evalLine],
        steps: ['remote download', 'dynamic evaluation'],
      });
    }
    if (extract !== undefined && (chmod !== undefined || execLine !== undefined)) {
      push({
        kind: 'download-extract-exec',
        mode: 'INFERRED',
        confidence: 0.55,
        file: path,
        lines: [
          d,
          extract,
          ...(chmod !== undefined ? [chmod] : []),
          ...(execLine !== undefined ? [execLine] : []),
        ],
        steps: ['remote download', 'extract archive', 'execute'],
      });
    }
  }
  return chains;
}

function findMatch(
  lines: string[],
  fromLine1: number,
  toLine1: number,
  re: RegExp,
): number | undefined {
  for (let i = fromLine1 - 1; i < Math.min(lines.length, toLine1); i++) {
    if (re.test((lines[i] as string).slice(0, LIMITS.maxLineChars))) return i + 1;
  }
  return undefined;
}

function findExec(lines: string[], fromLine1: number, toLine1: number): number | undefined {
  // Start after the download line itself.
  return findMatch(lines, fromLine1 + 1, toLine1, EXEC_FETCHED);
}
