// Apple Music control.
//
// Two Windows surfaces, used for different things, because neither is enough:
//
//   SMTC (Windows.Media.Control) — the system media transport. Apple Music
//     registers a session, so play/pause/next/previous and the current track
//     are available through a documented API that does not care how the app
//     draws itself. Everything frequent goes here.
//
//   UI Automation — the only place Apple Music exposes its playlists and its
//     shuffle state. There is no COM automation surface (the packaged
//     AMP.Core.IAMPMusicLibrary class has no TypeLib, no ProgID, and cannot be
//     created from outside the package), no command-line interface, and no
//     keyboard shortcut for shuffle. Measured on the app 2026-09-20: the
//     controls carry stable English AutomationIds even in a Japanese UI, and
//     they stay reachable — and invokable — while the window is minimized, so
//     nothing has to be brought to the foreground.
//
// This runs on its own thread. A UI Automation call is a cross-process call
// into an app that may be busy and can block for seconds; the audio thread is a
// single serialized queue, so putting these two together would stall the volume
// mixer behind a hung music app.

use std::cell::RefCell;
use std::process::Command;
use std::time::{Duration, Instant};

use crossbeam_channel::Receiver;
use serde::Serialize;
use tokio::sync::oneshot;

use windows::core::Interface;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession, GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationInvokePattern,
    IUIAutomationSelectionItemPattern, IUIAutomationTogglePattern, ToggleState_On,
    TreeScope_Children, TreeScope_Descendants, UIA_InvokePatternId, UIA_PATTERN_ID, UIA_SelectionItemPatternId,
    UIA_TogglePatternId,
};

/// Apple Music's package identity. SMTC reports this as the session's source,
/// which is how we control Apple Music specifically rather than "whatever owns
/// the media keys" — on this machine a browser playing video is routinely the
/// current session, so an untargeted command would hit the wrong app.
const APPLE_MUSIC_AUMID: &str = "AppleInc.AppleMusicWin_nzyj5cx40ttqa!App";

/// The window title Apple Music uses (it is not localized).
const APPLE_MUSIC_WINDOW: &str = "Apple Music";

/// Registered as an app execution alias by the package, so it launches from a
/// plain command line without going through the shell.
const APPLE_MUSIC_EXE: &str = "AppleMusic.exe";

/// AutomationIds of the controls we drive. English, and stable across the UI
/// language. If Apple renames these, every command fails loudly rather than
/// doing something unintended — see the error paths below.
const AID_SIDEBAR_SCROLLER: &str = "MenuItemsScrollViewer";
const AID_SHUFFLE: &str = "ShuffleButton";
const AID_PLAY: &str = "PlayButton";

/// Marks a sidebar entry as a playlist rather than an artist or album. The rest
/// of the id is Apple's library database id, which survives a rename — so a key
/// keeps pointing at the same playlist even if it is renamed.
const PLAYLIST_KIND: &str = "IKIND:ePlaylist";

/// How long to wait for the app window after launching it.
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(20);
/// How long to wait for the sidebar selection to take effect before giving up.
const NAVIGATE_TIMEOUT: Duration = Duration::from_secs(6);
/// How long to wait for the transport to actually report playback after the
/// page button is pressed.
const PLAYBACK_CONFIRM_TIMEOUT: Duration = Duration::from_secs(6);
/// How long to wait for the sidebar to be populated with the user's library.
const LIBRARY_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    /// The sidebar AutomationId. Stable across renames; this is what a key saves.
    pub id: String,
    pub name: String,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaStatus {
    /// Whether Apple Music is running at all.
    pub running: bool,
    /// Whether it currently has an SMTC session (it may be starting up).
    pub connected: bool,
    pub playing: bool,
    pub paused: bool,
    pub title: String,
    pub artist: String,
}

