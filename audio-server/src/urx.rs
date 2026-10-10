// Yamaha URX22 mix bus control, without Yamaha Device Center.
//
// The URX22 is a USB composite device; its MI_00 interface is a usbser virtual
// COM port that Device Center uses as its control channel. The protocol below
// was read off that channel and replayed by hand against the real device:
//
//   frame    C0 [len lo][len hi][payload..][cs] C1
//   cs       two's complement of the payload byte sum
//   escape   everything between C0 and C1: C0 -> DB DC, C1 -> DB DE, DB -> DB DD
//
//   hello      00 00 00 00 00 00                        answered with a ~81-byte frame
//   keepalive  11 10 <seq> 00 00 04 01                   once a second while open
//   set mix    10 10 <seq> 00 00 00 a3 02 <idx> 00 <val> 00 00 00   no ack
//
// The same port carries firmware updates. Only the three frame kinds above can
// be built here — `Frame` is the sole way to put bytes on the wire, and its mix
// index and value come from types that cannot hold anything else — so a bug
// elsewhere cannot turn into an arbitrary write to the device.
//
// COM ports are exclusive, and Device Center takes this one for as long as it
// runs. So the port is opened on the first command, kept alive with the
// keepalive, and let go after IDLE_CLOSE without a command; the user can still
// start Device Center when they want it.
//
// Own thread, like the media thread: opening the port and waiting for the hello
// reply takes a few hundred milliseconds, and the audio thread is one serialized
// queue that the volume keys poll through.

use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, RecvTimeoutError};
use tokio::sync::oneshot;

use windows::core::{HSTRING, PCWSTR, PWSTR};
use windows::Win32::Devices::Communication::{
    GetCommState, PurgeComm, SetCommState, SetCommTimeouts, COMMTIMEOUTS, DCB, NOPARITY, ONESTOPBIT,
    PURGE_RXCLEAR, PURGE_TXCLEAR,
};
use windows::Win32::Devices::DeviceAndDriverInstallation::{CM_Locate_DevNodeW, CM_LOCATE_DEVNODE_NORMAL, CR_SUCCESS};
use windows::Win32::Foundation::{
    CloseHandle, ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_SHARING_VIOLATION, ERROR_SUCCESS, ERROR_TIMEOUT,
    GENERIC_READ,
    GENERIC_WRITE, HANDLE,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_MODE, OPEN_EXISTING,
};
use windows::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ, RRF_RT_REG_SZ,
};

/// Where Windows records the URX22's control interface. Each subkey is one
/// device instance ever seen — including ones that are no longer plugged in,
/// which is why presence is checked separately before a port is trusted.
const ENUM_KEY: &str = r"SYSTEM\CurrentControlSet\Enum\USB\VID_0499&PID_1416&MI_00";
const DEVICE_ID_PREFIX: &str = r"USB\VID_0499&PID_1416&MI_00";

/// How often the device must hear from us. Device Center sends one a second.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(1);
/// How long the port is held after the last command.
const IDLE_CLOSE: Duration = Duration::from_secs(60);
/// How long to wait for the device to answer hello.
const HELLO_TIMEOUT: Duration = Duration::from_millis(500);
/// A write that cannot complete in this long means the device is gone or wedged.
const WRITE_TIMEOUT_MS: u32 = 500;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UrxMix {
    Mix1,
    Mix2,
}

impl UrxMix {
    /// The bus number as the plugin names it (1 or 2). Anything else is refused
    /// here, at the edge, rather than mapped to some index.
    pub fn from_number(n: u64) -> Option<Self> {
        match n {
            1 => Some(UrxMix::Mix1),
            2 => Some(UrxMix::Mix2),
            _ => None,
        }
    }

    /// The parameter index the device uses for this bus's on/off switch.
    fn index(self) -> u8 {
        match self {
            UrxMix::Mix1 => 0x00,
            UrxMix::Mix2 => 0x02,
        }
    }
}

