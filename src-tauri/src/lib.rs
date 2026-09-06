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
/// Rest strip fallback when pill hit-rect has not published yet.
const EDGE_W: f64 = 18.0;
/// Noty fanWidth (50) — interactive strip against the edge.
const FAN_W: f64 = 56.0;
/// Noty: hotZone ≈ fanWidth + 20; slightly roomier for hover.
const HOT_PAD: f64 = 10.0;

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
    /// Note/tab drag: keep HWND interactive so click-through can't steal moves.
    capture: bool,
}

struct HitState(Arc<Mutex<DeckHit>>);

fn dock_window(window: &WebviewWindow, mode: &str, _note_count: u32) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or_else(|| "no monitor".to_string())?;

    let work = monitor.work_area();
    let scale = monitor.scale_factor();

    // ALL modes share one HWND size (Noty fan↔expanded lesson).
    // Match work-area width AND height so free-drag isn't capped near mid-screen
    // (old fixed 720px width felt like an invisible left wall). Empty areas stay
    // click-through via the hit thread — only the right strip + chrome receive input.
    let _ = mode;
    let w_log = work.size.width as f64 / scale;
    let h_log = work.size.height as f64 / scale;
    let x = work.position.x;
    let y_phys = work.position.y;

    let width_phys = (w_log * scale).round() as u32;
    let height_phys = (h_log * scale).round() as u32;

    let same = window
        .outer_size()
        .ok()
        .zip(window.outer_position().ok())
        .is_some_and(|(sz, pos)| {
            sz.width == width_phys
                && sz.height == height_phys.max(1)
                && pos.x == x
                && pos.y == y_phys
        });
    if !same {
        window
            .set_size(PhysicalSize::new(width_phys, height_phys.max(1)))
            .map_err(|e| e.to_string())?;
        window
            .set_position(PhysicalPosition::new(x, y_phys))
            .map_err(|e| e.to_string())?;
        let _ = window.set_ignore_cursor_events(true);
    }
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
        // Extras (pill / preview / note) are owned by the frontend via set_hit_regions.
        // Clearing them here left a frame where rest fell back to the whole strip.
    }
    dock_window(&window, &mode, note_count.unwrap_or(5))
}

/// Extra interactive rects outside the edge strip (preview / note).
#[tauri::command]
fn set_hit_regions(regions: Vec<HitRect>, state: State<'_, HitState>) {
    state.0.lock().extras = regions;
}

/// While dragging chrome inside the panel, force the HWND to receive pointer events.
#[tauri::command]
fn set_input_capture(
    capture: bool,
    app: AppHandle,
    state: State<'_, HitState>,
) -> Result<(), String> {
    state.0.lock().capture = capture;
    if capture {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "main window missing".to_string())?;
        let _ = window.set_ignore_cursor_events(false);
    }
    Ok(())
}

#[tauri::command]
fn quit_app(_app: AppHandle) {
    // Hit-test thread is non-joinable; force exit so Quit really ends the process.
    std::process::exit(0);
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let quit = MenuItem::with_id(app, "quit", "退出 VocabDock", true, None::<&str>)?;
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
        .tooltip("VocabDock — 右键退出")
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
    if word.len() < 2 || word.len() > 64 {
        return None;
    }
    // Allow multi-word phrases: "public health", hyphens, apostrophes.
    if !word
        .chars()
        .all(|c| c.is_ascii_alphabetic() || c == '\'' || c == '-' || c == ' ')
    {
        return None;
    }
    let collapsed = word.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.len() < 2 {
        return None;
    }
    Some(collapsed)
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
        .user_agent("VocabDock/0.1")
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

/// English → Chinese via Bing Translator web API (no key).
#[tauri::command]
async fn translate_sentence(text: String) -> Result<Option<String>, String> {
    let text = text.trim();
    let chars = text.chars().count();
    if chars < 2 || chars > 500 {
        return Ok(None);
    }
    Ok(translate_bing(text).await)
}

fn translation_ok(src: &str, out: &str) -> bool {
    let t = out.trim();
    !t.is_empty() && !t.eq_ignore_ascii_case(src)
}

#[derive(Clone)]
struct BingSession {
    host: String,
    ig: String,
    iid: String,
    key: String,
    token: String,
    cookies: String,
    fetched_ms: u128,
}

static BING: Mutex<Option<BingSession>> = Mutex::new(None);

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn bing_ua() -> &'static str {
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0"
}

fn pick_re<'a>(body: &'a str, re: &str) -> Option<&'a str> {
    let start = body.find(re)?;
    let rest = &body[start + re.len()..];
    let end = rest.find('"')?;
    Some(&rest[..end])
}

fn pick_abuse(body: &str) -> Option<(String, String)> {
    let marker = "params_AbusePreventionHelper";
    let i = body.find(marker)?;
    let rest = &body[i..];
    let lb = rest.find('[')?;
    let rb = rest.find(']')?;
    let arr: serde_json::Value = serde_json::from_str(&rest[lb..=rb]).ok()?;
    let key = arr.get(0)?.to_string();
    let token = arr.get(1)?.as_str()?.to_string();
    if key.is_empty() || token.is_empty() {
        return None;
    }
    Some((key.trim_matches('"').to_string(), token))
}

fn cookie_header(res: &reqwest::Response) -> String {
    res.headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .map(|c| c.split(';').next().unwrap_or(c).trim())
        .filter(|c| !c.is_empty())
        .collect::<Vec<_>>()
        .join("; ")
}

