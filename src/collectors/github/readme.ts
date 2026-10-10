export interface ReadmeFacts {
  lengthChars: number;
  hasInstall: boolean;
  hasUsage: boolean;
  hasConfigDocs: boolean;
  hasDeployDocs: boolean;
  codeBlockCount: number;
  /** First prose paragraph (badges/images/html stripped), if one of useful length exists. */
  purposeStatement?: string;
}

const MAX_README = 200_000;

export function analyzeReadme(raw: string): ReadmeFacts {
  const text = raw.slice(0, MAX_README);
  const heading = (re: string): boolean =>
    new RegExp(`^#{1,4}[ \\t]*[^\\n]{0,40}?(?:${re})`, 'im').test(text);
  const fences = (text.match(/^[ \t]*(?:```|~~~)/gm) ?? []).length;
  const facts: ReadmeFacts = {
    lengthChars: raw.length,
    hasInstall: heading('install|setup|getting started|quick ?start|download'),
    hasUsage: heading('usage|example|quick ?start|getting started|how to use|tutorial'),
    hasConfigDocs: heading('config|environment|options|settings|flags'),
    hasDeployDocs: heading('deploy|docker|kubernetes|helm|production|hosting'),
    codeBlockCount: Math.floor(fences / 2),
  };
  const purpose = firstProse(text);
  if (purpose) facts.purposeStatement = purpose;
  return facts;
}

function firstProse(text: string): string | undefined {
  const paras = text.slice(0, 6000).split(/\n\s*\n/);
  for (const p of paras) {
    const cleaned = p
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]{0,200}>/g, ' ')
      .replace(/!\[[^\]]{0,200}\]\([^)]{0,500}\)/g, ' ')
      .replace(/\[!\[[^\]]{0,200}\]\([^)]{0,500}\)\]\([^)]{0,500}\)/g, ' ')
      .replace(/\[([^\]]{0,200})\]\([^)]{0,500}\)/g, '$1')
      .replace(/[*_`>]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (/^#/.test(cleaned) || /^(?:[-=|+]{3,}|\|)/.test(cleaned)) continue;
    if (cleaned.length >= 30 && /[A-Za-zÀ-ɏḀ-ỿ]{3,}\s+[A-Za-zÀ-ɏḀ-ỿ]{2,}/.test(cleaned)) {
      return cleaned.slice(0, 400);
    }
  }
  return undefined;
}