pub enum UrxCmd {
    SetMixOn {
        mix: UrxMix,
        on: bool,
        reply: oneshot::Sender<Result<(), String>>,
    },
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/// Everything this module is allowed to send.
#[derive(Clone, Copy)]
enum Frame {
    Hello,
    Keepalive,
    SetMixOn { mix: UrxMix, on: bool },
}

impl Frame {
    fn payload(self, seq: u8) -> Vec<u8> {
        match self {
            Frame::Hello => vec![0x00; 6],
            Frame::Keepalive => vec![0x11, 0x10, seq, 0x00, 0x00, 0x04, 0x01],
            Frame::SetMixOn { mix, on } => vec![
                0x10,
                0x10,
                seq,
                0x00,
                0x00,
                0x00,
                0xa3,
                0x02,
                mix.index(),
                0x00,
                u8::from(on),
                0x00,
                0x00,
                0x00,
            ],
        }
    }

    /// Whether this frame carries a sequence number (and so consumes one).
    fn sequenced(self) -> bool {
        !matches!(self, Frame::Hello)
    }
}

fn checksum(payload: &[u8]) -> u8 {
    let sum = payload.iter().fold(0u8, |acc, b| acc.wrapping_add(*b));
    0u8.wrapping_sub(sum)
}

fn push_escaped(out: &mut Vec<u8>, byte: u8) {
    match byte {
        0xc0 => out.extend_from_slice(&[0xdb, 0xdc]),
        0xc1 => out.extend_from_slice(&[0xdb, 0xde]),
        0xdb => out.extend_from_slice(&[0xdb, 0xdd]),
        b => out.push(b),
    }
}

fn encode(payload: &[u8]) -> Vec<u8> {
    let len = payload.len() as u16;
    let mut out = Vec::with_capacity(payload.len() + 8);
    out.push(0xc0);
    for b in len.to_le_bytes() {
        push_escaped(&mut out, b);
    }
    for &b in payload {
        push_escaped(&mut out, b);
    }
    push_escaped(&mut out, checksum(payload));
    out.push(0xc1);
    out
}

// ---------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------

pub fn run_urx_thread(rx: Receiver<UrxCmd>) {
    let mut port: Option<Port> = None;

    loop {
        let received = match &port {
            None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
            Some(open) => {
                let next = open.next_keepalive.min(open.last_command + IDLE_CLOSE);
                rx.recv_timeout(next.saturating_duration_since(Instant::now()))
            }
        };

        match received {
            Ok(UrxCmd::SetMixOn { mix, on, reply }) => {
                let _ = reply.send(set_mix_on(&mut port, mix, on));
            }
            Err(RecvTimeoutError::Timeout) => tick(&mut port),
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

/// Keepalive and idle close, between commands.
fn tick(port: &mut Option<Port>) {
    let Some(open) = port.as_mut() else { return };
    let now = Instant::now();
    if now.duration_since(open.last_command) >= IDLE_CLOSE {
        *port = None;
        return;
    }
    if now >= open.next_keepalive {
        open.next_keepalive = now + KEEPALIVE_INTERVAL;
        open.drain();
        if let Err(e) = open.send(Frame::Keepalive) {
            // Most likely unplugged. Nobody is waiting on this, so just let go;
            // the next command reopens and reports properly if it is still gone.
            eprintln!("urx22: keepalive failed, closing the port: {e}");
            *port = None;
        }
    }
}

fn set_mix_on(port: &mut Option<Port>, mix: UrxMix, on: bool) -> Result<(), String> {
    if port.is_none() {
        *port = Some(Port::open()?);
    }
    let open = port.as_mut().expect("opened above");
    open.last_command = Instant::now();
    open.drain();
    if let Err(e) = open.send(Frame::SetMixOn { mix, on }) {
        *port = None;
        return Err(format!("URX22 write failed (unplugged?): {e}"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Serial port
// ---------------------------------------------------------------------------

struct Port {
    handle: HANDLE,
    /// Sequence number for the next sequenced frame.
    seq: u8,
    next_keepalive: Instant,
    last_command: Instant,
}

impl Drop for Port {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

impl Port {
    /// Finds the URX22's control port, opens it and completes the hello.
    fn open() -> Result<Port, String> {
        let names = present_port_names();
        if names.is_empty() {
            return Err("URX22 not connected".into());
        }

        let mut in_use = false;
        let mut last_error = String::new();
        for name in names {
            match open_serial(&name) {
                Ok(handle) => {
                    let mut port = Port {
                        handle,
                        seq: 1,
                        next_keepalive: Instant::now() + KEEPALIVE_INTERVAL,
                        last_command: Instant::now(),
                    };
                    return port.hello().map(|_| port);
                }
                Err(e)
                    if e.code() == ERROR_ACCESS_DENIED.to_hresult()
                        || e.code() == ERROR_SHARING_VIOLATION.to_hresult() =>
                {
                    in_use = true;
                }
                Err(e) if e.code() == ERROR_FILE_NOT_FOUND.to_hresult() => {}
                Err(e) => last_error = format!("could not open {name}: {e}"),
            }
        }

        if in_use {
            Err("URX22 is in use by another app (Yamaha Device Center?)".into())
        } else if !last_error.is_empty() {
            Err(format!("URX22 {last_error}"))
        } else {
            Err("URX22 not connected".into())
        }
    }

    fn hello(&mut self) -> Result<(), String> {
        unsafe {
            // Anything left in the driver from a previous owner would read as a
            // reply to our hello.
            let _ = PurgeComm(self.handle, PURGE_RXCLEAR | PURGE_TXCLEAR);
        }
        self.send(Frame::Hello)
            .map_err(|e| format!("URX22 write failed: {e}"))?;

        let deadline = Instant::now() + HELLO_TIMEOUT;
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
            if self.drain() > 0 {
                return Ok(());
            }
        }
        Err("URX22 did not answer".into())
    }

    fn send(&mut self, frame: Frame) -> windows::core::Result<()> {
        let bytes = encode(&frame.payload(self.seq));
        if frame.sequenced() {
            // 0 is left out on wrap: it is what hello carries in that position,
            // and Device Center was never seen to use it.
            self.seq = self.seq.checked_add(1).unwrap_or(1);
        }
        let mut written = 0u32;
        unsafe { WriteFile(self.handle, Some(&bytes), Some(&mut written), None) }?;
        if written as usize != bytes.len() {
            // The write timeout expired part-way: the device stopped taking data.
            return Err(ERROR_TIMEOUT.to_hresult().into());
        }
        Ok(())
    }

    /// Reads and discards whatever the device has sent — replies and
    /// unsolicited notifications alike, none of which is used yet. Returns how
    /// many bytes there were. Bounded so a chatty device cannot keep us here.
    fn drain(&mut self) -> usize {
        let mut buf = [0u8; 256];
        let mut total = 0;
        for _ in 0..64 {
            let mut read = 0u32;
            let ok = unsafe { ReadFile(self.handle, Some(&mut buf), Some(&mut read), None) };
            if ok.is_err() || read == 0 {
                break;
            }
            total += read as usize;
        }
        total
    }
}

fn open_serial(name: &str) -> windows::core::Result<HANDLE> {
    let path = HSTRING::from(format!(r"\\.\{name}"));
    let handle = unsafe {
        CreateFileW(
            &path,
            (GENERIC_READ | GENERIC_WRITE).0,
            FILE_SHARE_MODE(0),
            None,
            OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(0),
            None,
        )
    }?;

    let configured = unsafe {
        let mut dcb = DCB {
            DCBlength: std::mem::size_of::<DCB>() as u32,
            ..Default::default()
        };
        GetCommState(handle, &mut dcb).and_then(|_| {
            // CDC ignores the line settings, but a driver that has been left in
            // some other mode should not get the chance to matter.
            dcb.BaudRate = 115_200;
            dcb.ByteSize = 8;
            dcb.Parity = NOPARITY;
            dcb.StopBits = ONESTOPBIT;
            // fBinary (bit 0), DTR_CONTROL_ENABLE (bits 4-5 = 1),
            // RTS_CONTROL_ENABLE (bits 12-13 = 1); no flow control.
            dcb._bitfield = 1 | (1 << 4) | (1 << 12);
            SetCommState(handle, &dcb)
        })
        .and_then(|_| {
            // MAXDWORD/0/0 makes ReadFile return at once with whatever is
            // buffered, so draining never blocks the thread.
            let timeouts = COMMTIMEOUTS {
                ReadIntervalTimeout: u32::MAX,
                ReadTotalTimeoutMultiplier: 0,
                ReadTotalTimeoutConstant: 0,
                WriteTotalTimeoutMultiplier: 0,
                WriteTotalTimeoutConstant: WRITE_TIMEOUT_MS,
            };
            SetCommTimeouts(handle, &timeouts)
        })
    };

    match configured {
        Ok(()) => Ok(handle),
        Err(e) => {
            unsafe {
                let _ = CloseHandle(handle);
            }
            Err(e)
        }
    }
}

/// COM port names of URX22 control interfaces that are plugged in right now.
///
/// The Enum key also keeps instances from past connections, and their recorded
/// port name may since have gone to another device; sending even a hello to
/// some unrelated serial device is not acceptable, so an instance only counts
/// if Plug and Play reports it present.
fn present_port_names() -> Vec<String> {
    let mut names = Vec::new();
    let mut key = HKEY::default();
    let enum_key = HSTRING::from(ENUM_KEY);
    if unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, &enum_key, 0, KEY_READ, &mut key) } != ERROR_SUCCESS {
        return names;
    }

    for index in 0.. {
        let mut buf = [0u16; 256];
        let mut len = buf.len() as u32;
        let status = unsafe {
            RegEnumKeyExW(key, index, PWSTR(buf.as_mut_ptr()), &mut len, None, PWSTR::null(), None, None)
        };
        if status != ERROR_SUCCESS {
            break;
        }
        let instance = String::from_utf16_lossy(&buf[..len as usize]);

        let device_id = HSTRING::from(format!(r"{DEVICE_ID_PREFIX}\{instance}"));
        let mut devinst = 0u32;
        if unsafe { CM_Locate_DevNodeW(&mut devinst, &device_id, CM_LOCATE_DEVNODE_NORMAL) } != CR_SUCCESS {
            continue;
        }

        if let Some(name) = read_port_name(key, &instance) {
            names.push(name);
        }
    }

    unsafe {
        let _ = RegCloseKey(key);
    }
    names
}

fn read_port_name(enum_key: HKEY, instance: &str) -> Option<String> {
    let subkey = HSTRING::from(format!(r"{instance}\Device Parameters"));
    let value = HSTRING::from("PortName");
    let mut buf = [0u16; 64];
    let mut size = std::mem::size_of_val(&buf) as u32;
    let status = unsafe {
        RegGetValueW(
            enum_key,
            &subkey,
            PCWSTR(value.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut size),
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }
    let chars = (size as usize / 2).saturating_sub(1);
    let name = String::from_utf16_lossy(&buf[..chars.min(buf.len())]);
    // Only ever hand a plain COMn to CreateFile: this string is turned into a
    // device path, and the registry is not ours.
    let valid = name.len() > 3 && name.starts_with("COM") && name[3..].bytes().all(|b| b.is_ascii_digit());
    valid.then_some(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn hello_frame() {
        assert_eq!(hex(&encode(&Frame::Hello.payload(1))), "c0 06 00 00 00 00 00 00 00 00 c1");
    }

    #[test]
    fn keepalive_frame_escapes_c0_checksum() {
        assert_eq!(
            hex(&encode(&Frame::Keepalive.payload(0x1a))),
            "c0 07 00 11 10 1a 00 00 04 01 db dc c1"
        );
    }

    #[test]
    fn set_mix2_on_frame() {
        let frame = Frame::SetMixOn {
            mix: UrxMix::Mix2,
            on: true,
        };
        assert_eq!(
            hex(&encode(&frame.payload(0x20))),
            "c0 0e 00 10 10 20 00 00 00 a3 02 02 00 01 00 00 00 18 c1"
        );
    }

    #[test]
    fn set_mix1_off_frame_escapes_c1_checksum() {
        let frame = Frame::SetMixOn {
            mix: UrxMix::Mix1,
            on: false,
        };
        assert_eq!(
            hex(&encode(&frame.payload(0x7a))),
            "c0 0e 00 10 10 7a 00 00 00 a3 02 00 00 00 00 00 00 db de c1"
        );
    }

    #[test]
    fn escapes_db() {
        assert_eq!(hex(&encode(&[0xdb, 0x00])), "c0 02 00 db dd 00 25 c1");
    }

    #[test]
    fn mix_numbers() {
        assert_eq!(UrxMix::from_number(1), Some(UrxMix::Mix1));
        assert_eq!(UrxMix::from_number(2), Some(UrxMix::Mix2));
        assert_eq!(UrxMix::from_number(0), None);
        assert_eq!(UrxMix::from_number(3), None);
    }
}
