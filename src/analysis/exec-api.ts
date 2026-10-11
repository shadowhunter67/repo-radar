import type { ExecEdge, ExecNode, Hook } from './execution.js';
import type { Capability, ExecContext, ScannedFile } from './types.js';

/**
 * What an ecosystem-specific execution model (Python, JVM, ...) needs from the shared execution-graph builder.
 * Kept narrow so each model stays testable and cannot reach into graph internals.
 */
export interface ExecApi {
  addNode(n: Omit<ExecNode, 'id'>): string;
  addEdge(e: ExecEdge): void;
  followFile(
    path: string,
    from: string,
    ctx: ExecContext,
    visited: Set<string>,
    depth: number,
    edgeMeta?: Partial<ExecEdge>,
  ): { unanalyzed: number; node?: string };
  finishHook(
    h: Omit<Hook, 'risk' | 'confidence' | 'capabilities' | 'chain_ids' | 'files' | 'analyzed'>,
    paths: string[],
    unanalyzed: number,
    anyAnalyzed: boolean,
  ): void;
  hooks: Hook[];
  nextHookId(): string;
  /** Capabilities (non-POSSIBLE) the detectors find in an already scanned or scannable file. */
  scanCapabilities(path: string): Capability[];
  /**
   * Scan text that is not a repository file (a plugin configuration, a Gradle task body) as if it were a script, under a
   * pseudo path such as `pom.xml#plugin.exec-maven-plugin`; the pseudo path can then be passed to `finishHook` as a file.
   */
  scanPseudo(path: string, content: string): Capability[];
  byPath: ReadonlyMap<string, ScannedFile>;
  tree: ReadonlySet<string>;
}
