import { invoke, isTauri } from "@tauri-apps/api/core";

export type DictHit = {
  meaning: string;
  example?: string;
  forms?: string;
  phrases?: string;
  synonyms?: string;
  etymology?: string;
};

/** empty | freeform note | English headword | English sentence */
export type EntryKind = "empty" | "note" | "word" | "sentence";

const CJK =
  /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af\u0600-\u06ff]/;

function cleanWord(raw: string): string | null {
  const word = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (word.length < 2 || word.length > 64) return null;
  if (!/^[a-z]+(?:['\- ][a-z]+)*$/i.test(word)) return null;
  return word;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function pickForms(json: Record<string, unknown>): string | undefined {
  const rel = json.rel_word as
    | {
        stem?: string;
        rels?: Array<{
          rel?: {
            pos?: string;
            words?: Array<{ word?: string; tran?: string }>;
          };
        }>;
      }
    | undefined;
  const lines: string[] = [];
  if (rel?.stem?.trim()) lines.push(`词根 ${rel.stem.trim()}`);
  for (const r of rel?.rels ?? []) {
    const pos = r.rel?.pos ?? "";
    const words = (r.rel?.words ?? [])
      .map((w) => {
        const t = (w.tran ?? "").trim();
        return t ? `${w.word} ${t}` : w.word;
      })
      .filter(Boolean)
      .join(" · ");
    if (words) lines.push(`${pos} ${words}`.trim());
  }
  return lines.length ? lines.join("\n") : undefined;
}

function pickPhrases(json: Record<string, unknown>): string | undefined {
  const lines: string[] = [];
  const phrs = (json.phrs as { phrs?: unknown[] } | undefined)?.phrs ?? [];
  for (const p of phrs.slice(0, 6) as Array<{
    phr?: {
      headword?: { l?: { i?: string } };
      trs?: Array<{ tr?: { l?: { i?: string } } }>;
    };
  }>) {
    const head = p.phr?.headword?.l?.i?.trim() ?? "";
    const tran = p.phr?.trs?.[0]?.tr?.l?.i?.trim() ?? "";
    if (head) lines.push(tran ? `${head} — ${tran}` : head);
  }
  return lines.length ? lines.join("\n") : undefined;
}

function pickSynonyms(json: Record<string, unknown>): string | undefined {
  const synos =
    (json.syno as { synos?: unknown[] } | undefined)?.synos ?? [];
  const lines: string[] = [];
  for (const s of synos.slice(0, 4) as Array<{
    syno?: { pos?: string; ws?: Array<{ w?: string }> };
  }>) {
    const pos = s.syno?.pos ?? "";
    const ws = (s.syno?.ws ?? []).map((w) => w.w).filter(Boolean).join(", ");
    if (ws) lines.push(`${pos} ${ws}`.trim());
  }
  return lines.length ? lines.join("\n") : undefined;
}

function pickEtym(json: Record<string, unknown>): string | undefined {
  const arr =
    (json.etym as { etyms?: { zh?: Array<{ value?: string }> } } | undefined)
      ?.etyms?.zh ?? [];
  const text = arr
    .map((e) => e.value?.trim())
    .filter(Boolean)
    .join(" ");
  return text || undefined;
}

async function lookupYoudaoBrowser(word: string): Promise<DictHit | null> {
  const res = await fetch(
    `https://dict.youdao.com/jsonapi?q=${encodeURIComponent(word)}`,
  );
  if (!res.ok) return null;
  const json = (await res.json()) as Record<string, unknown>;
  const ec = json.ec as
    | { word?: Array<{ trs?: Array<{ tr?: Array<{ l?: { i?: string[] } }> }> }> }
    | undefined;
  const trs = ec?.word?.[0]?.trs;
  let meaning = "";
  if (Array.isArray(trs)) {
    meaning = trs
      .map((t) => t?.tr?.[0]?.l?.i?.[0])
      .filter(Boolean)
      .join("；");
  }
  const blng = json.blng_sents_part as
    | { "sentence-pair"?: Array<{ sentence?: string }> }
    | undefined;
  const pair = blng?.["sentence-pair"]?.[0];
  const example = pair?.sentence ? stripHtml(String(pair.sentence)) : undefined;
  const forms = pickForms(json);
  const phrases = pickPhrases(json);
  const synonyms = pickSynonyms(json);
  const etymology = pickEtym(json);
  if (
    !meaning &&
    !example &&
    !forms &&
    !phrases &&
    !synonyms &&
    !etymology
  ) {
    return null;
  }
  return { meaning, example, forms, phrases, synonyms, etymology };
}

export async function lookupWord(raw: string): Promise<DictHit | null> {
  const word = cleanWord(raw);
  if (!word) return null;
  try {
    if (isTauri()) {
      return await invoke<DictHit | null>("lookup_word", { word });
    }
    return await lookupYoudaoBrowser(word);
  } catch {
    return null;
  }
}

/** Latin-script English (no CJK / Arabic / Hangul / Kana). */
export function isPrimarilyEnglish(raw: string): boolean {
  const t = raw.trim();
  if (!t || CJK.test(t)) return false;
  return /[a-zA-Z]/.test(t);
}

/** English sentence (call only after isPrimarilyEnglish). */
export function looksLikeSentence(raw: string): boolean {
  const t = raw.trim();
  if (t.length < 10) return false;
  const words = t.split(/\s+/).filter(Boolean).length;
  return words >= 5 || /[.!?;]/.test(t);
}

export function classifyEntry(raw: string): EntryKind {
  const t = raw.trim();
  if (!t) return "empty";
  if (!isPrimarilyEnglish(t)) return "note";
  if (looksLikeSentence(t)) return "sentence";
  return "word";
}

/** Short tab / pill label. */
export function tabTitle(word: string): string {
  const t = word.trim() || "NEW";
  const kind = classifyEntry(t);
  if (kind === "sentence") {
    const cut = t.split(/\s+/).slice(0, 4).join(" ");
    return cut.length < t.length ? `${cut}…` : cut;
  }
  if (kind === "note" && [...t].length > 12) {
    return `${[...t].slice(0, 11).join("")}…`;
  }
  return t;
}

/** Bing EN→ZH (Tauri backend). Browser preview has no Bing CORS path. */
export async function translateSentence(raw: string): Promise<string | null> {
  const text = raw.trim();
  if (text.length < 2 || text.length > 500) return null;
  if (!/[a-zA-Z]/.test(text)) return null;
  try {
    if (!isTauri()) return null;
    return await invoke<string | null>("translate_sentence", { text });
  } catch {
    return null;
  }
}
