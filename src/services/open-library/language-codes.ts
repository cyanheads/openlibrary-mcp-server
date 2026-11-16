/**
 * @fileoverview Language code normalization for Open Library's `language=` search
 * filter, which matches the 3-letter codes its language records carry (MARC codes,
 * almost all) and silently matches nothing for any other value.
 * @module services/open-library/language-codes
 */

import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { OPEN_LIBRARY_LANGUAGE_CODES } from './language-records.js';

/**
 * ISO 639-1 (2-letter) → MARC (3-letter) language code aliases.
 *
 * Transcribed from the Library of Congress ISO 639-2 registry
 * (https://www.loc.gov/standards/iso639-2/ISO-639-2_utf-8.txt), bibliographic
 * column, and cross-checked against the MARC Code List for Languages
 * (https://www.loc.gov/standards/codelists/languages.xml) — every value below is
 * a current, non-obsolete MARC code.
 *
 * The mapping is a lookup, never a derivation: many MARC codes are not the
 * truncation of the English name or of the ISO 639-3 code — German is `ger`
 * (not `deu`), Dutch `dut` (not `nld`), French `fre` (not `fra`), Chinese `chi`
 * (not `zho`), Greek `gre`, Czech `cze`, Persian `per`, Icelandic `ice`.
 */
export const MARC_LANGUAGE_BY_ISO_639_1: Readonly<Record<string, string>> = {
  aa: 'aar',
  ab: 'abk',
  ae: 'ave',
  af: 'afr',
  ak: 'aka',
  am: 'amh',
  an: 'arg',
  ar: 'ara',
  as: 'asm',
  av: 'ava',
  ay: 'aym',
  az: 'aze',
  ba: 'bak',
  be: 'bel',
  bg: 'bul',
  bi: 'bis',
  bm: 'bam',
  bn: 'ben',
  bo: 'tib',
  br: 'bre',
  bs: 'bos',
  ca: 'cat',
  ce: 'che',
  ch: 'cha',
  co: 'cos',
  cr: 'cre',
  cs: 'cze',
  cu: 'chu',
  cv: 'chv',
  cy: 'wel',
  da: 'dan',
  de: 'ger',
  dv: 'div',
  dz: 'dzo',
  ee: 'ewe',
  el: 'gre',
  en: 'eng',
  eo: 'epo',
  es: 'spa',
  et: 'est',
  eu: 'baq',
  fa: 'per',
  ff: 'ful',
  fi: 'fin',
  fj: 'fij',
  fo: 'fao',
  fr: 'fre',
  fy: 'fry',
  ga: 'gle',
  gd: 'gla',
  gl: 'glg',
  gn: 'grn',
  gu: 'guj',
  gv: 'glv',
  ha: 'hau',
  he: 'heb',
  hi: 'hin',
  ho: 'hmo',
  hr: 'hrv',
  ht: 'hat',
  hu: 'hun',
  hy: 'arm',
  hz: 'her',
  ia: 'ina',
  id: 'ind',
  ie: 'ile',
  ig: 'ibo',
  ii: 'iii',
  ik: 'ipk',
  io: 'ido',
  is: 'ice',
  it: 'ita',
  iu: 'iku',
  ja: 'jpn',
  jv: 'jav',
  ka: 'geo',
  kg: 'kon',
  ki: 'kik',
  kj: 'kua',
  kk: 'kaz',
  kl: 'kal',
  km: 'khm',
  kn: 'kan',
  ko: 'kor',
  kr: 'kau',
  ks: 'kas',
  ku: 'kur',
  kv: 'kom',
  kw: 'cor',
  ky: 'kir',
  la: 'lat',
  lb: 'ltz',
  lg: 'lug',
  li: 'lim',
  ln: 'lin',
  lo: 'lao',
  lt: 'lit',
  lu: 'lub',
  lv: 'lav',
  mg: 'mlg',
  mh: 'mah',
  mi: 'mao',
  mk: 'mac',
  ml: 'mal',
  mn: 'mon',
  mr: 'mar',
  ms: 'may',
  mt: 'mlt',
  my: 'bur',
  na: 'nau',
  nb: 'nob',
  nd: 'nde',
  ne: 'nep',
  ng: 'ndo',
  nl: 'dut',
  nn: 'nno',
  no: 'nor',
  nr: 'nbl',
  nv: 'nav',
  ny: 'nya',
  oc: 'oci',
  oj: 'oji',
  om: 'orm',
  or: 'ori',
  os: 'oss',
  pa: 'pan',
  pi: 'pli',
  pl: 'pol',
  ps: 'pus',
  pt: 'por',
  qu: 'que',
  rm: 'roh',
  rn: 'run',
  ro: 'rum',
  ru: 'rus',
  rw: 'kin',
  sa: 'san',
  sc: 'srd',
  sd: 'snd',
  se: 'sme',
  sg: 'sag',
  si: 'sin',
  sk: 'slo',
  sl: 'slv',
  sm: 'smo',
  sn: 'sna',
  so: 'som',
  sq: 'alb',
  sr: 'srp',
  ss: 'ssw',
  st: 'sot',
  su: 'sun',
  sv: 'swe',
  sw: 'swa',
  ta: 'tam',
  te: 'tel',
  tg: 'tgk',
  th: 'tha',
  ti: 'tir',
  tk: 'tuk',
  tl: 'tgl',
  tn: 'tsn',
  to: 'ton',
  tr: 'tur',
  ts: 'tso',
  tt: 'tat',
  tw: 'twi',
  ty: 'tah',
  ug: 'uig',
  uk: 'ukr',
  ur: 'urd',
  uz: 'uzb',
  ve: 'ven',
  vi: 'vie',
  vo: 'vol',
  wa: 'wln',
  wo: 'wol',
  xh: 'xho',
  yi: 'yid',
  yo: 'yor',
  za: 'zha',
  zh: 'chi',
  zu: 'zul',
};

