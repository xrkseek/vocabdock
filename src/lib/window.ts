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

/** Keep the dock HWND interactive for the duration of a drag. */
export async function setInputCapture(capture: boolean): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("set_input_capture", { capture });
  } catch {
    /* ignore */
  }
}

export function collectHitRegions(root: HTMLElement | null): HitRect[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>("[data-hit]"))
    .map((el) => {
      const r = el.getBoundingClientRect();
      const pad = 1;
      return {
        x: r.left + pad,
        y: r.top + pad,
        w: Math.max(0, r.width - pad * 2),
        h: Math.max(0, r.height - pad * 2),
      };
    })
    .filter((r) => r.w >= 2 && r.h >= 2);
}

/** Deck chrome menu (edge / fan). Editable fields use the native menu. */
export async function showDeckMenu(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { Menu, MenuItem } = await import("@tauri-apps/api/menu");
    const quit = await MenuItem.new({
      id: "quit",
      text: "退出 VocabDock",
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

export type TabMenuActions = {
  pinned: boolean;
  onPin: () => void;
  onColor: () => void;
  onDelete: () => void;
};

/** Right-click menu on a fan tab. */
export async function showTabMenu(actions: TabMenuActions): Promise<void> {
  if (!isTauri()) {
    if (confirm("删除此便签？")) actions.onDelete();
    return;
  }
  try {
    const { Menu, MenuItem, PredefinedMenuItem } = await import(
      "@tauri-apps/api/menu"
    );
    const pin = await MenuItem.new({
      id: "pin",
      text: actions.pinned ? "取消置顶" : "置顶",
      action: () => actions.onPin(),
    });
    const color = await MenuItem.new({
      id: "color",
      text: "换色",
      action: () => actions.onColor(),
    });
    const sep = await PredefinedMenuItem.new({ item: "Separator" });
    const del = await MenuItem.new({
      id: "delete",
      text: "删除",
      action: () => actions.onDelete(),
    });
    const menu = await Menu.new({ items: [pin, color, sep, del] });
    await menu.popup();
  } catch {
    if (confirm("删除此便签？")) actions.onDelete();
  }
}
