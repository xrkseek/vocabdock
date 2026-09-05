import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
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
  fanTopPx,
  loadNotes,
  pillHeight,
  pillTopPx,
  pitchFor,
  saveNotes,
  type VocabNote,
} from "./lib/notes";
import { lookupWord } from "./lib/dict";
import { dockEdge, collectHitRegions, setHitRegions, showDeckMenu } from "./lib/window";
import "./App.css";

gsap.registerPlugin(useGSAP);

type Kind = "rest" | "fan" | "expanded";

const reduceMotion =
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function Section({
  label,
  value,
  onChange,
  rows = 2,
  emphasis = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  emphasis?: boolean;
}) {
  return (
    <label className={`note-section${emphasis ? " is-emphasis" : ""}`}>
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
  const [openedTop, setOpenedTop] = useState<number | null>(null);
  const [dictHint, setDictHint] = useState("");
  const [panelH, setPanelH] = useState(
    () => (typeof window !== "undefined" ? window.innerHeight : 800),
  );

  const rootRef = useRef<HTMLDivElement>(null);
  const fanRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLDivElement>(null);
  const tabEls = useRef<Map<string, HTMLButtonElement>>(new Map());
  const lastActivity = useRef(Date.now());
  const revealGen = useRef(0);
  const lastReveal = useRef(-1);
  const previewTimer = useRef(0);
  const saveTimer = useRef(0);
  const dictTimer = useRef(0);
  const dictSeq = useRef(0);
  const kindRef = useRef(kind);
  const openIdRef = useRef(openId);
  kindRef.current = kind;
  openIdRef.current = openId;

  const active = useMemo(
    () => [...notes].sort((a, b) => a.order - b.order),
    [notes],
  );
  const openNote = openId ? (active.find((n) => n.id === openId) ?? null) : null;
  const previewNote = previewId
    ? (active.find((n) => n.id === previewId) ?? null)
    : null;

  const pitch = pitchFor(active.map((n) => n.word || "NEW"));
  const itemHeight = pitch + GEOM.tabLap;
  const strip = pitch;
  const stackH =
    (active.length ? (active.length - 1) * pitch + itemHeight : 0) +
    GEOM.plusGap +
    GEOM.plusSize;
  const pillH = pillHeight(Math.max(1, active.length));
  const pillTop = pillTopPx(panelH, Math.max(1, active.length));
  const fanTop = fanTopPx(panelH, Math.max(1, active.length), stackH);

  useEffect(() => {
    const sync = () => setPanelH(window.innerHeight);
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [kind]);

  // Rest pill height only — do not re-dock fan (avoids Y jumps).
  useEffect(() => {
    if (kindRef.current === "rest") {
      void dockEdge("rest", Math.max(1, active.length));
    }
  }, [active.length]);

  const bump = () => {
    lastActivity.current = Date.now();
  };

  const persist = (next: VocabNote[]) => {
    setNotes(next);
    saveNotes(next);
  };

  const clearPreview = useCallback(() => {
    window.clearTimeout(previewTimer.current);
    setPreviewId(null);
  }, []);

  /** Noty: switch UI to rest at full size first, then shrink after delay. */
  const goRest = useCallback(async () => {
    clearPreview();
    setOpenId(null);
    setOpenedTop(null);
    setDictHint("");
    setKind("rest");
    await wait(GEOM.shrinkDelayMs);
    if (kindRef.current !== "rest") return;
    await dockEdge("rest", Math.max(1, active.length));
  }, [active.length, clearPreview]);

  const goFan = useCallback(async () => {
    bump();
    clearPreview();
    setOpenedTop(null);
    setDictHint("");

    const from = kindRef.current;
    if (from === "expanded" && noteRef.current && !reduceMotion) {
      await new Promise<void>((resolve) => {
        gsap.to(noteRef.current, {
          x: 40,
          opacity: 0,
          scale: 0.965,
          duration: 0.22,
          ease: "power2.in",
          transformOrigin: "right center",
          onComplete: () => resolve(),
        });
      });
    }

    setOpenId(null);
    if (from === "rest") {
      await dockEdge("fan", Math.max(1, active.length));
      revealGen.current += 1;
    }
    setKind("fan");
  }, [active.length, clearPreview]);

  const goExpanded = useCallback(
    async (id: string, noteCount = active.length) => {
      bump();
      clearPreview();
      setDictHint("");

      if (kindRef.current === "expanded" && openIdRef.current === id) {
        void goFan();
        return;
      }

      await dockEdge("expanded", Math.max(1, noteCount));
      if (!tabEls.current.get(id)) await wait(32);

      const el = tabEls.current.get(id);
      const tabOffset = el ? el.offsetTop : 0;
      setOpenedTop(
        Math.min(
          Math.max(10, fanTop + tabOffset),
          Math.round(window.innerHeight * 0.55),
        ),
      );

      await wait(16);
      setKind("expanded");
      setOpenId(id);
    },
    [active.length, clearPreview, fanTop, goFan],
  );

  const newNote = () => {
    bump();
    clearPreview();
    const minOrder = notes.reduce((m, n) => Math.min(m, n.order), 0);
    const note = createNote("", "", {
      color: notes.length % PALETTE.length,
      order: minOrder - 1,
    });
    const next = [note, ...notes];
    persist(next);
    void (async () => {
      if (kindRef.current === "rest") {
        await dockEdge("fan", Math.max(1, next.length));
        revealGen.current += 1;
        setKind("fan");
        await wait(48);
      }
      await goExpanded(note.id, next.length);
    })();
  };

  useEffect(() => {
    const id = window.setInterval(() => {
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
      if (kindRef.current === "fan") void goRest();
    }).then((fn) => {
      if (cancel) fn();
      else unlisten = fn;
    });
    return () => {
      cancel = true;
      unlisten?.();
    };
  }, [goRest]);

  useGSAP(
    () => {
      if (!fanRef.current) return;
      const tabs = fanRef.current.querySelectorAll<HTMLElement>(".tab");
      if (!tabs.length) return;

      if (kind === "rest") {
        gsap.set(tabs, { x: GEOM.tabWidth + 24, opacity: 0 });
        return;
      }

      const fresh = revealGen.current !== lastReveal.current;
      if (!fresh || reduceMotion) {
        gsap.set(tabs, { x: 0, opacity: 1 });
        if (fresh) lastReveal.current = revealGen.current;
        return;
      }

      lastReveal.current = revealGen.current;
      gsap.fromTo(
        tabs,
        { x: GEOM.tabWidth + 24, opacity: 0 },
        {
          x: 0,
          opacity: 1,
          duration: 0.34,
          ease: "back.out(0.55)",
          stagger: { each: GEOM.staggerIn },
          overwrite: "auto",
        },
      );
    },
    { dependencies: [kind, revealGen.current, active.length], scope: rootRef },
  );

  useGSAP(
    () => {
      if (!noteRef.current) return;
      if (kind !== "expanded") {
        gsap.set(noteRef.current, {
          x: 40,
          opacity: 0,
          scale: 0.965,
          transformOrigin: "right center",
        });
        return;
      }
      if (reduceMotion) {
        gsap.set(noteRef.current, { x: 0, opacity: 1, scale: 1 });
        return;
      }
      gsap.fromTo(
        noteRef.current,
        { x: 40, opacity: 0, scale: 0.965, transformOrigin: "right center" },
        {
          x: 0,
          opacity: 1,
          scale: 1,
          duration: 0.36,
          ease: "back.out(0.7)",
          overwrite: "auto",
        },
      );
    },
    { dependencies: [kind, openId], scope: rootRef },
  );

  const schedulePreview = (id: string) => {
    if (kindRef.current === "expanded") return;
    window.clearTimeout(previewTimer.current);
    previewTimer.current = window.setTimeout(() => {
      if (kindRef.current === "expanded") return;
      setPreviewId(id);
    }, GEOM.tabPreviewMs);
  };

  const patchNote = (id: string, patch: Partial<VocabNote>) => {
    setNotes((prev) => {
      const next = prev.map((n) => (n.id === id ? { ...n, ...patch } : n));
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(
        () => saveNotes(next),
        GEOM.autosaveMs,
      );
      return next;
    });
    bump();
  };

  const onWordChange = (id: string, word: string) => {
    patchNote(id, { word });
    window.clearTimeout(dictTimer.current);
    const q = word.trim();
    if (q.length < 2) {
      setDictHint("");
      return;
    }
    setDictHint("查词典…");
    const seq = ++dictSeq.current;
    dictTimer.current = window.setTimeout(() => {
      void lookupWord(q).then((hit) => {
        if (seq !== dictSeq.current || openIdRef.current !== id) return;
        if (!hit) {
          setDictHint("未找到，可手动填写");
          return;
        }
        setNotes((prev) => {
          const next = prev.map((n) => {
            if (n.id !== id) return n;
            if (n.word.trim().toLowerCase() !== q.toLowerCase()) return n;
            return {
              ...n,
              meaning: hit.meaning || n.meaning,
              example: hit.example || n.example,
              forms: hit.forms || n.forms,
              phrases: hit.phrases || n.phrases,
              synonyms: hit.synonyms || n.synonyms,
              etymology: hit.etymology || n.etymology,
            };
          });
          window.clearTimeout(saveTimer.current);
          saveTimer.current = window.setTimeout(
            () => saveNotes(next),
            GEOM.autosaveMs,
          );
          return next;
        });
        setDictHint("已填入释义、例句与派生");
        bump();
      });
    }, GEOM.dictDebounceMs);
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

  useEffect(() => {
    const publish = () => {
      void setHitRegions(collectHitRegions(rootRef.current));
    };
    publish();
    const id = window.setInterval(publish, 120);
    window.addEventListener("resize", publish);
    return () => {
      clearInterval(id);
      window.removeEventListener("resize", publish);
      void setHitRegions([]);
    };
  }, [kind, openId, previewId, active.length, openedTop, pillTop, fanTop]);

  const palette = openNote ? colorAt(openNote.color) : null;
  const noteTop = openedTop ?? Math.max(10, fanTop);
  const pillDashes = active.slice(0, GEOM.maxDashes);
  const showFan = kind === "fan" || kind === "expanded";

  const onDeckContext = (e: MouseEvent) => {
    e.preventDefault();
    bump();
    void showDeckMenu();
  };

  return (
    <div
      ref={rootRef}
      className={`deck deck-${kind}`}
      onMouseMove={bump}
      onContextMenu={onDeckContext}
    >
      {kind === "rest" && (
        <button
          type="button"
          className="edge-hotzone"
          data-hit
          aria-label="Open deck"
          style={{ top: pillTop, height: pillH }}
          onMouseEnter={() => void goFan()}
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
          style={{ top: fanTop }}
        >
          <div
            className="fan"
            style={
              {
                "--pitch": `${pitch}px`,
                "--item-h": `${itemHeight}px`,
                "--strip": `${strip}px`,
                "--tab-w": `${GEOM.tabWidth}px`,
              } as CSSProperties
            }
          >
            {active.map((n, i) => {
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
                  style={{
                    marginTop: i === 0 ? 0 : pitch - itemHeight,
                    zIndex: open ? 40 : undefined,
                  }}
                  title={n.word || "New word"}
                  onClick={() => void goExpanded(n.id)}
                  onMouseEnter={() => schedulePreview(n.id)}
                  onMouseLeave={clearPreview}
                >
                  <span
                    className="tab-face"
                    style={{ background: c.paper, color: c.ink }}
                  >
                    <span className="tab-label">{n.word || "NEW"}</span>
                    {n.pinned && <span className="pin-dot" aria-hidden />}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="fan-actions">
            <button
              type="button"
              className="icon-btn"
              title="New word"
              onClick={newNote}
            >
              +
            </button>
          </div>

          {previewNote && kind === "fan" && (
            <aside
              className="tab-preview"
              data-hit
              style={{
                background: colorAt(previewNote.color).paper,
                color: colorAt(previewNote.color).ink,
                borderColor: colorAt(previewNote.color).dash,
              }}
              onMouseEnter={() => {
                window.clearTimeout(previewTimer.current);
                setPreviewId(previewNote.id);
              }}
              onMouseLeave={clearPreview}
            >
              <strong>{previewNote.word || "New word"}</strong>
              <p>{previewNote.meaning || "Empty note"}</p>
            </aside>
          )}
        </div>
      )}

      <article
        ref={noteRef}
        className={`note-card${openNote ? " is-visible" : ""}`}
        data-hit={openNote ? true : undefined}
        style={
          openNote && palette
            ? {
                background: palette.paper,
                color: palette.ink,
                top: `${noteTop}px`,
                borderColor: palette.dash,
              }
            : undefined
        }
        aria-hidden={!openNote}
      >
        {openNote && palette && (
          <div className="note-body">
            <header className="note-head">
              <input
                className="note-word"
                value={openNote.word}
                placeholder="English word"
                autoFocus={!openNote.word}
                onChange={(e) => onWordChange(openNote.id, e.target.value)}
                aria-label="Word"
              />
              <div className="note-tools">
                <button
                  type="button"
                  title="Color"
                  style={{ color: palette.dash }}
                  onClick={() =>
                    patchNote(openNote.id, {
                      color: (openNote.color + 1) % PALETTE.length,
                    })
                  }
                >
                  ●
                </button>
                <button
                  type="button"
                  title={openNote.pinned ? "Unpin" : "Pin"}
                  onClick={() =>
                    patchNote(openNote.id, { pinned: !openNote.pinned })
                  }
                >
                  {openNote.pinned ? "◆" : "◇"}
                </button>
                <button type="button" title="Close" onClick={() => void goFan()}>
                  ✕
                </button>
              </div>
            </header>
            {dictHint && <p className="dict-hint">{dictHint}</p>}
            <Section
              label="释义"
              value={openNote.meaning}
              onChange={(v) => patchNote(openNote.id, { meaning: v })}
              rows={2}
              emphasis
            />
            <Section
              label="例句"
              value={openNote.example ?? ""}
              onChange={(v) =>
                patchNote(openNote.id, { example: v || undefined })
              }
            />
            {/* 派生等：查到 / 已有内容才出现，搜不到就不占位 */}
            {!!openNote.forms?.trim() && (
              <Section
                label="派生 / 词形"
                value={openNote.forms}
                onChange={(v) =>
                  patchNote(openNote.id, { forms: v || undefined })
                }
                rows={3}
              />
            )}
            {!!openNote.phrases?.trim() && (
              <Section
                label="短语"
                value={openNote.phrases}
                onChange={(v) =>
                  patchNote(openNote.id, { phrases: v || undefined })
                }
              />
            )}
            {!!openNote.synonyms?.trim() && (
              <Section
                label="近义"
                value={openNote.synonyms}
                onChange={(v) =>
                  patchNote(openNote.id, { synonyms: v || undefined })
                }
              />
            )}
            {!!openNote.etymology?.trim() && (
              <Section
                label="词源"
                value={openNote.etymology}
                onChange={(v) =>
                  patchNote(openNote.id, { etymology: v || undefined })
                }
              />
            )}
            <button
              type="button"
              className="note-delete"
              onClick={() => {
                persist(notes.filter((n) => n.id !== openNote.id));
                void goFan();
              }}
            >
              Delete
            </button>
          </div>
        )}
      </article>
    </div>
  );
}