pub enum MediaCmd {
    ListPlaylists(oneshot::Sender<Result<Vec<Playlist>, String>>),
    /// Start a playlist. `shuffle` decides which of the page's two buttons is
    /// pressed, so the order is set by the same action that starts playback —
    /// there is no window in which the first track plays unshuffled.
    PlayPlaylist {
        id: String,
        name: String,
        shuffle: bool,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Resume(oneshot::Sender<Result<(), String>>),
    Pause(oneshot::Sender<Result<(), String>>),
    Status(oneshot::Sender<MediaStatus>),
    Launch(oneshot::Sender<Result<(), String>>),
}

pub fn run_media_thread(rx: Receiver<MediaCmd>) {
    unsafe {
        // Multithreaded apartment: this thread makes cross-process UI Automation
        // calls and WinRT calls, and owns no windows of its own.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }

    while let Ok(cmd) = rx.recv() {
        match cmd {
            MediaCmd::ListPlaylists(reply) => {
                let _ = reply.send(list_playlists());
            }
            MediaCmd::PlayPlaylist {
                id,
                name,
                shuffle,
                reply,
            } => {
                let _ = reply.send(play_playlist(&id, &name, shuffle));
            }
            MediaCmd::Resume(reply) => {
                let _ = reply.send(transport(Transport::Play));
            }
            MediaCmd::Pause(reply) => {
                let _ = reply.send(transport(Transport::Pause));
            }
            MediaCmd::Status(reply) => {
                let _ = reply.send(status());
            }
            MediaCmd::Launch(reply) => {
                let _ = reply.send(ensure_running().map(|_| ()));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// SMTC: transport and now-playing
// ---------------------------------------------------------------------------

enum Transport {
    Play,
    Pause,
}

/// How long to wait before building another manager once one has been dropped.
///
/// Building one is the expensive act this cache exists to avoid, and a failure
/// that persists would otherwise restore the original behaviour exactly: a new
/// manager — and a new registration inside NPSMSvc — every two seconds. Going
/// without one for a few seconds only makes status() report "not running",
/// which is what it would report anyway while the manager is unusable.
const MANAGER_RETRY_DELAY: Duration = Duration::from_secs(10);

/// The SMTC session manager and when it was last built.
struct ManagerCache {
    manager: Option<GlobalSystemMediaTransportControlsSessionManager>,
    /// Set on every build attempt, successful or not, so a failing one is not
    /// retried on the next poll.
    last_build: Option<Instant>,
}

thread_local! {
    /// The SMTC session manager for this thread. Built on first use, and again
    /// only after a call against it fails.
    ///
    /// RequestAsync() is not a getter: every call hands back a *new* manager,
    /// and each one registers as a client of NPSMSvc (the "Now Playing Session
    /// Manager" service). Building one per poll measured at 196ms of NPSMSvc
    /// CPU per call, on an idle machine with Apple Music closed — against 0.3ms
    /// for a whole audio command — and the service held on to the
    /// registrations, so an 11-hour run left it at ~480 threads and eight
    /// cores' worth of CPU (2026-09-21). The manager is a live object that
    /// tracks sessions itself, so keeping one and re-reading GetSessions()
    /// answers the same question for nothing.
    ///
    /// Deliberately no TTL, unlike the audio thread's endpoint cache: there the
    /// re-resolve is cheap and guards against a device changing underneath it,
    /// here the rebuild *is* the cost being removed, and it buys nothing — the
    /// manager follows sessions coming and going on its own (Apple Music closed
    /// and reopened is picked up in 3s, measured). Adding one to match audio.rs
    /// would put back a share of the storm for no gain.
    static SMTC_MANAGER: RefCell<ManagerCache> = const {
        RefCell::new(ManagerCache {
            manager: None,
            last_build: None,
        })
    };
}

/// Forces the next call to build a fresh manager, after MANAGER_RETRY_DELAY.
///
/// Called whenever a call against the cached manager fails. Whether that is
/// enough to notice a manager left behind by a restarted NPSMSvc is *not*
/// established: it depends on whether the WinRT wrapper asks the service on
/// every GetSessions() or answers from its own copy, and restarting the service
/// to find out needs rights this build has not been run with. So the failure
/// paths below are deliberately wider than the one that has been observed —
/// anything the manager or its sessions refuse to answer drops it.
fn drop_session_manager() {
    SMTC_MANAGER.with(|cell| cell.borrow_mut().manager = None);
}

fn session_manager() -> Option<GlobalSystemMediaTransportControlsSessionManager> {
    SMTC_MANAGER.with(|cell| {
        {
            let cached = cell.borrow();
            if let Some(existing) = cached.manager.as_ref() {
                return Some(existing.clone());
            }
            if let Some(at) = cached.last_build {
                if at.elapsed() < MANAGER_RETRY_DELAY {
                    return None;
                }
            }
        }
        let built = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
            .ok()
            .and_then(|op| op.get().ok());
        let mut cached = cell.borrow_mut();
        cached.last_build = Some(Instant::now());
        cached.manager = built.clone();
        built
    })
}

/// The Apple Music SMTC session, or None when the app is not running / has not
/// registered one yet.
fn apple_music_session() -> Option<GlobalSystemMediaTransportControlsSession> {
    let manager = session_manager()?;
    let sessions = match manager.GetSessions() {
        Ok(sessions) => sessions,
        Err(_) => {
            drop_session_manager();
            return None;
        }
    };
    for session in sessions {
        if let Ok(source) = session.SourceAppUserModelId() {
            if source.to_string() == APPLE_MUSIC_AUMID {
                return Some(session);
            }
        }
    }
    None
}

fn status() -> MediaStatus {
    // Deliberately no UI Automation here. This is polled while a playlist key
    // is on screen, and asking UI Automation whether the window exists meant
    // building a client and enumerating every top-level window on the desktop
    // every time — measured at ~340ms a call. An SMTC session only exists while
    // Apple Music is running, so its presence answers the same question for
    // free. A press still calls ensure_running(), which checks properly and
    // launches the app if it really is closed.
    let Some(session) = apple_music_session() else {
        return MediaStatus::default();
    };

    let mut out = MediaStatus {
        running: true,
        connected: true,
        ..Default::default()
    };

    match session.GetPlaybackInfo() {
        Ok(info) => {
            if let Ok(playback) = info.PlaybackStatus() {
                out.playing = playback == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing;
                out.paused = playback == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Paused;
            }
        }
        // A session that will not say whether it is playing came from a manager
        // that is no longer good for anything. This is the cheapest place that
        // notices, since it runs on every poll.
        Err(_) => drop_session_manager(),
    }

    if let Ok(props) = session.TryGetMediaPropertiesAsync().and_then(|op| op.get()) {
        out.title = props.Title().map(|t| t.to_string()).unwrap_or_default();
        out.artist = props.Artist().map(|a| a.to_string()).unwrap_or_default();
    }

    out
}

fn transport(action: Transport) -> Result<(), String> {
    let session = apple_music_session().ok_or("Apple Music has no media session (is it running?)")?;
    let ok = match action {
        Transport::Play => session.TryPlayAsync().and_then(|op| op.get()),
        Transport::Pause => session.TryPauseAsync().and_then(|op| op.get()),
    }
    .map_err(|e| {
        // Same reasoning as status(): the session answered nothing, so the
        // manager it came from is suspect.
        drop_session_manager();
        format!("media transport call failed: {e}")
    })?;
    if ok {
        Ok(())
    } else {
        Err("Apple Music refused the transport command".into())
    }
}

// ---------------------------------------------------------------------------
// Process
// ---------------------------------------------------------------------------

/// Returns once Apple Music has a window, launching it if necessary.
fn ensure_running() -> Result<IUIAutomationElement, String> {
    let ui = automation()?;
    if let Some(win) = find_window(&ui)? {
        return Ok(win);
    }

    Command::new(APPLE_MUSIC_EXE)
        .spawn()
        .map_err(|e| format!("could not launch {APPLE_MUSIC_EXE}: {e}"))?;

    let deadline = Instant::now() + LAUNCH_TIMEOUT;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(400));
        if let Some(win) = find_window(&ui)? {
            return Ok(win);
        }
    }
    Err("Apple Music did not open a window in time".into())
}

/// Waits until the sidebar actually lists playlists.
///
/// A freshly launched Apple Music shows its window and its fixed sidebar
/// headings within a second or two, but the library itself arrives separately
/// from Apple's background agent, and until it does there are no playlists to
/// select — the app sits on a "取り込み中" spinner. A fixed sleep after launch
/// was not enough and turned a slow start into "playlist not in the sidebar".
///
/// This also surfaces the case where that agent is wedged: it had burned seven
/// minutes of CPU while the app waited forever (2026-09-20), and no amount of
/// waiting here would have helped. Saying so is more useful than timing out
/// with a message about the playlist.
fn wait_for_library(ui: &IUIAutomation, win: &IUIAutomationElement) -> Result<(), String> {
    let deadline = Instant::now() + LIBRARY_TIMEOUT;
    loop {
        if !scan(ui, win)?.playlists.is_empty() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(
                "Apple Music is still loading its library and lists no playlists. If it stays like \
                 this, its library agent (AMPLibraryAgent.exe) is stuck — ending that process makes \
                 it restart."
                    .into(),
            );
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

// ---------------------------------------------------------------------------
// UI Automation
// ---------------------------------------------------------------------------

thread_local! {
    /// The UI Automation client, built once for this thread. Creating one is a
    /// COM activation; doing it per call showed up as most of the cost of a
    /// status poll.
    static UI_AUTOMATION: RefCell<Option<IUIAutomation>> = const { RefCell::new(None) };
}

fn automation() -> Result<IUIAutomation, String> {
    UI_AUTOMATION.with(|cell| {
        if let Some(existing) = cell.borrow().as_ref() {
            return Ok(existing.clone());
        }
        let created: IUIAutomation = unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_ALL) }
            .map_err(|e| format!("could not create the UI Automation client: {e}"))?;
        *cell.borrow_mut() = Some(created.clone());
        Ok(created)
    })
}

fn find_window(ui: &IUIAutomation) -> Result<Option<IUIAutomationElement>, String> {
    let root = unsafe { ui.GetRootElement() }.map_err(|e| format!("no desktop root: {e}"))?;
    let cond = unsafe { ui.CreateTrueCondition() }.map_err(|e| format!("condition: {e}"))?;
    let windows = unsafe { root.FindAll(TreeScope_Children, &cond) }
        .map_err(|e| format!("enumerating top-level windows: {e}"))?;
    let count = unsafe { windows.Length() }.unwrap_or(0);
    for i in 0..count {
        let Ok(win) = (unsafe { windows.GetElement(i) }) else {
            continue;
        };
        let name = unsafe { win.CurrentName() }
            .map(|n| n.to_string())
            .unwrap_or_default();
        if name == APPLE_MUSIC_WINDOW {
            return Ok(Some(win));
        }
    }
    Ok(None)
}

/// One pass over the window's element tree.
///
/// Every lookup here is a cross-process call, so the tree is walked once and
/// everything of interest is picked out of that single pass rather than running
/// a separate search per control.
struct Scan {
    playlists: Vec<(String, String, IUIAutomationElement)>,
    /// The transport bar's shuffle control. Carries a Toggle pattern, so its
    /// current state is readable — shuffle is never flipped blind.
    shuffle_toggle: Option<IUIAutomationElement>,
    /// The big "Shuffle" button on a playlist page: one press starts that
    /// playlist shuffled.
    page_shuffle: Option<IUIAutomationElement>,
    /// The big "Play" button on a playlist page: starts it in order.
    page_play: Option<IUIAutomationElement>,
}

fn scan(ui: &IUIAutomation, win: &IUIAutomationElement) -> Result<Scan, String> {
    let cond = unsafe { ui.CreateTrueCondition() }.map_err(|e| format!("condition: {e}"))?;
    let all = unsafe { win.FindAll(TreeScope_Descendants, &cond) }
        .map_err(|e| format!("reading the Apple Music window: {e}"))?;
    let count = unsafe { all.Length() }.unwrap_or(0);

    let mut out = Scan {
        playlists: Vec::new(),
        shuffle_toggle: None,
        page_shuffle: None,
        page_play: None,
    };

    for i in 0..count {
        let Ok(el) = (unsafe { all.GetElement(i) }) else {
            continue;
        };
        let aid = unsafe { el.CurrentAutomationId() }
            .map(|s| s.to_string())
            .unwrap_or_default();
        if aid.is_empty() {
            continue;
        }

        if aid.contains(PLAYLIST_KIND) {
            let name = unsafe { el.CurrentName() }
                .map(|s| s.to_string())
                .unwrap_or_default();
            if !name.is_empty() && !out.playlists.iter().any(|(id, _, _)| id == &aid) {
                out.playlists.push((aid, name, el));
            }
            continue;
        }

        if aid == AID_SHUFFLE {
            // Two controls share this id. The transport bar's is a toggle (it
            // reports whether shuffle is on); the one on a playlist page is a
            // plain button that starts that playlist shuffled. Tell them apart
            // by which pattern they support, not by size or position.
            if get_pattern::<IUIAutomationTogglePattern>(&el, UIA_TogglePatternId).is_some() {
                out.shuffle_toggle = Some(el);
            } else if get_pattern::<IUIAutomationInvokePattern>(&el, UIA_InvokePatternId).is_some() {
                out.page_shuffle = Some(el);
            }
            continue;
        }

        if aid == AID_PLAY {
            out.page_play = Some(el);
        }
    }

    Ok(out)
}

fn get_pattern<T: Interface>(el: &IUIAutomationElement, pattern_id: UIA_PATTERN_ID) -> Option<T> {
    unsafe { el.GetCurrentPatternAs::<T>(pattern_id) }.ok()
}

fn list_playlists() -> Result<Vec<Playlist>, String> {
    let ui = automation()?;
    let win = find_window(&ui)?.ok_or("Apple Music is not running")?;
    // Touching the sidebar scroller first makes sure it has been realized; an
    // app that has never shown the sidebar reports no playlists at all.
    let scanned = scan(&ui, &win)?;
    let mut playlists: Vec<Playlist> = scanned
        .playlists
        .into_iter()
        .map(|(id, name, _)| Playlist { id, name })
        .collect();
    playlists.sort_by(|a, b| a.name.cmp(&b.name));
    if playlists.is_empty() {
        return Err(format!(
            "no playlists found in the Apple Music sidebar (looked for entries tagged {PLAYLIST_KIND} under {AID_SIDEBAR_SCROLLER})"
        ));
    }
    Ok(playlists)
}

fn play_playlist(id: &str, name: &str, shuffle: bool) -> Result<(), String> {
    let ui = automation()?;
    let win = ensure_running()?;
    wait_for_library(&ui, &win)?;

    let scanned = scan(&ui, &win)?;

    // Match on the saved library id first; fall back to the name so a key still
    // works if Apple ever reissues the ids. Matching on the id alone would fail
    // silently-ish, and matching on the name alone would start the wrong
    // playlist after a rename.
    let target = scanned
        .playlists
        .iter()
        .find(|(pid, _, _)| pid == id)
        .or_else(|| scanned.playlists.iter().find(|(_, pname, _)| pname == name))
        .ok_or_else(|| format!("playlist \"{name}\" is not in the Apple Music sidebar"))?;

    let other_id = scanned
        .playlists
        .iter()
        .map(|(pid, _, _)| pid.clone())
        .find(|pid| pid != &target.0);

    let page = open_playlist_page(&ui, &win, &target.0, name, other_id.as_deref())?;

    if shuffle {
        let button = page
            .page_shuffle
            .ok_or("the playlist page has no Shuffle button")?;
        invoke(&button, "Shuffle")?;
    } else {
        // Turn shuffle off *before* starting, so the playlist begins in order
        // rather than being reordered for the first track.
        if let Some(toggle_el) = page.shuffle_toggle {
            if let Some(toggle) = get_pattern::<IUIAutomationTogglePattern>(&toggle_el, UIA_TogglePatternId) {
                if let Ok(state) = unsafe { toggle.CurrentToggleState() } {
                    if state == ToggleState_On {
                        let _ = unsafe { toggle.Toggle() };
                        std::thread::sleep(Duration::from_millis(200));
                    }
                }
            }
        }
        let button = page.page_play.ok_or("the playlist page has no Play button")?;
        invoke(&button, "Play")?;
    }

    // Pressing the button is not the same as music playing. Invoke() reports
    // that the click was delivered, nothing more — and Apple Music will accept
    // and ignore one when its page is not really in front. Reporting success on
    // the click alone is what made a key look like it worked while the app sat
    // silent, so the result is confirmed against the transport instead.
    wait_for_playing(PLAYBACK_CONFIRM_TIMEOUT)
        .map_err(|e| format!("started \"{name}\" but {e}"))
}

/// Brings the content pane to `id`'s playlist page and returns a scan of it.
///
/// Selecting a sidebar entry that is *already* selected does nothing at all, and
/// Apple Music can sit with the sidebar pointing at one playlist while the
/// content pane shows something else entirely — seen after the app restarts and
/// restores its selection without restoring the page. In that state the page's
/// Play and Shuffle buttons do not exist, so there is nothing to press.
///
/// So the page is confirmed by the presence of those buttons, not by the
/// sidebar's own `IsSelected` (which answers instantly and says nothing about
/// what is drawn). If they are missing, the selection is bounced off another
/// entry to force a real navigation, and the target is selected again.
fn open_playlist_page(
    ui: &IUIAutomation,
    win: &IUIAutomationElement,
    id: &str,
    name: &str,
    fallback_id: Option<&str>,
) -> Result<Scan, String> {
    for attempt in 0..2 {
        if attempt == 1 {
            // Second try: visit a different playlist first so that selecting the
            // target is a real change rather than a no-op.
            let Some(other) = fallback_id else { break };
            select_playlist(ui, win, other)?;
            std::thread::sleep(Duration::from_millis(700));
        }

        select_playlist(ui, win, id)?;

        let deadline = Instant::now() + NAVIGATE_TIMEOUT;
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(200));
            let page = scan(ui, win)?;
            if page.page_shuffle.is_some() && page.page_play.is_some() {
                return Ok(page);
            }
        }
    }

    Err(format!(
        "Apple Music would not open the page for \"{name}\" (its Play and Shuffle buttons never appeared)"
    ))
}

fn select_playlist(ui: &IUIAutomation, win: &IUIAutomationElement, id: &str) -> Result<(), String> {
    let scanned = scan(ui, win)?;
    let entry = scanned
        .playlists
        .iter()
        .find(|(pid, _, _)| pid == id)
        .ok_or("the playlist disappeared from the sidebar")?;
    let select = get_pattern::<IUIAutomationSelectionItemPattern>(&entry.2, UIA_SelectionItemPatternId)
        .ok_or("that sidebar entry cannot be selected")?;
    unsafe { select.Select() }.map_err(|e| format!("selecting the playlist failed: {e}"))
}

/// Waits for the transport to actually report playback.
fn wait_for_playing(timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let mut last = String::from("no media session");
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(250));
        if let Some(session) = apple_music_session() {
            match session.GetPlaybackInfo().and_then(|i| i.PlaybackStatus()) {
                Ok(GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing) => return Ok(()),
                Ok(other) => last = format!("Apple Music reports {other:?}"),
                Err(e) => last = format!("could not read the transport: {e}"),
            }
        }
    }
    Err(format!("playback did not start ({last})"))
}

fn invoke(el: &IUIAutomationElement, label: &str) -> Result<(), String> {
    let pattern = get_pattern::<IUIAutomationInvokePattern>(el, UIA_InvokePatternId)
        .ok_or_else(|| format!("the {label} button cannot be pressed"))?;
    unsafe { pattern.Invoke() }.map_err(|e| format!("pressing {label} failed: {e}"))
}
