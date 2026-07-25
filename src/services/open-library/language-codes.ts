/**
 * @fileoverview MARC language code normalization for Open Library's `language=`
 * search filter, which accepts 3-letter MARC codes only.
 * @module services/open-library/language-codes
 */

import { validationError } from '@cyanheads/mcp-ts-core/errors';

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
 * Resolves a caller-supplied language code to the 3-letter MARC code Open
 * Library's `language=` filter accepts.
 *
 * A 3-letter code is taken as MARC and passed through lowercased. A 2-letter
 * code is looked up in {@link MARC_LANGUAGE_BY_ISO_639_1}; an unrecognized one
 * throws rather than silently reaching upstream, where an unmapped code filters
 * nothing and the caller is told a constraint applied that never did.
 *
 * @throws {McpError} ValidationError with `reason: 'unknown_language_code'` when
 * a 2-letter code has no MARC alias.
 */
export function normalizeLanguageCode(code: string): string {
  const lower = code.trim().toLowerCase();
  if (lower.length === 3) return lower;

  const marc = MARC_LANGUAGE_BY_ISO_639_1[lower];
  if (marc) return marc;

  throw validationError(
    `"${code}" is not a recognized ISO 639-1 language code and has no MARC equivalent. Open Library filters by 3-letter MARC codes — pass one directly (e.g. "eng", "fre", "ger", "chi") or a 2-letter ISO 639-1 code that maps to one.`,
    {
      reason: 'unknown_language_code',
      recovery: {
        hint: `Replace "${code}" with a 3-letter MARC language code (e.g. "eng", "fre", "ger", "spa", "chi"); the full list is the Library of Congress MARC Code List for Languages.`,
      },
    },
  );
}
