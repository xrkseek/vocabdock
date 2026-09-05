export type DeckMode = "rest" | "fan" | "expanded";

export type VocabNote = {
  id: string;
  word: string;
  meaning: string;
  example?: string;
  /** 派生 / 词形 */
  forms?: string;
  /** 短语搭配 */
  phrases?: string;
  /** 近义 */
  synonyms?: string;
  /** 词源 */
  etymology?: string;
  color: number;
  pinned: boolean;
  created: number;
  order: number;
};

export type NoteColor = {
  name: string;
  paper: string;
  dash: string;
  ink: string;
};

export const PALETTE: NoteColor[] = [
  { name: "Lemon", paper: "#FCE795", dash: "#E0AD08", ink: "#3A3008" },
  { name: "Peach", paper: "#FBCFA6", dash: "#E2762A", ink: "#422413" },
  { name: "Rose", paper: "#FAC4D1", dash: "#DC4570", ink: "#40161F" },
  { name: "Lilac", paper: "#D9C7FA", dash: "#7C4DEE", ink: "#2A1B44" },
  { name: "Sky", paper: "#BEDDFA", dash: "#2280D6", ink: "#13293A" },
  { name: "Mint", paper: "#B4E8D0", dash: "#0E9B6E", ink: "#0F2E23" },
  { name: "Sand", paper: "#E3D3B4", dash: "#A37B3C", ink: "#372C18" },
  { name: "Slate", paper: "#CBD6E2", dash: "#4E6579", ink: "#1A242E" },
];

export function colorAt(i: number): NoteColor {
  const n = PALETTE.length;
  return PALETTE[((i % n) + n) % n];
}

/** Noty deckYRatio: 0 = bottom, 1 = top (Cocoa). We keep 0.5 mid-edge. */
export const DECK_Y_RATIO = 0.5;

export const GEOM = {
  tabWidth: 30,
  tabLap: 40,
  labelPad: 20,
  pitchMin: 56,
  pitchMax: 160,
  staggerIn: 0.042,
  staggerOut: 0.03,
  fanIdleMs: 4000,
  noteIdleMs: 60000,
  maxDashes: 14,
  tabPreviewMs: 180,
  shrinkDelayMs: 450,
  autosaveMs: 250,
  dictDebounceMs: 420,
  plusSize: 28,
  plusGap: 12,
  dashH: 14,
  dashGap: 5,
  pillPad: 7,
} as const;

export function pillHeight(noteCount: number): number {
  const n = Math.min(GEOM.maxDashes, Math.max(1, noteCount));
  return (
    GEOM.pillPad * 2 +
    n * GEOM.dashH +
    Math.max(0, n - 1) * GEOM.dashGap
  );
}

/** Noty pillTop — same screen Y whether panel is full or pill-sized. */
export function pillTopPx(panelH: number, noteCount: number): number {
  const h = pillHeight(noteCount);
  return (1 - DECK_Y_RATIO) * Math.max(0, panelH - h);
}

/** Noty fanTop — stack centered on the resting pill. */
export function fanTopPx(
  panelH: number,
  noteCount: number,
  stackH: number,
): number {
  const pillH = pillHeight(noteCount);
  const available = Math.max(1, panelH - pillH);
  const pillCenter = (1 - DECK_Y_RATIO) * available + pillH / 2;
  const ideal = pillCenter - stackH / 2;
  return Math.min(Math.max(12, ideal), Math.max(12, panelH - stackH - 12));
}

export function measureLabel(text: string): number {
  if (typeof document === "undefined") return text.length * 7;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return text.length * 7;
  ctx.font = "650 9.5px Segoe UI, Microsoft YaHei, sans-serif";
  return Math.ceil(ctx.measureText(text.toUpperCase()).width);
}

export function pitchFor(labels: string[]): number {
  if (!labels.length) return GEOM.pitchMin;
  const longest = labels.reduce((m, t) => Math.max(m, measureLabel(t)), 40);
  return Math.min(
    GEOM.pitchMax,
    Math.max(GEOM.pitchMin, longest + GEOM.labelPad),
  );
}

const STORAGE_KEY = "notepad.vocab.v2";

function uid(): string {
  return crypto.randomUUID();
}

export function loadNotes(): VocabNote[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as VocabNote[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    /* ignore */
  }
  return [];
}

export function saveNotes(notes: VocabNote[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
}

export type NoteFields = {
  color?: number;
  order?: number;
  example?: string;
  forms?: string;
  phrases?: string;
  synonyms?: string;
  etymology?: string;
};

export function createNote(
  word: string,
  meaning: string,
  opts?: NoteFields,
): VocabNote {
  return {
    id: uid(),
    word: word.trim(),
    meaning: meaning.trim(),
    example: (opts?.example ?? "").trim() || undefined,
    forms: (opts?.forms ?? "").trim() || undefined,
    phrases: (opts?.phrases ?? "").trim() || undefined,
    synonyms: (opts?.synonyms ?? "").trim() || undefined,
    etymology: (opts?.etymology ?? "").trim() || undefined,
    color: opts?.color ?? 0,
    pinned: false,
    created: Date.now(),
    order: opts?.order ?? 0,
  };
}
