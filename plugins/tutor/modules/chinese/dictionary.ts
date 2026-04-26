/**
 * Chinese dictionary integration for CC-CEDICT.
 *
 * CC-CEDICT lines use:
 * traditional simplified [pin1 yin1] /definition1/definition2/
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { DictionaryEntry } from "../../core/types.ts";
import { marksToNumbers, numbersToMarks, stripToneNumbers } from "./pinyin.ts";

export interface CedictEntry {
  traditional: string;
  simplified: string;
  pinyinNumbered: string;
  pinyinMarked: string;
  definitions: string[];
}

interface CedictCache {
  entries: CedictEntry[];
  lookup: Map<string, CedictEntry[]>;
}

interface PinyinQueryForms {
  normalized: string;
  numbered: string;
  bare: string;
  compactNormalized: string;
  compactNumbered: string;
  compactBare: string;
}

const BUNDLED_CEDICT_PATH = fileURLToPath(new URL("./data/cedict.txt", import.meta.url));

let cedictCache: CedictCache | null = null;

export function parseCedictLine(line: string): CedictEntry | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return null;

  const match = trimmed.match(/^(\S+)\s+(\S+)\s+\[([^\]]+)]\s+\/(.+)\/$/);
  if (!match) return null;

  const [, traditional, simplified, pinyinNumbered, definitionText] = match;
  const definitions = definitionText
    .split("/")
    .map((definition) => definition.trim())
    .filter(Boolean);

  return {
    traditional,
    simplified,
    pinyinNumbered,
    pinyinMarked: numbersToMarks(pinyinNumbered),
    definitions,
  };
}

export function parseCedict(text: string): CedictEntry[] {
  return text
    .split(/\r?\n/)
    .map(parseCedictLine)
    .filter((entry): entry is CedictEntry => entry !== null);
}

function addLookup(map: Map<string, CedictEntry[]>, key: string, entry: CedictEntry) {
  const normalized = key.trim().toLowerCase();
  if (!normalized) return;
  const existing = map.get(normalized);
  if (existing) {
    existing.push(entry);
  } else {
    map.set(normalized, [entry]);
  }
}

function compactPinyinKey(key: string): string {
  return key.replace(/\s+/g, "");
}

function buildPinyinQueryForms(query: string): PinyinQueryForms {
  const normalized = query.trim().toLowerCase();
  const numbered = marksToNumbers(normalized).toLowerCase();
  const bare = stripToneNumbers(numbered);

  return {
    normalized,
    numbered,
    bare,
    compactNormalized: compactPinyinKey(normalized),
    compactNumbered: compactPinyinKey(numbered),
    compactBare: compactPinyinKey(bare),
  };
}

function addPinyinLookup(map: Map<string, CedictEntry[]>, key: string, entry: CedictEntry) {
  addLookup(map, key, entry);
  addLookup(map, compactPinyinKey(key), entry);
}

function buildLookup(entries: CedictEntry[]): Map<string, CedictEntry[]> {
  const map = new Map<string, CedictEntry[]>();

  for (const entry of entries) {
    addLookup(map, entry.simplified, entry);
    addLookup(map, entry.traditional, entry);
    addPinyinLookup(map, entry.pinyinNumbered, entry);
    addPinyinLookup(map, entry.pinyinMarked, entry);
    addPinyinLookup(map, stripToneNumbers(entry.pinyinNumbered), entry);
  }

  return map;
}

function uniqueEntries(entries: CedictEntry[]): CedictEntry[] {
  const seen = new Set<string>();
  const unique: CedictEntry[] = [];

  for (const entry of entries) {
    const key = `${entry.traditional}\t${entry.simplified}\t${entry.pinyinNumbered}\t${entry.definitions.join("/")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }

  return unique;
}

function toDictionaryEntry(entry: CedictEntry): DictionaryEntry {
  const variants =
    entry.traditional !== entry.simplified
      ? [`traditional: ${entry.traditional}`]
      : [];

  return {
    word: entry.simplified,
    reading: entry.pinyinMarked,
    meanings: entry.definitions,
    partOfSpeech: variants,
    examples: [],
  };
}

async function readCedictText(): Promise<string> {
  const path = process.env.CHOOMFIE_CEDICT_PATH || BUNDLED_CEDICT_PATH;
  return readFile(path, "utf8");
}

export async function initCedict(): Promise<void> {
  const text = await readCedictText();
  const entries = parseCedict(text);
  cedictCache = { entries, lookup: buildLookup(entries) };
}

async function ensureCedict(): Promise<CedictCache> {
  if (!cedictCache) {
    await initCedict();
  }

  if (!cedictCache) {
    throw new Error("CC-CEDICT failed to initialize");
  }

  return cedictCache;
}

export async function lookupCedict(query: string): Promise<DictionaryEntry[]> {
  const queryForms = buildPinyinQueryForms(query);
  if (!queryForms.normalized) return [];

  const { entries, lookup } = await ensureCedict();

  const exact = [
    ...(lookup.get(queryForms.normalized) ?? []),
    ...(lookup.get(queryForms.numbered) ?? []),
    ...(lookup.get(queryForms.bare) ?? []),
    ...(lookup.get(queryForms.compactNormalized) ?? []),
    ...(lookup.get(queryForms.compactNumbered) ?? []),
    ...(lookup.get(queryForms.compactBare) ?? []),
  ];

  if (exact.length > 0) {
    return uniqueEntries(exact).slice(0, 5).map(toDictionaryEntry);
  }

  const partial = entries.filter((entry) => {
    const definitions = entry.definitions.join("; ").toLowerCase();
    return (
      entry.simplified.includes(queryForms.normalized) ||
      entry.traditional.includes(queryForms.normalized) ||
      entry.pinyinNumbered.toLowerCase().includes(queryForms.numbered) ||
      entry.pinyinMarked.toLowerCase().includes(queryForms.normalized) ||
      stripToneNumbers(entry.pinyinNumbered).toLowerCase().includes(queryForms.bare) ||
      compactPinyinKey(entry.pinyinNumbered.toLowerCase()).includes(queryForms.compactNumbered) ||
      compactPinyinKey(entry.pinyinMarked.toLowerCase()).includes(queryForms.compactNormalized) ||
      compactPinyinKey(stripToneNumbers(entry.pinyinNumbered).toLowerCase()).includes(
        queryForms.compactBare
      ) ||
      definitions.includes(queryForms.normalized)
    );
  });

  return uniqueEntries(partial).slice(0, 5).map(toDictionaryEntry);
}
