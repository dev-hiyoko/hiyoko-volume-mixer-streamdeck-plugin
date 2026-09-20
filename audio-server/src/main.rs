// Hiyoko Audio Server — a lightweight Rust/WASAPI replacement for the Elgato
// Audio Control server. Exposes per-session and per-device volume/mute over a
// JSON-RPC WebSocket that is drop-in compatible with the Stream Deck plugin.
//
// Usage: hiyoko-audio-server [port]   (default port 1845)
//
// Port 1845 sits next to the Elgato server's 1844 so the two can run side by
// side during the transition; the plugin passes the port explicitly anyway.

mod audio;
mod media;
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

    // Apple Music control gets its own thread, deliberately. Its UI Automation
    // calls reach into another process and can block for seconds when that app
    // is busy; the audio thread above is a single serialized queue, so sharing
    // it would stall every volume key behind a slow music app.
    let (media_tx, media_rx) = crossbeam_channel::unbounded::<media::MediaCmd>();
    std::thread::Builder::new()
        .name("media-control".into())
        .spawn(move || media::run_media_thread(media_rx))
        .expect("spawn media thread");

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("build tokio runtime");

    if let Err(e) = rt.block_on(server::serve(&addr, tx, media_tx)) {
        eprintln!("server error: {e}");
        std::process::exit(1);
    }
}
