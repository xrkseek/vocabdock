import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";
import {
  GEOM,
  PALETTE,
  colorAt,
  createNote,
  midInsertOrder,
  fanStackHeight,
  fanTabsBudget,
  fanTopPx,
  loadNotes,
  pillHeight,
  pillTopPx,
  pitchFor,
  saveNotes,
  type VocabNote,
} from "./lib/notes";
import {
  classifyEntry,
  lookupWord,
  tabTitle,
  translateSentence,
  type DictHit,
} from "./lib/dict";
import {
  dockEdge,
  collectHitRegions,
  setHitRegions,
  setInputCapture,
  showDeckMenu,
  showTabMenu,
} from "./lib/window";
import "./App.css";

gsap.registerPlugin(useGSAP);

type Kind = "rest" | "fan" | "expanded";

type NotePos = { left: number; top: number };

type UxMem = {
  noteScroll: Record<string, number>;
  fanScroll: number;
};

const UX_KEY = "vocabdock.ux.v1";
const UX_KEY_LEGACY = "notepad.ux.v1";
const NOTE_CARD_W = 400;

function loadUxMem(): UxMem {
  try {
    const raw =
      localStorage.getItem(UX_KEY) ?? localStorage.getItem(UX_KEY_LEGACY);
    if (!raw) return { noteScroll: {}, fanScroll: 0 };
    const j = JSON.parse(raw) as Partial<UxMem>;
    return {
      noteScroll: j.noteScroll ?? {},
      fanScroll: j.fanScroll ?? 0,
    };
  } catch {
    return { noteScroll: {}, fanScroll: 0 };
  }
}

function saveUxMem(m: UxMem) {
  try {
    localStorage.setItem(
      UX_KEY,
      JSON.stringify({
        noteScroll: m.noteScroll,
        fanScroll: m.fanScroll,
      }),
    );
  } catch {
    /* ignore */
  }
}

function clampNotePos(
  left: number,
  top: number,
  panelW: number,
  panelH: number,
  cardW: number,
  cardH: number,
): NotePos {
  const pad = 8;
  const w = Math.min(
    Math.max(120, cardW),
    Math.max(120, panelW - pad * 2),
  );
  const h = Math.min(
    Math.max(80, cardH),
    Math.max(80, panelH - pad * 2),
  );
  return {
    left: Math.max(pad, Math.min(Math.round(left), Math.round(panelW - w - pad))),
    top: Math.max(pad, Math.min(Math.round(top), Math.round(panelH - h - pad))),
  };
}

/** Approximate Noty spring(0.34, 0.82) without overshoot jitter. */
const SPRING_IN = "power3.out";
/** Approximate Noty spring(0.28, 0.88) on collapse. */
const SPRING_OUT = "power2.inOut";

const reduceMotion =
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Noty editorTop: keep card aligned to tab, clamp inside panel. */
function fitNoteTop(ideal: number, noteH: number, panelH: number, pad = 10): number {
  const h = Math.max(1, noteH);
  const lowest = Math.max(pad, panelH - h - pad);
  return Math.min(Math.max(pad, Math.round(ideal)), Math.round(lowest));
}

/** Reorder notes by moving `id` to `toIndex` in order-sorted list. */
function moveNoteOrder(
  notes: VocabNote[],
  id: string,
  toIndex: number,
): VocabNote[] {
  const sorted = [...notes].sort((a, b) => a.order - b.order);
  const from = sorted.findIndex((n) => n.id === id);
  if (from < 0) return notes;
  const [item] = sorted.splice(from, 1);
  const clamped = Math.max(0, Math.min(toIndex, sorted.length));
  sorted.splice(clamped, 0, item);
  return sorted.map((n, i) => ({ ...n, order: i }));
}

/** Drop vocab-only fields when switching to note / sentence. */
const CLEAR_VOCAB = {
  example: undefined,
  forms: undefined,
  phrases: undefined,
  synonyms: undefined,
  etymology: undefined,
} as const;

function previewLines(note: VocabNote): string[] {
  const kind = classifyEntry(note.word);
  const chunks = (
    kind === "sentence"
      ? [note.translation?.trim(), note.meaning?.trim()]
      : kind === "note" || kind === "empty"
        ? [note.meaning?.trim()]
        : [
            note.meaning?.trim(),
            note.example?.trim(),
            note.translation?.trim(),
          ]
  ).filter(Boolean) as string[];
  const lines: string[] = [];
  for (const chunk of chunks) {
    for (const line of chunk.split(/\n+/)) {
      const t = line.trim();
      if (t) lines.push(t);
      if (lines.length >= 4) return lines;
    }
  }
  return lines;
}

