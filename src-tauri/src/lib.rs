use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};

/// Noty geometry (logical px at 100% scale).
const PILL_W: f64 = 12.0;
const EDGE_W: f64 = 14.0;
const DASH_H: f64 = 14.0;
const DASH_GAP: f64 = 5.0;
const PILL_PAD: f64 = 7.0;
/// Noty fanWidth (50) — the interactive strip against the edge.
const FAN_W: f64 = 50.0;
/// Noty: hotZone width = fanWidth + 20.
const HOT_PAD: f64 = 20.0;
/// Fan + expanded share this width so opening a note cannot "fly in".
/// Noty default medium note: max(50, 460) + 22 = 482. We use small 400 → 422;
/// keep a little headroom for lean/bleed.
const PANEL_W: f64 = 442.0;
const DECK_Y_RATIO: f64 = 0.5;

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct HitRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Debug)]
struct DeckHit {
    /// rest | fan | expanded
    mode: String,
    /// Preview / open-note rects in CSS viewport px (logical).
    extras: Vec<HitRect>,
}

struct HitState(Arc<Mutex<DeckHit>>);

fn pill_height(note_count: u32) -> f64 {
    let n = note_count.clamp(1, 14) as f64;
    PILL_PAD * 2.0 + n * DASH_H + (n - 1.0).max(0.0) * DASH_GAP
}

fn dock_window(window: &WebviewWindow, mode: &str, note_count: u32) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or_else(|| "no monitor".to_string())?;

    let work = monitor.work_area();
    let full = monitor.size();
    let full_pos = monitor.position();
    let scale = monitor.scale_factor();

    let (w_log, h_log, y_phys) = match mode {
        // Noty rest: panel is only the pill height — not full-screen.
        "rest" => {
            let h = pill_height(note_count);
            let available = (work.size.height as f64 / scale) - h;
            // Windows y grows downward; Noty (Cocoa) y grows up with deckYRatio
            // from visibleFrame.minY — mid-screen ≈ ratio 0.5 either way.
            let y_from_work_top = available * (1.0 - DECK_Y_RATIO);
            let y = work.position.y + (y_from_work_top * scale).round() as i32;
            (EDGE_W.max(PILL_W + 2.0), h, y)
        }
        // Noty fan + expanded: same width, full work-area height.
        "fan" | "expanded" => {
            let h = work.size.height as f64 / scale;
            (PANEL_W, h, work.position.y)
        }
        _ => (EDGE_W, pill_height(note_count), work.position.y),
    };

    let width_phys = (w_log * scale).round() as u32;
    let height_phys = (h_log * scale).round() as u32;
    // Dock to absolute right of the monitor (Noty: full.maxX - w).
    let x = full_pos.x + full.width as i32 - width_phys as i32;

    window
        .set_size(PhysicalSize::new(width_phys, height_phys.max(1)))
        .map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(x, y_phys))
        .map_err(|e| e.to_string())?;
    let _ = window.set_ignore_cursor_events(false);
    let _ = window.set_always_on_top(true);
    Ok(())
}

#[tauri::command]
fn dock_edge(
    app: AppHandle,
    mode: String,
    note_count: Option<u32>,
    state: State<'_, HitState>,
) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    {
        let mut hit = state.0.lock();
        hit.mode = mode.clone();
        if mode == "rest" {
            hit.extras.clear();
        }
    }
    dock_window(&window, &mode, note_count.unwrap_or(5))
}

/// Extra interactive rects outside the edge strip (preview / note).
#[tauri::command]
fn set_hit_regions(regions: Vec<HitRect>, state: State<'_, HitState>) {
    state.0.lock().extras = regions;
}

#[tauri::command]
fn quit_app(_app: AppHandle) {
    // Hit-test thread is non-joinable; force exit so Quit really ends the process.
    std::process::exit(0);
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let quit = MenuItem::with_id(app, "quit", "退出 Notepad", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&quit])?;
    // Path is relative to the crate root (src-tauri/), not src/.
    let icon = app
        .default_window_icon()
        .cloned()
        .unwrap_or_else(|| tauri::include_image!("icons/32x32.png"));
    let _ = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Notepad — 右键退出")
        .on_menu_event(|_app, event| {
            if event.id.as_ref() == "quit" {
                std::process::exit(0);
            }
        })
        .build(app)?;
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
struct DictHit {
    meaning: String,
    example: Option<String>,
    forms: Option<String>,
    phrases: Option<String>,
    synonyms: Option<String>,
    etymology: Option<String>,
}

fn strip_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clean_lookup_word(raw: &str) -> Option<String> {
    let word = raw.trim().to_lowercase();
    if word.len() < 2 || word.len() > 40 {
        return None;
    }
    if !word
        .chars()
        .all(|c| c.is_ascii_alphabetic() || c == '\'' || c == '-')
    {
        return None;
    }
    Some(word)
}