async fn bing_refresh(client: &reqwest::Client) -> Option<BingSession> {
    let res = client
        .get("https://www.bing.com/translator")
        .header("User-Agent", bing_ua())
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    let cookies = cookie_header(&res);
    let final_url = res.url().clone();
    let body = res.text().await.ok()?;
    let host = final_url.host_str().unwrap_or("www.bing.com").to_string();
    let ig = pick_re(&body, "IG:\"")?.to_string();
    let iid = pick_re(&body, "data-iid=\"")?.to_string();
    let (key, token) = pick_abuse(&body)?;
    Some(BingSession {
        host,
        ig,
        iid,
        key,
        token,
        cookies,
        fetched_ms: now_ms(),
    })
}

async fn translate_bing(text: &str) -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::limited(8))
        .user_agent(bing_ua())
        .build()
        .ok()?;

    for attempt in 0..2u8 {
        let cached = {
            let mut slot = BING.lock();
            let stale = slot
                .as_ref()
                .map(|s| now_ms().saturating_sub(s.fetched_ms) > 25 * 60 * 1000)
                .unwrap_or(true);
            if attempt > 0 || stale {
                *slot = None;
            }
            slot.as_ref().cloned()
        };

        let session = if let Some(s) = cached {
            s
        } else {
            let fresh = bing_refresh(&client).await?;
            *BING.lock() = Some(fresh.clone());
            fresh
        };

        let url = format!(
            "https://{}/ttranslatev3?isVertical=1&IG={}&IID={}&SFX=1&ref=TThis&edgepdftranslator=1",
            session.host, session.ig, session.iid
        );
        let form = [
            ("fromLang", "en"),
            ("to", "zh-Hans"),
            ("text", text),
            ("token", session.token.as_str()),
            ("key", session.key.as_str()),
            ("tryFetchingGenderDebiasedTranslations", "true"),
        ];
        let mut req = client
            .post(&url)
            .header("User-Agent", bing_ua())
            .header("Referer", format!("https://{}/translator", session.host))
            .header("Content-Type", "application/x-www-form-urlencoded");
        if !session.cookies.is_empty() {
            req = req.header("Cookie", &session.cookies);
        }
        let res = req.form(&form).send().await.ok()?;
        if res.status().as_u16() == 401 {
            *BING.lock() = None;
            continue;
        }
        let json: serde_json::Value = res.error_for_status().ok()?.json().await.ok()?;
        let t = json
            .pointer("/0/translations/0/text")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| translation_ok(text, s))?;
        return Some(t.to_string());
    }
    None
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
        return false;
    }
    match mode {
        // Rest HWND is a full-height hairline — whole strip is the hot zone.
        "rest" => true,
        "fan" | "expanded" => {
            let strip_w = FAN_W + HOT_PAD;
            let strip_x0 = (win_w_log - strip_w).max(0.0);
            if lx >= strip_x0 {
                return true;
            }
            // Only real chrome (note / preview / pill) — empty dock stays click-through.
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
        // Debounce ignore toggles — WebView2 flashes a dark edge if we flip every frame.
        let mut ignore_stable: u8 = 0;
        let mut pending_ignore = false;

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

            let (mode, extras, capture) = {
                let g = hits.lock();
                (g.mode.clone(), g.extras.clone(), g.capture)
            };

            let over = if capture {
                // Drag in progress — whole docked panel must stay live.
                in_window
            } else if mode == "rest" {
                // Rest: ONLY the pill / edge strip is hot — never the whole work area.
                if !in_window {
                    false
                } else if extras.is_empty() {
                    lx >= (win_w_log - EDGE_W).max(0.0)
                } else {
                    extras.iter().any(|r| point_in_rect(lx, ly, r))
                }
            } else if in_window {
                over_hotzone(&mode, win_w_log, win_h_log, lx, ly, &extras)
            } else {
                false
            };

            let should_ignore = in_window && !over;
            if should_ignore == pending_ignore {
                ignore_stable = ignore_stable.saturating_add(1);
            } else {
                pending_ignore = should_ignore;
                ignore_stable = 1;
            }
            // Click-through on quickly (1 frame); taking input stays debounced to avoid edge flash.
            let need = if should_ignore { 1 } else { 3 };
            if should_ignore != ignored && ignore_stable >= need {
                let _ = window.set_ignore_cursor_events(should_ignore);
                ignored = should_ignore;
            }

            if mode == "fan" {
                if over {
                    away_ticks = 0;
                    was_over = true;
                } else if was_over || away_ticks > 0 {
                    away_ticks = away_ticks.saturating_add(1);
                    if away_ticks >= 5 {
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
    // WebView2: transparent clear color (AARRGGBB). Without this, empty panel
    // chrome paints as an opaque black/grey strip — worst on hover toggles.
    #[cfg(windows)]
    {
        std::env::set_var("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "00FFFFFF");
    }

    let hits = Arc::new(Mutex::new(DeckHit {
        mode: "rest".into(),
        extras: Vec::new(),
        capture: false,
    }));
    let hit_state = HitState(hits.clone());

    tauri::Builder::default()
        .manage(hit_state)
        .invoke_handler(tauri::generate_handler![
            dock_edge,
            set_hit_regions,
            set_input_capture,
            lookup_word,
            translate_sentence,
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