function Section({
  label,
  value,
  onChange,
  rows = 2,
  emphasis = false,
  scroll = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  emphasis?: boolean;
  /** Long text scrolls inside the field instead of stretching the card. */
  scroll?: boolean;
}) {
  return (
    <label
      className={`note-section${emphasis ? " is-emphasis" : ""}${scroll ? " is-scroll" : ""}`}
    >
      <span className="note-section-label">{label}</span>
      <textarea
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export default function App() {
  const [notes, setNotes] = useState<VocabNote[]>(() => loadNotes());
  const [kind, setKind] = useState<Kind>("rest");
  const [openId, setOpenId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewTop, setPreviewTop] = useState(0);
  const [openedTop, setOpenedTop] = useState<number | null>(null);
  const [dictHint, setDictHint] = useState("");
  const [staging, setStaging] = useState(false);
  const [panelH, setPanelH] = useState(
    () => (typeof window !== "undefined" ? window.innerHeight : 800),
  );
  const [notePos, setNotePos] = useState<Record<string, NotePos>>({});

  const rootRef = useRef<HTMLDivElement>(null);
  const fanRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLDivElement>(null);
  const tabEls = useRef<Map<string, HTMLButtonElement>>(new Map());
  const lastActivity = useRef(Date.now());
  const revealGen = useRef(0);
  const lastReveal = useRef(-1);
  const previewTimer = useRef(0);
  const fanEnterTimer = useRef(0);
  const restLeaveTimer = useRef(0);
  const lastPointer = useRef({ x: 0, y: 0 });
  const syncPreviewRef = useRef<() => void>(() => {});
  const transitGen = useRef(0);
  const saveTimer = useRef(0);
  const dictTimer = useRef(0);
  const translateTimer = useRef(0);
  const dictSeq = useRef(0);
  const translateSeq = useRef(0);
  /** Tab strip center Y — frozen while open (Noty openedTop anchor). */
  const openedAnchorRef = useRef<number | null>(null);
  const openedTopRef = useRef<number | null>(null);
  const noteScrollRef = useRef<HTMLDivElement>(null);
  const uxMem = useRef<UxMem>(loadUxMem());
  const longPressTimer = useRef(0);
  const suppressTabClick = useRef(false);
  const tabDrag = useRef<{
    id: string;
    startY: number;
    fromIndex: number;
    active: boolean;
    hoverIndex: number;
  } | null>(null);
  const noteDrag = useRef<{
    id: string;
    startX: number;
    startY: number;
    origLeft: number;
    origTop: number;
    active: boolean;
    cardW: number;
    cardH: number;
    last?: NotePos;
    card?: HTMLElement | null;
    raf?: number;
  } | null>(null);
  /** True only while a note grip-drag is active (guards hit publish). */
  const noteDraggingRef = useRef(false);
  const kindRef = useRef(kind);
  const openIdRef = useRef(openId);
  const previewIdRef = useRef(previewId);
  const notesRef = useRef(notes);
  const transitRef = useRef(false);
  kindRef.current = kind;
  openIdRef.current = openId;
  previewIdRef.current = previewId;
  notesRef.current = notes;
  openedTopRef.current = openedTop;

  const active = useMemo(
    () => [...notes].sort((a, b) => a.order - b.order),
    [notes],
  );
  /** Edge deck only shows a capped stack (Noty fanLimit spirit); rest stay in storage. */
  const fanNotes = useMemo(
    () => active.slice(0, GEOM.fanCap),
    [active],
  );
  const previewNote = previewId
    ? (active.find((n) => n.id === previewId) ?? null)
    : null;

  const pitch = pitchFor(fanNotes.map((n) => tabTitle(n.word || "NEW")));
  const itemHeight = pitch + GEOM.tabLap;
  const strip = pitch;
  const fanBudget = fanTabsBudget(panelH);
  const stackH = fanStackHeight(fanNotes.length, pitch, panelH);
  const pillH = pillHeight(Math.max(1, active.length));
  const pillTop = pillTopPx(panelH, Math.max(1, active.length));
  const fanTop = fanTopPx(panelH, Math.max(1, active.length), stackH);

  /** Align preview to the real tab box (accounts for fan scroll / overlap). */
  const measurePreviewTop = useCallback(
    (id: string) => {
      const root = rootRef.current?.getBoundingClientRect();
      const tab = tabEls.current.get(id)?.getBoundingClientRect();
      if (root && tab) {
        return Math.max(4, Math.round(tab.top - root.top));
      }
      const idx = fanNotes.findIndex((n) => n.id === id);
      const scroll =
        fanRef.current?.querySelector(".fan")?.scrollTop ?? 0;
      return Math.max(4, fanTop + Math.max(0, idx) * pitch - scroll);
    },
    [fanNotes, fanTop, pitch],
  );

  useLayoutEffect(() => {
    if (!previewId || kind !== "fan") return;
    setPreviewTop(measurePreviewTop(previewId));
  }, [previewId, kind, measurePreviewTop, staging]);

  useEffect(() => {
    const sync = () => setPanelH(window.innerHeight);
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [kind]);

  // Keep rest docked when note count changes (width unchanged; pill CSS moves).
  useEffect(() => {
    if (kindRef.current === "rest") {
      void dockEdge("rest", Math.max(1, active.length));
    }
  }, [active.length]);

  const bump = () => {
    lastActivity.current = Date.now();
    window.clearTimeout(restLeaveTimer.current);
  };

  /** Debounced disk write always reads latest notes — never a stale closure snapshot. */
  const queueSave = () => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveNotes(notesRef.current);
    }, GEOM.autosaveMs);
  };

  const persist = (next: VocabNote[]) => {
    window.clearTimeout(saveTimer.current);
    notesRef.current = next;
    setNotes(next);
    saveNotes(next);
  };

  const flushUx = () => saveUxMem(uxMem.current);

  const rememberNoteScroll = (id: string | null) => {
    const el = noteScrollRef.current;
    if (!id || !el) return;
    uxMem.current.noteScroll[id] = el.scrollTop;
    flushUx();
  };

  const restoreNoteScroll = (id: string) => {
    const el = noteScrollRef.current;
    if (!el) return;
    const y = uxMem.current.noteScroll[id] ?? 0;
    requestAnimationFrame(() => {
      if (noteScrollRef.current) noteScrollRef.current.scrollTop = y;
    });
  };

  const clearPreviewNow = useCallback(() => {
    window.clearTimeout(previewTimer.current);
    setPreviewId(null);
  }, []);

  /** If the cursor is already over a tab (common after rest→fan), show that preview. */
  const syncPreviewUnderPointer = useCallback(() => {
    if (kindRef.current !== "fan" || transitRef.current) return;
    const { x, y } = lastPointer.current;
    if (x === 0 && y === 0) return;
    const hit = document.elementFromPoint(x, y);
    const id = hit
      ?.closest?.("[data-note-id]")
      ?.getAttribute("data-note-id");
    if (!id) return;
    window.clearTimeout(previewTimer.current);
    setPreviewId(id);
    setPreviewTop(measurePreviewTop(id));
  }, [measurePreviewTop]);

  /** Noty: debounce leave so sweeping tabs / entering the card doesn't flicker. */
  const schedulePreviewLeave = useCallback((id?: string) => {
    window.clearTimeout(previewTimer.current);
    previewTimer.current = window.setTimeout(() => {
      if (id == null || previewIdRef.current === id) {
        setPreviewId(null);
      }
    }, GEOM.previewLeaveMs);
  }, []);

  const schedulePreview = useCallback(
    (id: string) => {
      if (kindRef.current !== "fan" || transitRef.current) return;
      window.clearTimeout(previewTimer.current);
      if (previewIdRef.current === id) {
        setPreviewTop(measurePreviewTop(id));
        return;
      }
      setPreviewId(id);
      setPreviewTop(measurePreviewTop(id));
    },
    [measurePreviewTop],
  );
  syncPreviewRef.current = syncPreviewUnderPointer;

  /** Slide the focused note away before unmounting (fan / rest). */
  const tweenNoteOut = () =>
    new Promise<void>((resolve) => {
      const node = noteRef.current;
      if (!node || reduceMotion) {
        resolve();
        return;
      }
      gsap.killTweensOf(node);
      gsap.to(node, {
        x: 22,
        opacity: 0,
        scale: 0.98,
        duration: GEOM.noteOutDur,
        ease: SPRING_OUT,
        transformOrigin: "right center",
        overwrite: "auto",
        onComplete: () => resolve(),
      });
    });

  const tweenFanOut = () =>
    new Promise<void>((resolve) => {
      const tabs = fanRef.current?.querySelectorAll<HTMLElement>(".tab");
      if (!tabs?.length || reduceMotion) {
        resolve();
        return;
      }
      gsap.killTweensOf(tabs);
      gsap.to(tabs, {
        x: GEOM.tabWidth + 24,
        opacity: 0,
        duration: GEOM.fanOutDur,
        stagger: { each: GEOM.staggerOut },
        ease: SPRING_OUT,
        overwrite: "auto",
        onComplete: () => resolve(),
      });
    });

  /** Collapse UI first; HWND size never changes (mode-only dock). */
  const goRest = useCallback(async () => {
    window.clearTimeout(restLeaveTimer.current);
    window.clearTimeout(fanEnterTimer.current);
    const gen = ++transitGen.current;
    transitRef.current = true;
    rememberNoteScroll(openIdRef.current);
    const fanEl = fanRef.current?.querySelector(".fan");
    if (fanEl) {
      uxMem.current.fanScroll = fanEl.scrollTop;
      flushUx();
    }
    clearPreviewNow();
    setDictHint("");

    const from = kindRef.current;
    if (from === "expanded" && openIdRef.current) {
      await tweenNoteOut();
      if (gen !== transitGen.current) {
        transitRef.current = false;
        return;
      }
    }
    if (from === "fan" || from === "expanded") {
      await tweenFanOut();
      if (gen !== transitGen.current) {
        transitRef.current = false;
        return;
      }
    }

    setOpenId(null);
    setOpenedTop(null);
    openedAnchorRef.current = null;
    openedTopRef.current = null;
    setNotePos({});
    setKind("rest");
    if (gen !== transitGen.current) {
      transitRef.current = false;
      return;
    }
    // Don't await IPC — it stalls pill re-entry on rapid flicks.
    void dockEdge("rest", Math.max(1, active.length));
    void setHitRegions(collectHitRegions(rootRef.current));
    transitRef.current = false;
  }, [active.length, clearPreviewNow]);

  const notesSnap = useRef(notes);
  notesSnap.current = notes;

  const goFan = useCallback(async () => {
    // Interrupt any in-flight rest — rapid leave/re-enter must not stick on pill.
    window.clearTimeout(restLeaveTimer.current);
    window.clearTimeout(fanEnterTimer.current);
    transitGen.current += 1;
    transitRef.current = false;

    bump();
    rememberNoteScroll(openIdRef.current);
    clearPreviewNow();
    setDictHint("");

    const from = kindRef.current;
    const curId = openIdRef.current;
    const curPinned = !!notesSnap.current.find((n) => n.id === curId)?.pinned;
    if (from === "expanded" && curId && !curPinned) {
      await tweenNoteOut();
      setNotePos((prev) => {
        if (!(curId in prev)) return prev;
        const next = { ...prev };
        delete next[curId];
        return next;
      });
    }

    setOpenId(null);
    setOpenedTop(null);
    openedAnchorRef.current = null;
    openedTopRef.current = null;

    void dockEdge("fan", Math.max(1, active.length));
    if (from === "rest") {
      revealGen.current += 1;
      setStaging(true);
      setKind("fan");
      requestAnimationFrame(() => syncPreviewRef.current());
    } else {
      // Re-entering mid rest-collapse: force a fresh shingle reveal.
      if (from === "fan") {
        const tabs = fanRef.current?.querySelectorAll<HTMLElement>(".tab");
        if (tabs?.length) gsap.killTweensOf(tabs);
        revealGen.current += 1;
        setStaging(true);
      }
      setKind("fan");
    }
    void setHitRegions(collectHitRegions(rootRef.current));
  }, [active.length, clearPreviewNow]);

  const removeNote = useCallback(
    (id: string) => {
      bump();
      rememberNoteScroll(openIdRef.current === id ? id : null);
      if (noteRef.current) gsap.killTweensOf(noteRef.current);
      const wasOpen = openIdRef.current === id;
      if (wasOpen) {
        setOpenId(null);
        setOpenedTop(null);
        openedAnchorRef.current = null;
        openedTopRef.current = null;
      }
      delete uxMem.current.noteScroll[id];
      flushUx();
      setNotePos((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setNotes((prev) => {
        const next = prev.filter((n) => n.id !== id);
        window.clearTimeout(saveTimer.current);
        notesRef.current = next;
        saveNotes(next);
        return next;
      });
      if (wasOpen) void goFan();
    },
    [goFan],
  );

  /** Debounced rest→fan — pill is tiny; raw mouseenter flickers the dock. */
  const scheduleFan = useCallback(() => {
    window.clearTimeout(restLeaveTimer.current);
    window.clearTimeout(fanEnterTimer.current);
    fanEnterTimer.current = window.setTimeout(() => {
      if (kindRef.current === "rest" || transitRef.current) void goFan();
    }, 16);
  }, [goFan]);

  const cancelScheduleFan = useCallback(() => {
    window.clearTimeout(fanEnterTimer.current);
  }, []);

  /** Soft fan→rest so a quick flick back onto the strip can cancel. */
  const scheduleRest = useCallback(() => {
    window.clearTimeout(restLeaveTimer.current);
    restLeaveTimer.current = window.setTimeout(() => {
      if (kindRef.current === "fan" && !transitRef.current) void goRest();
    }, GEOM.restLeaveMs);
  }, [goRest]);

  const goExpanded = useCallback(
    async (id: string, noteCount = active.length) => {
      bump();
      clearPreviewNow();
      setDictHint("");

      if (kindRef.current === "expanded" && openIdRef.current === id) {
        // Toggle close; pinned note remains visible via sheet list.
        void goFan();
        return;
      }

      // Leaving a pinned note open elsewhere — keep it on screen.
      rememberNoteScroll(openIdRef.current);

      const from = kindRef.current;
      // Hit mode only — never block the open spring on IPC (Noty keeps UI snappy).
      void dockEdge("expanded", Math.max(1, noteCount));

      if (from === "rest") {
        revealGen.current += 1;
        setStaging(true);
        setKind("fan");
        await wait(GEOM.expandFrameMs);
      }

      const el = tabEls.current.get(id);
      if (el) {
        const scroller = fanRef.current?.querySelector(".fan");
        if (scroller) {
          const fr = scroller.getBoundingClientRect();
          const er = el.getBoundingClientRect();
          if (er.top < fr.top - 1 || er.bottom > fr.bottom + 1) {
            el.scrollIntoView({ block: "nearest", inline: "nearest" });
          }
        }
      }

      // Measure + open in one turn — no pre-waits / no tab-pop ahead of the card.
      const panel = panelH || window.innerHeight;
      const fixedH = Math.min(380, Math.max(220, Math.round(panel * 0.42)));
      const stripCenter = el
        ? (() => {
            const r = el.getBoundingClientRect();
            return r.top + r.height / 2;
          })()
        : fanTop + itemHeight / 2;
      const top = fitNoteTop(stripCenter - fixedH / 2, fixedH, panel);
      openedAnchorRef.current = stripCenter;
      openedTopRef.current = top;

      // Keep in-session free-drag positions when switching focus between sheets.
      setOpenedTop(top);
      setKind("expanded");
      setOpenId(id);
      restoreNoteScroll(id);
    },
    [active.length, clearPreviewNow, fanTop, goFan, itemHeight, panelH],
  );

  const newNote = () => {
    bump();
    clearPreviewNow();
    const note = createNote("", "", {
      color: notes.length % PALETTE.length,
      order: midInsertOrder(notes),
    });
    const next = [...notes, note];
    persist(next);
    void (async () => {
      if (kindRef.current === "rest") {
        await dockEdge("fan", Math.max(1, next.length));
        revealGen.current += 1;
        setStaging(true);
        setKind("fan");
        await wait(48);
      } else if (kindRef.current === "expanded") {
        await dockEdge("fan", Math.max(1, next.length));
        setKind("fan");
        await wait(40);
      }
      // Brief beat so the mid-stack tab lays out before we expand onto it.
      await wait(50);
      await goExpanded(note.id, next.length);
    })();
  };

  useEffect(() => {
    const id = window.setInterval(() => {
      if (transitRef.current) return;
      const idle = Date.now() - lastActivity.current;
      if (kindRef.current === "fan" && idle >= GEOM.fanIdleMs) void goRest();
      if (kindRef.current === "expanded" && idle >= GEOM.noteIdleMs) {
        const note = active.find((n) => n.id === openIdRef.current);
        if (note && !note.pinned) void goRest();
      }
    }, 120);
    return () => clearInterval(id);
  }, [active, goRest]);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancel = false;
    void listen("deck-away", () => {
      if (kindRef.current === "fan") scheduleRest();
    }).then((fn) => {
      if (cancel) fn();
      else unlisten = fn;
    });
    return () => {
      cancel = true;
      unlisten?.();
    };
  }, [scheduleRest]);

  useGSAP(
    () => {
      if (!fanRef.current) return;
      // Fan↔expanded must not re-tween tabs — that fights the note spring (first open jank).
      if (kind === "expanded") return;

      const tabs = fanRef.current.querySelectorAll<HTMLElement>(".tab");
      if (!tabs.length) return;

      if (kind === "rest") {
        gsap.set(tabs, { x: GEOM.tabWidth + 24, opacity: 0, clearProps: "scale" });
        setStaging(false);
        return;
      }

      const fresh = revealGen.current !== lastReveal.current;
      if (!fresh || reduceMotion) {
        gsap.set(tabs, { x: 0, opacity: 1 });
        if (fresh) lastReveal.current = revealGen.current;
        setStaging(false);
        requestAnimationFrame(() => syncPreviewRef.current());
        return;
      }

      lastReveal.current = revealGen.current;
      setStaging(true);
      gsap.fromTo(
        tabs,
        { x: GEOM.tabWidth + 24, opacity: 0 },
        {
          x: 0,
          opacity: 1,
          duration: GEOM.fanInDur,
          ease: SPRING_IN,
          stagger: { each: GEOM.staggerIn },
          overwrite: "auto",
          onComplete: () => {
            setStaging(false);
            syncPreviewRef.current();
          },
        },
      );
    },
    { dependencies: [kind, revealGen.current, fanNotes.length], scope: rootRef },
  );

  useGSAP(
    () => {
      const node = noteRef.current;
      if (!node) return;
      if (kind !== "expanded" || !openId) {
        // Leave transform to tweenNoteOut — don't snap-hide mid dismiss.
        return;
      }
      // Already free-dragged / on-screen: don't replay the dock slide (looks like a jump).
      if (reduceMotion || notePos[openId]) {
        gsap.killTweensOf(node);
        gsap.set(node, { x: 0, opacity: 1, scale: 1 });
        return;
      }
      gsap.fromTo(
        node,
        { x: 14, opacity: 0, scale: 0.99, transformOrigin: "right center" },
        {
          x: 0,
          opacity: 1,
          scale: 1,
          duration: GEOM.noteInDur,
          ease: SPRING_IN,
          overwrite: "auto",
        },
      );
    },
    { dependencies: [kind, openId], scope: rootRef },
  );

  const patchNote = (id: string, patch: Partial<VocabNote>) => {
    setNotes((prev) => {
      const next = prev.map((n) => (n.id === id ? { ...n, ...patch } : n));
      notesRef.current = next;
      queueSave();
      return next;
    });
    bump();
  };

  const scheduleTranslate = (
    id: string,
    text: string,
    source: "primary" | "example",
  ) => {
    window.clearTimeout(translateTimer.current);
    const trimmed = text.trim();
    if (trimmed.length < 2 || !/[a-zA-Z]/.test(trimmed)) return;
    const seq = ++translateSeq.current;
    setDictHint(source === "example" ? "翻译例句…" : "翻译中…");
    translateTimer.current = window.setTimeout(() => {
      void translateSentence(trimmed).then((zh) => {
        if (seq !== translateSeq.current || openIdRef.current !== id) return;
        if (!zh) {
          setDictHint("翻译失败，可手动填写");
          return;
        }
        setNotes((prev) => {
          const next = prev.map((n) => {
            if (n.id !== id) return n;
            if (source === "primary" && n.word.trim() !== trimmed) return n;
            if (source === "example" && (n.example ?? "").trim() !== trimmed) {
              return n;
            }
            return { ...n, translation: zh };
          });
          notesRef.current = next;
          queueSave();
          return next;
        });
        setDictHint("已填入翻译");
        bump();
      });
    }, GEOM.dictDebounceMs);
  };

  /** Always fill 释义 via Bing when dictionary has none. */
  const fillMeaningFromBing = (id: string, q: string) => {
    const trimmed = q.trim();
    if (trimmed.length < 2) return;
    setDictHint("翻译释义…");
    void translateSentence(trimmed).then((zh) => {
      if (openIdRef.current !== id) return;
      if (!zh) {
        setDictHint("释义翻译失败，可手动填写");
        return;
      }
      setNotes((prev) => {
        const next = prev.map((n) => {
          if (
            n.id !== id ||
            n.word.trim().toLowerCase() !== trimmed.toLowerCase()
          ) {
            return n;
          }
          if (n.meaning.trim()) return n;
          return { ...n, meaning: zh };
        });
        notesRef.current = next;
        queueSave();
        return next;
      });
      setDictHint("已填入释义");
      bump();
    });
  };

  const applyDictHit = (id: string, q: string, hit: DictHit) => {
    const example = hit.example?.trim() || undefined;
    const hasMeaning = Boolean(hit.meaning.trim());
    setNotes((prev) => {
      const next = prev.map((n) => {
        if (n.id !== id) return n;
        if (n.word.trim().toLowerCase() !== q.toLowerCase()) return n;
        return {
          ...n,
          meaning: hit.meaning || n.meaning,
          example,
          // 句子翻译 only pairs with an example; clear when none.
          translation: example ? n.translation : undefined,
          forms: hit.forms || n.forms,
          phrases: hit.phrases || n.phrases,
          synonyms: hit.synonyms || n.synonyms,
          etymology: hit.etymology || n.etymology,
        };
      });
      notesRef.current = next;
      queueSave();
      return next;
    });
    bump();
    if (!hasMeaning) fillMeaningFromBing(id, q);
    if (example) scheduleTranslate(id, example, "example");
    else if (hasMeaning) setDictHint("已填入释义");
  };

  const onPrimaryChange = (id: string, raw: string) => {
    window.clearTimeout(dictTimer.current);
    window.clearTimeout(translateTimer.current);
    const q = raw.trim();
    const kind = classifyEntry(q);

    if (kind === "empty") {
      patchNote(id, { word: raw, ...CLEAR_VOCAB });
      setDictHint("");
      return;
    }

    if (kind === "note") {
      patchNote(id, { word: raw, ...CLEAR_VOCAB, translation: undefined });
      setDictHint("");
      return;
    }

    if (kind === "sentence") {
      patchNote(id, { word: raw, ...CLEAR_VOCAB });
      scheduleTranslate(id, q, "primary");
      return;
    }

    // Word / phrase → dict; 释义 always; 例句/句子翻译 only when example exists.
    patchNote(id, { word: raw, example: undefined, translation: undefined });
    setDictHint("查词典…");
    const seq = ++dictSeq.current;
    dictTimer.current = window.setTimeout(() => {
      void lookupWord(q).then((hit) => {
        if (seq !== dictSeq.current || openIdRef.current !== id) return;
        if (!hit) {
          fillMeaningFromBing(id, q);
          return;
        }
        applyDictHit(id, q, hit);
      });
    }, GEOM.dictDebounceMs);
  };

  const onExampleChange = (id: string, example: string) => {
    patchNote(id, { example: example || undefined });
    const text = example.trim();
    if (text.length >= 2 && /[a-zA-Z]/.test(text)) {
      scheduleTranslate(id, example, "example");
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      bump();
      if (e.key !== "Escape") return;
      if (kindRef.current === "expanded") void goFan();
      else if (kindRef.current === "fan") void goRest();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goFan, goRest]);

  const lastHitJson = useRef("");
  useEffect(() => {
    const publish = () => {
      // Don't shrink hit regions mid-drag — click-through would freeze left moves.
      if (noteDraggingRef.current) return;
      const regions = collectHitRegions(rootRef.current);
      const json = JSON.stringify(regions);
      if (json === lastHitJson.current) return;
      lastHitJson.current = json;
      void setHitRegions(regions);
    };
    publish();
    const id = window.setInterval(publish, 160);
    window.addEventListener("resize", publish);
    return () => {
      clearInterval(id);
      window.removeEventListener("resize", publish);
      lastHitJson.current = "";
      void setHitRegions([]);
    };
  }, [kind, openId, previewId, active.length, openedTop, pillTop, fanTop, notePos]);

  // Noty: openedTop is frozen after open. Only push up if the bottom would clip.
  useEffect(() => {
    if (kind !== "expanded" || !openId) return;
    const node = noteRef.current;
    if (!node) return;

    const sync = () => {
      const h = node.offsetHeight;
      if (h < 48) return;
      const panel = panelH || window.innerHeight;
      const top = openedTopRef.current;
      if (top == null) return;
      const lowest = Math.max(10, panel - h - 10);
      if (top <= lowest) return;
      // Only nudge up when the card would clip the bottom — never re-center.
      openedTopRef.current = lowest;
      setOpenedTop(lowest);
    };

    sync();
    const ro = new ResizeObserver(() => sync());
    ro.observe(node);
    window.addEventListener("resize", sync);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [kind, openId, panelH]);

  const previewPalette = previewNote ? colorAt(previewNote.color) : null;
  const noteTop = openedTop ?? Math.max(10, fanTop);
  const pillDashes = active.slice(0, GEOM.maxDashes);
  const showFan = kind === "fan" || kind === "expanded";
  /** Focused note + all pinned stickies (stay while browsing other tabs). */
  const sheetNotes = useMemo(() => {
    const ids = new Set<string>();
    if (openId) ids.add(openId);
    for (const n of active) if (n.pinned) ids.add(n.id);
    return active.filter((n) => ids.has(n.id));
  }, [active, openId]);
  const lines = previewNote ? previewLines(previewNote) : [];
  // Cap height; vertical placement (fitNoteTop) keeps the card on-screen.
  const noteMaxH = Math.max(200, Math.min(640, panelH - 20));

  const onDeckContext = (e: MouseEvent) => {
    const el = e.target as HTMLElement | null;
    // Title / body / fields: keep OS menu (粘贴 / 复制 / 剪切).
    if (el?.closest("textarea, input, .note-word, .note-section, .note-body")) {
      return;
    }
    // Tab has its own menu.
    if (el?.closest(".tab")) return;
    e.preventDefault();
    bump();
    void showDeckMenu();
  };

  const clearTabDragStyles = () => {
    for (const el of tabEls.current.values()) {
      el.classList.remove("is-dragging");
      el.style.transform = "";
      el.style.zIndex = "";
      el.style.transition = "";
    }
  };

  const paintTabDrag = (drag: NonNullable<typeof tabDrag.current>, clientY: number) => {
    const dy = clientY - drag.startY;
    const hover = Math.max(
      0,
      Math.min(
        fanNotes.length - 1,
        drag.fromIndex + Math.round(dy / Math.max(1, pitch)),
      ),
    );
    drag.hoverIndex = hover;
    const from = drag.fromIndex;
    for (let i = 0; i < fanNotes.length; i++) {
      const id = fanNotes[i].id;
      const el = tabEls.current.get(id);
      if (!el) continue;
      if (id === drag.id) {
        el.classList.add("is-dragging");
        el.style.transition = "none";
        el.style.transform = `translateY(${dy}px)`;
        el.style.zIndex = "40";
        continue;
      }
      let shift = 0;
      if (from < hover && i > from && i <= hover) shift = -pitch;
      else if (from > hover && i >= hover && i < from) shift = pitch;
      el.style.transition = "transform 0.12s ease-out";
      el.style.transform = shift ? `translateY(${shift}px)` : "";
      el.style.zIndex = "";
    }
  };

  const endTabDrag = (clientY?: number) => {
    window.clearTimeout(longPressTimer.current);
    const drag = tabDrag.current;
    tabDrag.current = null;
    document.body.classList.remove("is-tab-dragging");
    if (drag?.active) void setInputCapture(false);
    const toIndex = drag?.active
      ? (clientY != null
          ? Math.max(
              0,
              Math.min(
                fanNotes.length - 1,
                drag.fromIndex +
                  Math.round((clientY - drag.startY) / Math.max(1, pitch)),
              ),
            )
          : drag.hoverIndex)
      : -1;
    clearTabDragStyles();
    if (!drag?.active) return;
    suppressTabClick.current = true;
    window.setTimeout(() => {
      suppressTabClick.current = false;
    }, 40);
    if (toIndex < 0 || toIndex === drag.fromIndex) return;
    persist(moveNoteOrder(notesRef.current, drag.id, toIndex));
  };

  /** Tab reorder: drag after a tiny move — no long-press wait. */
  const onTabPointerDown = (
    e: ReactPointerEvent<HTMLButtonElement>,
    id: string,
    index: number,
  ) => {
    if (e.button !== 0) return;
    bump();
    window.clearTimeout(longPressTimer.current);
    tabDrag.current = {
      id,
      startY: e.clientY,
      fromIndex: index,
      active: false,
      hoverIndex: index,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onTabPointerMove = (e: ReactPointerEvent) => {
    const drag = tabDrag.current;
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    if (!drag.active) {
      if (Math.abs(dy) < 6) return;
      drag.active = true;
      void setInputCapture(true);
      document.body.classList.add("is-tab-dragging");
      clearPreviewNow();
    }
    bump();
    e.preventDefault();
    paintTabDrag(drag, e.clientY);
  };

  const onTabPointerUp = (e: ReactPointerEvent) => {
    endTabDrag(e.clientY);
  };

  /** Grip: drag immediately (handle is explicit — no long-press). */
  const onNoteGripPointerDown = (
    e: ReactPointerEvent,
    note: VocabNote,
    el: HTMLElement | null,
  ) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    bump();
    window.clearTimeout(longPressTimer.current);

    const root = rootRef.current?.getBoundingClientRect();
    const cardRect = el?.getBoundingClientRect();
    const panelW = root?.width ?? window.innerWidth;
    const fallbackLeft =
      panelW - Math.min(NOTE_CARD_W, panelW - 88) - GEOM.noteInset;
    const raw =
      notePos[note.id] ??
      (cardRect && root
        ? { left: cardRect.left - root.left, top: cardRect.top - root.top }
        : {
            left: fallbackLeft,
            top: openedTopRef.current ?? noteTop,
          });
    const cardW = el?.offsetWidth || cardRect?.width || Math.min(NOTE_CARD_W, panelW - 88);
    const cardH = el?.offsetHeight || cardRect?.height || Math.min(280, noteMaxH);
    const locked = clampNotePos(
      raw.left,
      raw.top,
      panelW,
      panelH,
      cardW,
      cardH,
    );

    if (el) {
      gsap.killTweensOf(el);
      el.classList.add("is-free", "is-dragging-note");
      el.style.left = `${locked.left}px`;
      el.style.top = `${locked.top}px`;
      el.style.right = "auto";
      el.style.transform = "none";
    }

    noteDrag.current = {
      id: note.id,
      startX: e.clientX,
      startY: e.clientY,
      origLeft: locked.left,
      origTop: locked.top,
      active: true,
      cardW,
      cardH,
      last: locked,
      card: el,
    };
    noteDraggingRef.current = true;
    // Capture first (full panel live); also park a full hit rect for IPC race.
    void setInputCapture(true);
    void setHitRegions([
      { x: 0, y: 0, w: panelW, h: root?.height ?? panelH },
    ]);
    document.body.classList.add("is-note-dragging");
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onNoteGripPointerMove = (e: ReactPointerEvent) => {
    const drag = noteDrag.current;
    if (!drag?.active) return;
    bump();
    e.preventDefault();
    const root = rootRef.current?.getBoundingClientRect();
    const panelW = root?.width ?? window.innerWidth;
    const next = clampNotePos(
      drag.origLeft + (e.clientX - drag.startX),
      drag.origTop + (e.clientY - drag.startY),
      panelW,
      panelH,
      drag.cardW,
      drag.cardH,
    );
    drag.last = next;
    if (drag.raf) return;
    drag.raf = requestAnimationFrame(() => {
      const d = noteDrag.current;
      if (!d?.active || !d.last) return;
      d.raf = undefined;
      const card = d.card;
      if (card) {
        card.style.left = `${d.last.left}px`;
        card.style.top = `${d.last.top}px`;
        card.style.right = "auto";
      }
    });
  };

  const onNoteGripPointerUp = (e: ReactPointerEvent) => {
    const drag = noteDrag.current;
    noteDrag.current = null;
    noteDraggingRef.current = false;
    void setInputCapture(false);
    document.body.classList.remove("is-note-dragging");
    void setHitRegions(collectHitRegions(rootRef.current));
    if (drag?.raf) cancelAnimationFrame(drag.raf);
    if (drag?.card) drag.card.classList.remove("is-dragging-note");
    if (!drag?.active) return;
    const last = drag.last ?? {
      left: drag.origLeft,
      top: drag.origTop,
    };
    setNotePos((prev) => {
      const map = { ...prev, [drag.id]: last };
      return map;
    });
    // Free-drag implies stay-on-screen while browsing other tabs.
    const n = notesRef.current.find((x) => x.id === drag.id);
    if (n && !n.pinned) patchNote(drag.id, { pinned: true });
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const togglePin = (note: VocabNote, cardEl: HTMLElement | null) => {
    const nextPinned = !note.pinned;
    if (nextPinned && !notePos[note.id] && cardEl && rootRef.current) {
      const root = rootRef.current.getBoundingClientRect();
      const card = cardEl.getBoundingClientRect();
      const pos = clampNotePos(
        card.left - root.left,
        card.top - root.top,
        root.width,
        panelH,
        card.width,
        card.height,
      );
      setNotePos((prev) => ({ ...prev, [note.id]: pos }));
    }
    if (!nextPinned) {
      setNotePos((prev) => {
        if (!(note.id in prev)) return prev;
        const next = { ...prev };
        delete next[note.id];
        return next;
      });
    }
    patchNote(note.id, { pinned: nextPinned });
  };

  /** Unpin + clear focus in one shot (goFan would keep pinned sheets). */
  const dismissSheet = (id: string) => {
    bump();
    rememberNoteScroll(id);
    setNotePos((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setNotes((prev) => {
      const next = prev.map((n) =>
        n.id === id ? { ...n, pinned: false } : n,
      );
      window.clearTimeout(saveTimer.current);
      notesRef.current = next;
      saveNotes(next);
      return next;
    });
    void (async () => {
      if (openIdRef.current === id) {
        await tweenNoteOut();
        setOpenId(null);
        setOpenedTop(null);
        openedAnchorRef.current = null;
        openedTopRef.current = null;
        if (kindRef.current === "expanded") {
          setKind("fan");
          void dockEdge("fan", Math.max(1, active.length));
        }
      }
      void setHitRegions(collectHitRegions(rootRef.current));
    })();
  };

  // Restore fan scroll after rest → fan.
  useEffect(() => {
    if (!showFan) return;
    const fanEl = fanRef.current?.querySelector(".fan");
    if (!fanEl) return;
    fanEl.scrollTop = uxMem.current.fanScroll;
    const onScroll = () => {
      uxMem.current.fanScroll = fanEl.scrollTop;
      flushUx();
      bump();
      const id = previewIdRef.current;
      if (id) setPreviewTop(measurePreviewTop(id));
    };
    fanEl.addEventListener("scroll", onScroll, { passive: true });
    return () => fanEl.removeEventListener("scroll", onScroll);
  }, [showFan, fanNotes.length, measurePreviewTop]);

  return (
    <div
      ref={rootRef}
      className={`deck deck-${kind}${staging ? " is-staging" : ""}`}
      style={
        {
          "--note-inset": `${GEOM.noteInset}px`,
          "--tab-w": `${GEOM.tabWidth}px`,
        } as CSSProperties
      }
      onMouseMove={(e) => {
        lastPointer.current = { x: e.clientX, y: e.clientY };
        bump();
      }}
      onContextMenu={onDeckContext}
    >
      {kind === "rest" && (
        <button
          type="button"
          className="edge-hotzone"
          data-hit
          aria-label="Open deck"
          style={{ top: pillTop, height: pillH }}
          onMouseEnter={scheduleFan}
          onMouseLeave={cancelScheduleFan}
          onClick={() => void goFan()}
          onContextMenu={onDeckContext}
        >
          <span className="pill" aria-hidden>
            {(pillDashes.length ? pillDashes : [null]).map((n, i) => (
              <span
                key={n?.id ?? `empty-${i}`}
                className="dash"
                style={{
                  background: n
                    ? colorAt(n.color).dash
                    : "rgba(255,255,255,0.35)",
                }}
              />
            ))}
          </span>
        </button>
      )}

      {showFan && (
        <div
          className="fan-shell"
          ref={fanRef}
          style={
            {
              top: fanTop,
              "--pitch": `${pitch}px`,
              "--item-h": `${itemHeight}px`,
              "--strip": `${strip}px`,
              "--tab-w": `${GEOM.tabWidth}px`,
              "--fan-max": `${fanBudget}px`,
            } as CSSProperties
          }
        >
          <div
            className="fan"
            onMouseMove={(e) => {
              if (kindRef.current !== "fan" || tabDrag.current?.active) return;
              const tab = (e.target as HTMLElement | null)?.closest?.(
                "[data-note-id]",
              );
              const id = tab?.getAttribute("data-note-id");
              if (id) schedulePreview(id);
            }}
          >
            {fanNotes.map((n, i) => {
              const c = colorAt(n.color);
              const open = kind === "expanded" && openId === n.id;
              return (
                <button
                  key={n.id}
                  type="button"
                  ref={(el) => {
                    if (el) tabEls.current.set(n.id, el);
                    else tabEls.current.delete(n.id);
                  }}
                  className={`tab${open ? " is-open" : ""}`}
                  data-note-id={n.id}
                  style={{
                    marginTop: i === 0 ? 0 : pitch - itemHeight,
                  }}
                  aria-label={n.word || "New word"}
                  onClick={() => {
                    if (suppressTabClick.current) return;
                    void goExpanded(n.id);
                  }}
                  onMouseEnter={() => schedulePreview(n.id)}
                  onMouseLeave={() => schedulePreviewLeave(n.id)}
                  onPointerDown={(e) => onTabPointerDown(e, n.id, i)}
                  onPointerMove={onTabPointerMove}
                  onPointerUp={onTabPointerUp}
                  onPointerCancel={() => endTabDrag()}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    bump();
                    clearPreviewNow();
                    void showTabMenu({
                      pinned: n.pinned,
                      onPin: () =>
                        patchNote(n.id, { pinned: !n.pinned }),
                      onColor: () =>
                        patchNote(n.id, {
                          color: (n.color + 1) % PALETTE.length,
                        }),
                      onDelete: () => removeNote(n.id),
                    });
                  }}
                >
                  <span
                    className="tab-face"
                    style={{ background: c.paper, color: c.ink }}
                  >
                    <span className="tab-label">
                      {tabTitle(n.word || "NEW")}
                    </span>
                    {n.pinned && <span className="pin-dot" aria-hidden />}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="fan-actions" data-hit>
            <button
              type="button"
              className="icon-btn"
              aria-label="New word"
              onClick={newNote}
            >
              +
            </button>
          </div>
      </div>
      )}

      {/* Preview is a deck sibling (not inside the narrow fan-shell) so width
          and rounded corners are never clipped by the tab strip. */}
      {previewNote && previewPalette && kind === "fan" && (
        <aside
          className="tab-preview"
          data-hit
          style={{
            top: previewTop,
            right: GEOM.tabWidth + GEOM.previewGap,
            width: GEOM.previewWidth,
            background: previewPalette.paper,
            color: previewPalette.ink,
            borderColor: previewPalette.dash,
          }}
          onMouseEnter={() => {
            window.clearTimeout(previewTimer.current);
            setPreviewId(previewNote.id);
          }}
          onMouseLeave={() => schedulePreviewLeave(previewNote.id)}
          onClick={() => void goExpanded(previewNote.id)}
        >
          <header className="tab-preview-head">
            <span
              className="tab-preview-dot"
              style={{ background: previewPalette.dash }}
              aria-hidden
            />
              <strong>{tabTitle(previewNote.word || "New word")}</strong>
            {previewNote.pinned && (
              <span className="tab-preview-pin" aria-hidden>
                ◆
              </span>
            )}
          </header>
          {lines.length > 0 ? (
            <div className="tab-preview-body">
              {lines.map((line, i) => (
                <p key={`${i}-${line.slice(0, 12)}`}>{line}</p>
              ))}
            </div>
          ) : (
            <p className="tab-preview-empty">空词条 — 点开填写</p>
          )}
        </aside>
      )}

      {sheetNotes.map((sheet) => {
        const c = colorAt(sheet.color);
        const focused = sheet.id === openId;
        const entry = classifyEntry(sheet.word);
        const sheetIsNote = entry === "empty" || entry === "note";
        const sheetIsWord = entry === "word";
        const sheetIsSentence = entry === "sentence";
        const sheetWrap =
          sheetIsSentence || (sheetIsNote && [...sheet.word.trim()].length > 14);
        const sheetExample = !!(sheet.example?.trim());
        const pos = notePos[sheet.id];
        const dragging = noteDrag.current;
        const dragLive =
          dragging?.active && dragging.id === sheet.id
            ? (dragging.last ?? {
                left: dragging.origLeft,
                top: dragging.origTop,
              })
            : null;
        const place = dragLive ?? pos;
        const free = !!place;
        return (
          <article
            key={sheet.id}
            ref={focused ? noteRef : undefined}
            className={`note-card is-visible${free ? " is-free" : ""}${
              focused ? " is-focus" : ""
            }${sheet.pinned ? " is-pinned" : ""}`}
            data-hit
            style={{
              background: c.paper,
              color: c.ink,
              borderColor: c.dash,
              maxHeight: `${noteMaxH}px`,
              ...(free && place
                ? { left: place.left, top: place.top, right: "auto" }
                : {
                    top: `${focused ? noteTop : Math.max(10, fanTop + 24)}px`,
                  }),
              zIndex: focused ? 46 : 42,
            }}
            onPointerDown={() => {
              bump();
              if (!focused) void goExpanded(sheet.id);
            }}
          >
            <div
              className="note-scroll"
              ref={focused ? noteScrollRef : undefined}
              onScroll={(e) => {
                uxMem.current.noteScroll[sheet.id] = (
                  e.currentTarget as HTMLDivElement
                ).scrollTop;
                flushUx();
                bump();
              }}
            >
              <div className="note-body">
                <header className="note-head">
                  <span
                    className="note-grip"
                    title="拖动便签"
                    aria-label="拖动便签"
                    onPointerDown={(e) =>
                      onNoteGripPointerDown(e, sheet, e.currentTarget.closest(".note-card"))
                    }
                    onPointerMove={onNoteGripPointerMove}
                    onPointerUp={onNoteGripPointerUp}
                    onPointerCancel={onNoteGripPointerUp}
                  >
                    ⠿
                  </span>
                  <textarea
                    className={`note-word${sheetWrap ? " is-sentence" : ""}`}
                    value={sheet.word}
                    placeholder={sheetIsNote ? "标题" : "单词或句子"}
                    rows={sheetWrap ? 3 : 1}
                    autoFocus={focused && !sheet.word}
                    onChange={(e) => onPrimaryChange(sheet.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !sheetWrap) e.preventDefault();
                    }}
                    aria-label={sheetIsNote ? "Title" : "Word or sentence"}
                  />
                  <div className="note-tools">
                    <button
                      type="button"
                      title="Color"
                      style={{ color: c.dash }}
                      onClick={() =>
                        patchNote(sheet.id, {
                          color: (sheet.color + 1) % PALETTE.length,
                        })
                      }
                    >
                      ●
                    </button>
                    <button
                      type="button"
                      title={sheet.pinned ? "取消置顶（可关卡）" : "置顶（点其它标签不关）"}
                      onClick={(e) => {
                        const card = (e.currentTarget as HTMLElement).closest(
                          ".note-card",
                        ) as HTMLElement | null;
                        togglePin(sheet, card);
                      }}
                    >
                      {sheet.pinned ? "◆" : "◇"}
                    </button>
                    <button
                      type="button"
                      title="Close"
                      onClick={(e) => {
                        e.stopPropagation();
                        dismissSheet(sheet.id);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                </header>
                {focused && dictHint && (
                  <p className="dict-hint">{dictHint}</p>
                )}
                {!sheetIsSentence && (
                  <Section
                    label={sheetIsNote ? "内容" : "释义"}
                    value={sheet.meaning}
                    onChange={(v) => patchNote(sheet.id, { meaning: v })}
                    rows={sheetIsNote ? 6 : 2}
                    emphasis
                    scroll
                  />
                )}
                {sheetIsWord && sheetExample && (
                  <Section
                    label="例句"
                    value={sheet.example ?? ""}
                    onChange={(v) => onExampleChange(sheet.id, v)}
                    rows={2}
                    scroll
                  />
                )}
                {(sheetIsSentence || (sheetIsWord && sheetExample)) && (
                  <Section
                    label={sheetIsSentence ? "翻译" : "句子翻译"}
                    value={sheet.translation ?? ""}
                    onChange={(v) =>
                      patchNote(sheet.id, { translation: v || undefined })
                    }
                    rows={2}
                    scroll
                    emphasis={sheetIsSentence}
                  />
                )}
                {sheetIsWord && !!sheet.forms?.trim() && (
                  <Section
                    label="派生 / 词形"
                    value={sheet.forms}
                    onChange={(v) =>
                      patchNote(sheet.id, { forms: v || undefined })
                    }
                    rows={2}
                    scroll
                  />
                )}
                {sheetIsWord && !!sheet.phrases?.trim() && (
                  <Section
                    label="短语"
                    value={sheet.phrases}
                    onChange={(v) =>
                      patchNote(sheet.id, { phrases: v || undefined })
                    }
                    rows={2}
                    scroll
                  />
                )}
                {sheetIsWord && !!sheet.synonyms?.trim() && (
                  <Section
                    label="近义"
                    value={sheet.synonyms}
                    onChange={(v) =>
                      patchNote(sheet.id, { synonyms: v || undefined })
                    }
                    rows={2}
                    scroll
                  />
                )}
                {sheetIsWord && !!sheet.etymology?.trim() && (
                  <Section
                    label="词源"
                    value={sheet.etymology}
                    onChange={(v) =>
                      patchNote(sheet.id, { etymology: v || undefined })
                    }
                    rows={2}
                    scroll
                  />
                )}
              </div>
            </div>
            <footer className="note-foot">
              <button
                type="button"
                className="note-delete"
                onClick={() => removeNote(sheet.id)}
              >
                删除
              </button>
            </footer>
          </article>
        );
      })}
    </div>
  );
}
