// Core Audio (WASAPI) engine. All COM work happens on one dedicated thread; the
// async WebSocket layer talks to it over a crossbeam command channel and gets
// replies back over tokio oneshots. COM objects are neither Send nor Sync, so
// they never leave this thread.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crossbeam_channel::Receiver;
use serde::Serialize;
use tokio::sync::oneshot;

use windows::core::{Interface, PCWSTR, PWSTR};
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Foundation::{CloseHandle, BOOL, HANDLE};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{
    eConsole, eRender, AudioSessionStateActive, IAudioSessionControl, IAudioSessionControl2,
    IAudioSessionManager2, IMMDevice, IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::SHLoadIndirectString;

/// Synthetic ids start high so they never collide with a real OS pid the plugin
/// might special-case (it treats pid 0 as the system-default target).
const FIRST_SYNTHETIC_ID: u32 = 1000;

/// A session that just briefly made sound stays "visible" (activity 2) for this
/// long after it goes inactive, so a short blip doesn't vanish from its slot the
/// instant the sound stops.
const RECENT_GRACE: Duration = Duration::from_secs(60);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInstance {
    /// A stable synthetic id (NOT the OS pid) unique per audio session, so two
    /// sessions sharing one process (e.g. the SPDIF and AG03 monitors both under
    /// svchost) stay independently addressable.
    #[serde(rename = "processID")]
    pub process_id: u32,
    pub display_name: String,
    pub executable_file: String,
    pub executable_path: String,
    pub mute: bool,
    pub volume: f32,
    pub activity: u8,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    #[serde(rename = "deviceID")]
    pub device_id: String,
    pub friendly_name: String,
    pub mute: bool,
    pub volume: f32,
}

/// Commands sent from the async server to the audio thread. Setters are
/// fire-and-forget (the plugin does not await them); getters carry a oneshot.
pub enum Cmd {
    GetDefaultDevice(oneshot::Sender<Option<DeviceInfo>>),
    SetDefaultVolume(f32),
    SetDefaultMute(bool),
    GetSessions(oneshot::Sender<Vec<AppInstance>>),
    SetSessionVolume(u32, f32),
    SetSessionMute(u32, bool),
}

pub fn run_audio_thread(rx: Receiver<Cmd>) {
    unsafe {
        // Ignore RPC_E_CHANGED_MODE etc — a failure here just means COM was
        // already initialised on this thread, which is fine.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }

    let mut engine = match Engine::new() {
        Some(e) => e,
        None => {
            eprintln!("failed to create IMMDeviceEnumerator");
            return;
        }
    };

    while let Ok(cmd) = rx.recv() {
        match cmd {
            Cmd::GetDefaultDevice(reply) => {
                let _ = reply.send(engine.default_device_info());
            }
            Cmd::SetDefaultVolume(v) => engine.set_default_volume(v),
            Cmd::SetDefaultMute(m) => engine.set_default_mute(m),
            Cmd::GetSessions(reply) => {
                let _ = reply.send(engine.sessions());
            }
            Cmd::SetSessionVolume(id, v) => engine.set_session_volume(id, v),
            Cmd::SetSessionMute(id, m) => engine.set_session_mute(id, m),
        }
    }
}

/// How long a resolved endpoint may be reused before it is looked up again.
///
/// Every command used to re-run GetDefaultAudioEndpoint and re-Activate the
/// session manager (or the endpoint volume) from scratch. Measured on an idle
/// machine, that fixed setup — not the per-session work — was what each command
/// cost: reading 9 sessions took 8.6ms, and so did setting one volume, which
/// touches almost no session data. A held volume key issues roughly eight
/// commands a second, so this is the cost that matters.
///
/// The window is the staleness budget: if the user switches their default output
/// device, commands keep going to the previous one for at most this long.
const ENDPOINT_TTL: Duration = Duration::from_millis(1000);

/// The default output endpoint and everything derived from it that cannot
/// change while it remains the default.
struct CachedEndpoint {
    // The device itself is not retained: `manager` and `endpoint_volume` were
    // activated from it and hold their own references to what they need.
    manager: IAudioSessionManager2,
    endpoint_volume: IAudioEndpointVolume,
    device_id: String,
    friendly_name: String,
    at: Instant,
}

struct Engine {
    enumerator: IMMDeviceEnumerator,
    instance_to_id: HashMap<String, u32>,
    id_to_instance: HashMap<u32, String>,
    next_id: u32,
    /// Instance id -> the last time we saw that session Active. Drives the
    /// recently-active grace window.
    last_active: HashMap<String, Instant>,
    endpoint: Option<CachedEndpoint>,
    /// Instance id -> the owning process's image path.
    ///
    /// Reading it means opening a handle on another process
    /// (OpenProcess + QueryFullProcessImageNameW) and the answer cannot change
    /// for the life of a session, yet it was re-read for every session on every
    /// enumeration — several times a second. It is also the one call here that
    /// reaches into a *game's* process, which is both the slowest case and the
    /// one most likely to be interfered with, so not making it is worth more
    /// than the microseconds suggest. Keyed by the session instance identifier,
    /// not the pid, because pids are recycled and instance identifiers are not.
    process_image: HashMap<String, String>,
    /// Resolved "@dll,-123" indirect display strings. Resolving one loads a
    /// resource out of a DLL through the shell; the result is a pure function of
    /// the input, so it is worth remembering across enumerations.
    indirect_names: HashMap<String, String>,
}

impl Engine {
    fn new() -> Option<Self> {
        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.ok()?;
        Some(Self {
            enumerator,
            instance_to_id: HashMap::new(),
            id_to_instance: HashMap::new(),
            next_id: FIRST_SYNTHETIC_ID,
            last_active: HashMap::new(),
            endpoint: None,
            process_image: HashMap::new(),
            indirect_names: HashMap::new(),
        })
    }

    fn id_for(&mut self, instance: &str) -> u32 {
        if let Some(id) = self.instance_to_id.get(instance) {
            return *id;
        }
        let id = self.next_id;
        self.next_id += 1;
        self.instance_to_id.insert(instance.to_string(), id);
        self.id_to_instance.insert(id, instance.to_string());
        id
    }

    /// Resolves the default endpoint, reusing the previous result for up to
    /// ENDPOINT_TTL. Returns None if there is no default output device.
    fn endpoint(&mut self) -> Option<&CachedEndpoint> {
        let fresh = self
            .endpoint
            .as_ref()
            .is_some_and(|cached| cached.at.elapsed() < ENDPOINT_TTL);
        if fresh {
            return self.endpoint.as_ref();
        }

        self.endpoint = None;
        let device = unsafe { self.enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }.ok()?;
        let manager: IAudioSessionManager2 = unsafe { device.Activate(CLSCTX_ALL, None) }.ok()?;
        let endpoint_volume: IAudioEndpointVolume = unsafe { device.Activate(CLSCTX_ALL, None) }.ok()?;
        // The id and the friendly name are fixed for as long as this device is
        // the default, so they are resolved once per cache fill rather than on
        // every getSystemDefaultDevice.
        let device_id = take_pwstr_result(unsafe { device.GetId() });
        let friendly_name = unsafe { friendly_name(&device) };
        self.endpoint = Some(CachedEndpoint {
            manager,
            endpoint_volume,
            device_id,
            friendly_name,
            at: Instant::now(),
        });
        self.endpoint.as_ref()
    }

    /// Forces the next command to resolve the endpoint again. Called whenever a
    /// cached interface returns an error, which is how a device that went away
    /// (unplugged, disabled, or replaced as the default) gets noticed before the
    /// TTL would have expired.
    fn drop_endpoint(&mut self) {
        self.endpoint = None;
    }

    fn default_device_info(&mut self) -> Option<DeviceInfo> {
        let cached = self.endpoint()?;
        let device_id = cached.device_id.clone();
        let friendly_name = cached.friendly_name.clone();
        let volume = unsafe { cached.endpoint_volume.GetMasterVolumeLevelScalar() };
        let mute = unsafe { cached.endpoint_volume.GetMute() };
        match (volume, mute) {
            (Ok(volume), Ok(mute)) => Some(DeviceInfo {
                device_id,
                friendly_name,
                mute: mute.as_bool(),
                volume,
            }),
            _ => {
                // The cached endpoint is no longer usable — drop it so the next
                // call resolves a live one instead of failing again.
                self.drop_endpoint();
                None
            }
        }
    }

    fn set_default_volume(&mut self, v: f32) {
        let Some(cached) = self.endpoint() else {
            return;
        };
        let result = unsafe {
            cached
                .endpoint_volume
                .SetMasterVolumeLevelScalar(v.clamp(0.0, 1.0), std::ptr::null())
        };
        if result.is_err() {
            self.drop_endpoint();
        }
    }

    fn set_default_mute(&mut self, m: bool) {
        let Some(cached) = self.endpoint() else {
            return;
        };
        let result = unsafe { cached.endpoint_volume.SetMute(BOOL::from(m), std::ptr::null()) };
        if result.is_err() {
            self.drop_endpoint();
        }
    }

    fn sessions(&mut self) -> Vec<AppInstance> {
        let mut out = Vec::new();
        let mut seen: Vec<String> = Vec::new();
        let Some(cached) = self.endpoint() else {
            return out;
        };
        let mgr = cached.manager.clone();
        unsafe {
            let Ok(en) = mgr.GetSessionEnumerator() else {
                // A session manager that will not enumerate belongs to a device
                // that is gone; resolve a fresh one next time.
                self.drop_endpoint();
                return out;
            };
            let count = en.GetCount().unwrap_or(0);
            for i in 0..count {
                let Ok(ctl) = en.GetSession(i) else { continue };
                let Ok(ctl2) = ctl.cast::<IAudioSessionControl2>() else {
                    continue;
                };
                let instance = take_pwstr_result(ctl2.GetSessionInstanceIdentifier());
                if instance.is_empty() {
                    continue;
                }
                seen.push(instance.clone());
                let id = self.id_for(&instance);
                let exe_full = match self.process_image.get(&instance) {
                    Some(path) => path.clone(),
                    None => {
                        let pid = ctl2.GetProcessId().unwrap_or(0);
                        let path = process_image(pid);
                        self.process_image.insert(instance.clone(), path.clone());
                        path
                    }
                };
                // Read live: unlike the image path, an app may update its own
                // session display name while it runs.
                let display_raw = take_pwstr_result(ctl2.GetDisplayName());
                let display_name = self.resolve_name(&display_raw, &exe_full);
                let (volume, mute) = match ctl.cast::<ISimpleAudioVolume>() {
                    Ok(sav) => (
                        sav.GetMasterVolume().unwrap_or(0.0),
                        sav.GetMute().map(|b| b.as_bool()).unwrap_or(false),
                    ),
                    Err(_) => (0.0, false),
                };
                // AudioSessionState: Inactive(0), Active(1), Expired(2). The
                // plugin shows activity <= 3 in "active" mode. A session maps to
                // 2 (visible) when it is currently playing, muted, or was playing
                // within the recent-grace window; otherwise 4 (hidden). Keeping
                // everything visible at the same value 2 (rather than a separate
                // "recent" rank) avoids re-sorting the slot list on state churn.
                let raw_state = ctl.GetState().map(|s| s.0).unwrap_or(1);
                let is_active = raw_state == AudioSessionStateActive.0;
                if is_active {
                    self.last_active.insert(instance.clone(), Instant::now());
                }
                let recently_active = self
                    .last_active
                    .get(&instance)
                    .map(|t| t.elapsed() < RECENT_GRACE)
                    .unwrap_or(false);
                let activity = if is_active || mute || recently_active {
                    2
                } else {
                    4
                };
                out.push(AppInstance {
                    process_id: id,
                    display_name,
                    executable_file: basename(&exe_full),
                    executable_path: exe_full,
                    mute,
                    volume,
                    activity,
                });
            }
        }
        // Drop stale entries so the map can't grow without bound as sessions
        // come and go; anything past the grace window is hidden anyway.
        self.last_active.retain(|_, t| t.elapsed() < RECENT_GRACE);
        // Same for the image-path cache: keep only sessions this sweep saw, so
        // it tracks the live session set rather than growing all day.
        self.process_image.retain(|instance, _| seen.iter().any(|s| s == instance));
        out
    }

    fn set_session_volume(&mut self, id: u32, v: f32) {
        self.with_session(id, |ctl| unsafe {
            if let Ok(sav) = ctl.cast::<ISimpleAudioVolume>() {
                let _ = sav.SetMasterVolume(v.clamp(0.0, 1.0), std::ptr::null());
            }
        });
    }

    fn set_session_mute(&mut self, id: u32, m: bool) {
        self.with_session(id, |ctl| unsafe {
            if let Ok(sav) = ctl.cast::<ISimpleAudioVolume>() {
                let _ = sav.SetMute(BOOL::from(m), std::ptr::null());
            }
        });
    }

    /// Re-enumerates and runs `f` against the live session whose instance id
    /// matches the one this synthetic id was minted for. Sessions are recreated
    /// on every enumeration, so we always match by the stable instance string.
    fn with_session<F: FnOnce(&IAudioSessionControl)>(&mut self, id: u32, f: F) {
        let Some(target) = self.id_to_instance.get(&id).cloned() else {
            return;
        };
        let Some(cached) = self.endpoint() else {
            return;
        };
        let mgr = cached.manager.clone();
        unsafe {
            let Ok(en) = mgr.GetSessionEnumerator() else {
                self.drop_endpoint();
                return;
            };
            let count = en.GetCount().unwrap_or(0);
            for i in 0..count {
                let Ok(ctl) = en.GetSession(i) else { continue };
                let Ok(ctl2) = ctl.cast::<IAudioSessionControl2>() else {
                    continue;
                };
                let instance = take_pwstr_result(ctl2.GetSessionInstanceIdentifier());
                if instance == target {
                    f(&ctl);
                    return;
                }
            }
        }
    }
}

unsafe fn friendly_name(dev: &IMMDevice) -> String {
    let Ok(store) = dev.OpenPropertyStore(STGM_READ) else {
        return String::new();
    };
    // PROPVARIANT implements Display (and frees itself on Drop).
    match store.GetValue(&PKEY_Device_FriendlyName) {
        Ok(pv) => pv.to_string(),
        Err(_) => String::new(),
    }
}

impl Engine {
    /// Resolves a session's shown name: an indirect resource string ("@dll,-id")
    /// resolves via the shell (giving e.g. "システム音"); a literal display name is
    /// used as-is; an empty one falls back to the executable name without ".exe".
    ///
    /// Indirect strings are resolved once and remembered — the lookup loads a
    /// resource out of a DLL and the answer only depends on the string.
    fn resolve_name(&mut self, display_raw: &str, exe_full: &str) -> String {
        if display_raw.starts_with('@') {
            if let Some(cached) = self.indirect_names.get(display_raw) {
                return cached.clone();
            }
            let resolved = unsafe { sh_load_indirect(display_raw) }
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| String::from("システム音"));
            self.indirect_names
                .insert(display_raw.to_string(), resolved.clone());
            return resolved;
        }
        if !display_raw.is_empty() {
            return display_raw.to_string();
        }
        let base = basename(exe_full);
        match base.rsplit_once('.') {
            Some((stem, _ext)) if !stem.is_empty() => stem.to_string(),
            _ => base,
        }
    }
}

fn basename(path: &str) -> String {
    path.rsplit(['\\', '/']).next().unwrap_or(path).to_string()
}

fn process_image(pid: u32) -> String {
    if pid == 0 {
        return String::new();
    }
    unsafe {
        let handle: HANDLE = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(h) => h,
            Err(_) => return String::new(),
        };
        let mut buf = [0u16; 512];
        let mut size = buf.len() as u32;
        let result =
            QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size);
        let _ = CloseHandle(handle);
        if result.is_ok() {
            String::from_utf16_lossy(&buf[..size as usize])
        } else {
            String::new()
        }
    }
}

/// Reads a COM-allocated wide string result into an owned `String`, freeing the
/// buffer. `PWSTR` has no `Default`, so callers can't `unwrap_or_default`.
fn take_pwstr_result(r: windows::core::Result<PWSTR>) -> String {
    match r {
        Ok(p) => unsafe { take_pwstr(p) },
        Err(_) => String::new(),
    }
}

/// Reads a COM-allocated wide string into an owned `String` and frees it.
unsafe fn take_pwstr(p: PWSTR) -> String {
    if p.is_null() {
        return String::new();
    }
    let s = p.to_string().unwrap_or_default();
    CoTaskMemFree(Some(p.0 as _));
    s
}

unsafe fn sh_load_indirect(src: &str) -> Option<String> {
    let wide: Vec<u16> = src.encode_utf16().chain(std::iter::once(0)).collect();
    let mut buf = [0u16; 512];
    SHLoadIndirectString(PCWSTR(wide.as_ptr()), &mut buf, None).ok()?;
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..end]))
}