/**
 * ISO 639-2 terminology (T) → bibliographic (B, the MARC form) codes, for the 20
 * languages whose two forms differ — the complete set in the Library of Congress
 * ISO 639-2 registry cited above. The T codes are also the ISO 639-3 codes most
 * callers know, and none is an Open Library language record, so each matches
 * nothing unmapped.
 */
export const MARC_LANGUAGE_BY_ISO_639_2T: Readonly<Record<string, string>> = {
  bod: 'tib',
  ces: 'cze',
  cym: 'wel',
  deu: 'ger',
  ell: 'gre',
  eus: 'baq',
  fas: 'per',
  fra: 'fre',
  hye: 'arm',
  isl: 'ice',
  kat: 'geo',
  mkd: 'mac',
  mri: 'mao',
  msa: 'may',
  mya: 'bur',
  nld: 'dut',
  ron: 'rum',
  slk: 'slo',
  sqi: 'alb',
  zho: 'chi',
};

/**
 * The MARC Code List for Languages codes, current and obsolete, that Open Library has no
 * language record for: `zxx` (no linguistic content) and the obsolete `ajm`, `kus`, `max`,
 * and `tru`. No work is indexed under any of them, but each is a real MARC code, so the
 * filter sends it and answers the accurate empty page.
 */
const MARC_CODES_WITHOUT_RECORD: ReadonlySet<string> = new Set(['ajm', 'kus', 'max', 'tru', 'zxx']);

/**
 * Resolves a caller-supplied language code, in any case, to the 3-letter code
 * Open Library's `language=` filter indexes works under.
 *
 * A 2-letter code is looked up in {@link MARC_LANGUAGE_BY_ISO_639_1} and a 3-letter
 * terminology code in {@link MARC_LANGUAGE_BY_ISO_639_2T}; any other 3-letter code
 * must be an Open Library language record ({@link OPEN_LIBRARY_LANGUAGE_CODES}) or a
 * MARC code ({@link MARC_CODES_WITHOUT_RECORD}). Anything else throws rather than
 * reaching upstream, where a code that names no language filters to zero matches and
 * the caller reads an empty catalog as a real result.
 *
 * @throws {McpError} ValidationError with `reason: 'unknown_language_code'` when
 * the code is neither a MARC code nor an Open Library language record.
 */
export function normalizeLanguageCode(code: string): string {
  const lower = code.trim().toLowerCase();
  const mapped =
    lower.length === 2 ? MARC_LANGUAGE_BY_ISO_639_1[lower] : MARC_LANGUAGE_BY_ISO_639_2T[lower];
  if (mapped) return mapped;
  if (OPEN_LIBRARY_LANGUAGE_CODES.has(lower) || MARC_CODES_WITHOUT_RECORD.has(lower)) return lower;

  throw validationError(
    `"${code}" names no language Open Library catalogs works under. The filter takes a 3-letter MARC code (e.g. "eng", "fre", "ger", "chi"), the ISO 639-2/T form of one (e.g. "deu", "fra"), or a 2-letter ISO 639-1 code that maps to one (e.g. "de", "fr").`,
    {
      reason: 'unknown_language_code',
      recovery: {
        hint: `Replace "${code}" with a 3-letter MARC language code (e.g. "eng", "fre", "ger", "spa", "chi") or a 2-letter ISO 639-1 code (e.g. "en", "fr"); the Library of Congress MARC Code List for Languages names them.`,
      },
    },
  );
}
