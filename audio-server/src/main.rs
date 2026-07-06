// Hiyoko Audio Server — a lightweight Rust/WASAPI replacement for the Elgato
// Audio Control server. Exposes per-session and per-device volume/mute over a
// JSON-RPC WebSocket that is drop-in compatible with the Stream Deck plugin.
//
// Usage: hiyoko-audio-server [port]   (default port 1845)
//
// Port 1845 sits next to the Elgato server's 1844 so the two can run side by
// side during the transition; the plugin passes the port explicitly anyway.

mod audio;
mod server;

fn main() {
    let port: u16 = std::env::args()
        .nth(1)
        .and_then(|a| a.parse().ok())
        .unwrap_or(1845);
    let addr = format!("127.0.0.1:{port}");

    let (tx, rx) = crossbeam_channel::unbounded::<audio::Cmd>();

    // COM lives entirely on this thread.
    std::thread::Builder::new()
        .name("core-audio".into())
        .spawn(move || audio::run_audio_thread(rx))
        .expect("spawn audio thread");

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("build tokio runtime");

    if let Err(e) = rt.block_on(server::serve(&addr, tx)) {
        eprintln!("server error: {e}");
        std::process::exit(1);
    }
}
