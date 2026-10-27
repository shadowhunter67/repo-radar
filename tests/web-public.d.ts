declare module '*.js' {
  export const normaliseRepository: (
    value: unknown,
  ) => { owner: string; repo: string; value: string } | null;
  export const overview: (document: Document, data: unknown) => HTMLElement;
  export const score: (document: Document, data: unknown) => HTMLElement;
  export const findings: (document: Document, data: unknown) => HTMLElement;
  export const details: (document: Document, data: unknown) => HTMLElement;
  export const init: (document: Document, deps?: Record<string, unknown>) => unknown;
}
