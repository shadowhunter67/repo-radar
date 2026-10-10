export interface NormalizedName {
  /** Exactly as given; never modified. */
  display: string;
  /** Lowercase, NFKC, emoji/punctuation collapsed to single hyphens. */
  normalized: string;
  /** Diacritics stripped, hyphens -> spaces; suited for search indexes. */
  searchForm: string;
  tokens: string[];
  /** True when normalization removed meaningful characters (emoji, symbols). */
  lossy: boolean;
  /** True when nothing usable survived (e.g. a name made only of emoji). */
  empty: boolean;
}

const EMOJI = /\p{Extended_Pictographic}|\u{FE0F}|\u{200D}|\u{20E3}/gu;

export function normalizeName(display: string): NormalizedName {
  const nfkc = display.normalize('NFKC');
  const noEmoji = nfkc.replace(EMOJI, ' ');
  // split camelCase / PascalCase before lowercasing: "FastAPIServer" -> "Fast API Server"
  const split = noEmoji
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2');
  const lower = split.toLowerCase();
  const normalized = lower.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  // Strip diacritics from Latin letters only; decomposing e.g. Japanese kana would change their meaning.
  const searchForm = normalized
    .normalize('NFD')
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
    .normalize('NFC')
    .replace(/-+/g, ' ')
    .trim();
  const tokens = searchForm ? searchForm.split(' ') : [];
  const lossy = nfkc.replace(/[\p{L}\p{N}\-_. ]/gu, '').length > 0;
  return {
    display,
    normalized: normalized || 'unnamed',
    searchForm,
    tokens,
    lossy,
    empty: normalized.length === 0,
  };
}
