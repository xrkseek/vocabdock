import { invoke, isTauri } from "@tauri-apps/api/core";
import type { DeckMode } from "./notes";

export type HitRect = { x: number; y: number; w: number; h: number };

export async function dockEdge(
  mode: DeckMode,
  noteCount?: number,
): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("dock_edge", { mode, noteCount: noteCount ?? null });
  } catch {
    /* ignore */
  }
}

/** Publish chrome outside the edge strip (preview / open note). */
export async function setHitRegions(regions: HitRect[]): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("set_hit_regions", { regions });
  } catch {
    /* ignore */
  }
}

export function collectHitRegions(root: HTMLElement | null): HitRect[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>("[data-hit]")).map(
    (el) => {
      const r = el.getBoundingClientRect();
      return {
        x: r.left,
        y: r.top,
        w: Math.max(1, r.width),
        h: Math.max(1, r.height),
      };
    },
  );
}

/** Noty-style deck menu: Quit. */
export async function showDeckMenu(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { Menu, MenuItem } = await import("@tauri-apps/api/menu");
    const quit = await MenuItem.new({
      id: "quit",
      text: "退出 Notepad",
      action: () => {
        void invoke("quit_app");
      },
    });
    const menu = await Menu.new({ items: [quit] });
    await menu.popup();
  } catch {
    void invoke("quit_app");
  }
}