fn urlencoding_lite(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn youdao_meaning(json: &serde_json::Value) -> Option<String> {
    if let Some(trs) = json.pointer("/ec/word/0/trs").and_then(|v| v.as_array()) {
        let mut parts = Vec::new();
        for tr in trs {
            if let Some(s) = tr
                .pointer("/tr/0/l/i/0")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                parts.push(s.to_string());
            }
        }
        if !parts.is_empty() {
            return Some(parts.join("；"));
        }
    }
    json.pointer("/web_trans/web-translation/0/trans/0/value")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn youdao_example(json: &serde_json::Value) -> Option<String> {
    for path in [
        "/blng_sents_part/sentence-pair/0/sentence",
        "/auth_sents_part/sent/0/foreign",
        "/ee/word/trs/0/tr/0/exam/i/f/l/0/i",
    ] {
        if let Some(s) = json.pointer(path).and_then(|v| v.as_str()) {
            let t = strip_html(s);
            if !t.is_empty() {
                return Some(t);
            }
        }
    }
    None
}

fn youdao_forms(json: &serde_json::Value) -> Option<String> {
    let mut lines = Vec::new();
    if let Some(stem) = json
        .pointer("/rel_word/stem")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        lines.push(format!("词根 {stem}"));
    }
    if let Some(rels) = json.pointer("/rel_word/rels").and_then(|v| v.as_array()) {
        for rel in rels {
            let pos = rel
                .pointer("/rel/pos")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let words = rel
                .pointer("/rel/words")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|w| {
                            let word = w.get("word")?.as_str()?;
                            let tran = w
                                .get("tran")
                                .and_then(|t| t.as_str())
                                .unwrap_or("")
                                .trim();
                            if tran.is_empty() {
                                Some(word.to_string())
                            } else {
                                Some(format!("{word} {tran}"))
                            }
                        })
                        .collect::<Vec<_>>()
                        .join(" · ")
                })
                .unwrap_or_default();
            if !words.is_empty() {
                lines.push(format!("{pos} {words}").trim().to_string());
            }
        }
    }
    // collins index forms as fallback extras
    if lines.is_empty() {
        if let Some(forms) = json
            .pointer("/collins_primary/words/indexforms")
            .and_then(|v| v.as_array())
        {
            let joined = forms
                .iter()
                .filter_map(|v| v.as_str())
                .collect::<Vec<_>>()
                .join(" · ");
            if !joined.is_empty() {
                lines.push(joined);
            }
        }
    }
    if lines.is_empty() {
        None
    } else {
        Some(lines.join("\n"))
    }
}

fn youdao_phrases(json: &serde_json::Value) -> Option<String> {
    let mut lines = Vec::new();
    if let Some(phrs) = json.pointer("/phrs/phrs").and_then(|v| v.as_array()) {
        for p in phrs.iter().take(6) {
            let head = p
                .pointer("/phr/headword/l/i")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            let tran = p
                .pointer("/phr/trs/0/tr/l/i")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if !head.is_empty() {
                lines.push(if tran.is_empty() {
                    head.to_string()
                } else {
                    format!("{head} — {tran}")
                });
            }
        }
    }
    if let Some(cols) = json
        .pointer("/individual/idiomatic")
        .and_then(|v| v.as_array())
    {
        for c in cols.iter().take(4) {
            let en = c
                .pointer("/colloc/en")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            let zh = c
                .pointer("/colloc/zh")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if !en.is_empty() {
                let line = if zh.is_empty() {
                    en.to_string()
                } else {
                    format!("{en} — {zh}")
                };
                if !lines.iter().any(|l| l.starts_with(en)) {
                    lines.push(line);
                }
            }
        }
    }
    if lines.is_empty() {
        None
    } else {
        Some(lines.join("\n"))
    }
}

fn youdao_synonyms(json: &serde_json::Value) -> Option<String> {
    let synos = json.pointer("/syno/synos")?.as_array()?;
    let mut lines = Vec::new();
    for s in synos.iter().take(4) {
        let pos = s
            .pointer("/syno/pos")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let ws = s
            .pointer("/syno/ws")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|w| w.get("w")?.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();
        if !ws.is_empty() {
            lines.push(format!("{pos} {ws}").trim().to_string());
        }
    }
    if lines.is_empty() {
        None
    } else {
        Some(lines.join("\n"))
    }
}

