export type DeckMode = "rest" | "fan" | "expanded";

export type VocabNote = {
  id: string;
  word: string;
  meaning: string;
  example?: string;
  /** 例句中文翻译 */
  translation?: string;
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
  /** Noty pitchMin / pitchMax — keep shared pitch from exploding. */
  pitchMin: 56,
  pitchMax: 106,
  /** Chars used when measuring pitch so one long title can't stretch all tabs. */
  pitchLabelChars: 14,
  staggerIn: 0.009,
  staggerOut: 0.008,
  fanIdleMs: 4000,
  noteIdleMs: 60000,
  maxDashes: 14,
  /** Edge deck shows at most this many tabs (Noty fanLimit=5; we scroll). */
  fanCap: 24,
  /** Noty DeckGeom.heightBudget — visible fan height vs panel. */
  fanHeightBudget: 0.68,
  fanMaxPx: 720,
  /** Bottom reserve so + and margin stay on-screen (Noty ~76). */
  fanBottomReserve: 76,
  tabPreviewMs: 0,
  previewLeaveMs: 120,
  expandFrameMs: 16,
  /** Debounce before fan→rest when cursor leaves the dock. */
  restLeaveMs: 80,
  /** Fan / note motion (seconds) — kept snappy for rapid pill flick. */
  fanInDur: 0.1,
  fanOutDur: 0.08,
  noteInDur: 0.16,
  noteOutDur: 0.1,
  autosaveMs: 250,
  dictDebounceMs: 420,
  /** Legacy; tab reorder now starts after a 6px drag, not a timed press. */
  longPressMs: 180,
  plusSize: 28,
  plusGap: 12,
  dashH: 14,
  dashGap: 5,
  pillPad: 7,
  previewWidth: 280,
  previewGap: 22,
  noteInset: 52,
} as const;

export function pillHeight(noteCount: number): number {
  const n = Math.min(GEOM.maxDashes, Math.max(1, noteCount));
  return (
    GEOM.pillPad * 2 +
    n * GEOM.dashH +
    Math.max(0, n - 1) * GEOM.dashGap
  );
}

export function pillTopPx(panelH: number, noteCount: number): number {
  const h = pillHeight(noteCount);
  return (1 - DECK_Y_RATIO) * Math.max(0, panelH - h);
}

/** Visible tab column height (capped) — must match `.fan { max-height }`. */
export function fanTabsBudget(panelH: number): number {
  return Math.max(
    140,
    Math.min(
      panelH * GEOM.fanHeightBudget,
      GEOM.fanMaxPx,
      panelH - GEOM.fanBottomReserve,
    ),
  );
}

/** Full fan-shell height used for vertical centering (tabs + plus). */
export function fanStackHeight(
  noteCount: number,
  pitch: number,
  panelH: number,
): number {
  const itemH = pitch + GEOM.tabLap;
  const tabsRaw =
    noteCount > 0 ? (noteCount - 1) * pitch + itemH : 0;
  const tabsVis = Math.min(tabsRaw, fanTabsBudget(panelH));
  return tabsVis + GEOM.plusGap + GEOM.plusSize;
}

export function fanTopPx(
  panelH: number,
  noteCount: number,
  stackH: number,
): number {
  const pillH = pillHeight(noteCount);
  const available = Math.max(1, panelH - pillH);
  // Center the fan on the same vertical anchor as the rest pill (Noty).
  const pillCenter = (1 - DECK_Y_RATIO) * available + pillH / 2;
  const ideal = pillCenter - stackH / 2;
  return Math.min(Math.max(12, ideal), Math.max(12, panelH - stackH - 12));
}

/** Cap label for pitch math only — display still uses full word + CSS ellipsis. */
export function pitchLabel(text: string): string {
  const t = (text.trim() || "NEW").toUpperCase();
  if (t.length <= GEOM.pitchLabelChars) return t;
  return `${t.slice(0, GEOM.pitchLabelChars - 1)}…`;
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
  const longest = labels.reduce(
    (m, t) => Math.max(m, measureLabel(pitchLabel(t))),
    40,
  );
  return Math.min(
    GEOM.pitchMax,
    Math.max(GEOM.pitchMin, longest + GEOM.labelPad),
  );
}

const STORAGE_KEY = "vocabdock.vocab.v1";
const STORAGE_KEY_LEGACY = "notepad.vocab.v2";

function uid(): string {
  return crypto.randomUUID();
}

export function loadNotes(): VocabNote[] {
  try {
    const raw =
      localStorage.getItem(STORAGE_KEY) ??
      localStorage.getItem(STORAGE_KEY_LEGACY);
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
  translation?: string;
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
    translation: (opts?.translation ?? "").trim() || undefined,
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

/** Order value that sorts the new note into the middle of the fan. */
export function midInsertOrder(notes: VocabNote[]): number {
  const sorted = [...notes].sort((a, b) => a.order - b.order);
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0].order + 1;
  const mid = Math.floor(sorted.length / 2);
  const lo = sorted[mid - 1].order;
  const hi = sorted[mid].order;
  return lo + (hi - lo) / 2;
}