fn youdao_etymology(json: &serde_json::Value) -> Option<String> {
    if let Some(arr) = json.pointer("/etym/etyms/zh").and_then(|v| v.as_array()) {
        let text = arr
            .iter()
            .filter_map(|e| e.get("value")?.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if !text.is_empty() {
            return Some(text);
        }
    }
    None
}

/// Youdao only — CN-reachable, `no_proxy()` so Clash env is ignored.
#[tauri::command]
async fn lookup_word(word: String) -> Result<Option<DictHit>, String> {
    let Some(word) = clean_lookup_word(&word) else {
        return Ok(None);
    };

    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(8))
        .user_agent("Notepad/0.1")
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!(
        "https://dict.youdao.com/jsonapi?q={}",
        urlencoding_lite(&word)
    );
    let json: serde_json::Value = client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let meaning = youdao_meaning(&json);
    let example = youdao_example(&json);
    let forms = youdao_forms(&json);
    let phrases = youdao_phrases(&json);
    let synonyms = youdao_synonyms(&json);
    let etymology = youdao_etymology(&json);

    if meaning.is_none()
        && example.is_none()
        && forms.is_none()
        && phrases.is_none()
        && synonyms.is_none()
        && etymology.is_none()
    {
        return Ok(None);
    }
    Ok(Some(DictHit {
        meaning: meaning.unwrap_or_default(),
        example,
        forms,
        phrases,
        synonyms,
        etymology,
    }))
}

fn cursor_screen() -> Option<(i32, i32)> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::POINT;
        use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let mut pt = POINT { x: 0, y: 0 };
        unsafe {
            if GetCursorPos(&mut pt) == 0 {
                return None;
            }
        }
        Some((pt.x, pt.y))
    }
    #[cfg(not(windows))]
    {
        None
    }
}

fn point_in_rect(lx: f64, ly: f64, r: &HitRect) -> bool {
    lx >= r.x && ly >= r.y && lx <= r.x + r.w && ly <= r.y + r.h
}

/// Noty `hotZone`: right-edge strip of fanWidth+20, plus any open chrome.
fn over_hotzone(
    mode: &str,
    win_w_log: f64,
    win_h_log: f64,
    lx: f64,
    ly: f64,
    extras: &[HitRect],
) -> bool {
    if !(lx >= 0.0 && ly >= 0.0 && lx <= win_w_log && ly <= win_h_log) {
        // Outside the panel frame entirely.
        return false;
    }
    match mode {
        "rest" => true,
        "fan" | "expanded" => {
            let strip_w = FAN_W + HOT_PAD;
            let strip_x0 = (win_w_log - strip_w).max(0.0);
            if lx >= strip_x0 {
                return true;
            }
            extras.iter().any(|r| point_in_rect(lx, ly, r))
        }
        _ => true,
    }
}

fn start_hit_thread(window: WebviewWindow, hits: Arc<Mutex<DeckHit>>) {
    std::thread::spawn(move || {
        let mut ignored = false;
        let mut was_over = true;
        let mut away_ticks: u8 = 0;

        loop {
            std::thread::sleep(Duration::from_millis(16));
            let Ok(pos) = window.outer_position() else {
                continue;
            };
            let Ok(size) = window.outer_size() else {
                continue;
            };
            let Ok(scale) = window.scale_factor() else {
                continue;
            };
            let Some((cx, cy)) = cursor_screen() else {
                continue;
            };

            let win_w_log = size.width as f64 / scale;
            let win_h_log = size.height as f64 / scale;
            let lx = (cx - pos.x) as f64 / scale;
            let ly = (cy - pos.y) as f64 / scale;

            let in_window = cx >= pos.x
                && cy >= pos.y
                && cx < pos.x + size.width as i32
                && cy < pos.y + size.height as i32;

            let (mode, extras) = {
                let g = hits.lock();
                (g.mode.clone(), g.extras.clone())
            };

            // Mirror Noty: "over the deck" means the edge strip / extras,
            // not the entire wide panel.
            let over = if mode == "rest" {
                in_window
            } else if in_window {
                over_hotzone(&mode, win_w_log, win_h_log, lx, ly, &extras)
            } else {
                // Cursor left the HWND — still check strip in screen space so a
                // 1px gap at the monitor edge does not count as "away".
                false
            };

            // Empty panel chrome must click through (Noty hitTest → nil).
            let should_ignore = in_window && !over;
            if should_ignore != ignored {
                let _ = window.set_ignore_cursor_events(should_ignore);
                ignored = should_ignore;
            }

            // Fan collapses when the pointer leaves the strip (Noty idle poll).
            if mode == "fan" {
                if over {
                    away_ticks = 0;
                    was_over = true;
                } else if was_over || away_ticks > 0 {
                    away_ticks = away_ticks.saturating_add(1);
                    // ~150ms confirm, same as Noty pointerExited delay.
                    if away_ticks >= 10 {
                        was_over = false;
                        away_ticks = 0;
                        let _ = window.emit("deck-away", ());
                    }
                }
            } else {
                away_ticks = 0;
                was_over = over || mode == "rest";
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let hits = Arc::new(Mutex::new(DeckHit {
        mode: "rest".into(),
        extras: Vec::new(),
    }));
    let hit_state = HitState(hits.clone());

    tauri::Builder::default()
        .manage(hit_state)
        .invoke_handler(tauri::generate_handler![
            dock_edge,
            set_hit_regions,
            lookup_word,
            quit_app
        ])
        .setup(move |app| {
            setup_tray(app.handle())?;
            if let Some(window) = app.get_webview_window("main") {
                let _ = dock_window(&window, "rest", 5);
                start_hit_thread(window, hits);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}


