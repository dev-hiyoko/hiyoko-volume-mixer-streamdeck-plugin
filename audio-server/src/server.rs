// WebSocket JSON-RPC front end. Speaks the same method surface the Stream Deck
// plugin already used with the Elgato server, so it is a drop-in replacement.

use std::sync::Arc;

use crossbeam_channel::Sender;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};
use tokio_tungstenite::tungstenite::Message;

use crate::audio::{AppInstance, Cmd};
use crate::media::MediaCmd;

pub struct AppState {
    tx: Sender<Cmd>,
    /// Apple Music control. A separate channel to a separate thread: these
    /// calls can block for seconds, and must never queue behind (or ahead of)
    /// the audio commands.
    media_tx: Sender<MediaCmd>,
    /// Snapshot taken on getApplicationInstanceCount and read by index, so a
    /// count+index burst from the plugin sees a consistent list.
    snapshot: Mutex<Vec<AppInstance>>,
}

pub async fn serve(addr: &str, tx: Sender<Cmd>, media_tx: Sender<MediaCmd>) -> std::io::Result<()> {
    let listener = TcpListener::bind(addr).await?;
    println!("hiyoko-audio-server listening on {addr}");
    let state = Arc::new(AppState {
        tx,
        media_tx,
        snapshot: Mutex::new(Vec::new()),
    });

    loop {
        let (stream, _peer) = listener.accept().await?;
        let state = state.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_conn(stream, state).await {
                eprintln!("connection ended: {e}");
            }
        });
    }
}

async fn handle_conn(
    stream: tokio::net::TcpStream,
    state: Arc<AppState>,
) -> Result<(), tokio_tungstenite::tungstenite::Error> {
    let ws = tokio_tungstenite::accept_async(stream).await?;
    let (mut write, mut read) = ws.split();

    // One writer, fed by a queue, so replies can be produced out of order.
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<Message>();
    let writer = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if write.send(msg).await.is_err() {
                break;
            }
        }
    });

    while let Some(msg) = read.next().await {
        match msg? {
            Message::Text(text) => {
                // Apple Music commands take 1-2 seconds (they drive another
                // app's UI and may launch it). Awaiting one here would hold up
                // every later message on this socket — including the volume
                // polling, which then times out and drops the mixer offline for
                // a reason that has nothing to do with audio. Observed in the
                // plugin log on 2026-09-20 as
                // "Poll could not read audio sessions: ... timed out".
                //
                // So the slow methods are dispatched concurrently and the audio
                // methods stay inline. Keeping the audio path serialized is
                // deliberate: getApplicationInstanceCount publishes the
                // snapshot that the following index reads consume, and running
                // two of those at once would let one burst read another's
                // snapshot.
                if is_slow_method(&text) {
                    let state = state.clone();
                    let out_tx = out_tx.clone();
                    tokio::spawn(async move {
                        if let Some(reply) = handle_rpc(&text, &state).await {
                            let _ = out_tx.send(Message::Text(reply));
                        }
                    });
                } else if let Some(reply) = handle_rpc(&text, &state).await {
                    if out_tx.send(Message::Text(reply)).is_err() {
                        break;
                    }
                }
            }
            Message::Ping(payload) => {
                if out_tx.send(Message::Pong(payload)).is_err() {
                    break;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    drop(out_tx);
    let _ = writer.await;
    Ok(())
}

/// Whether a request should be run off the connection's read loop.
///
/// Matched on the raw text so the decision costs one substring scan rather than
/// a full parse of every message on the hot path.
fn is_slow_method(text: &str) -> bool {
    text.contains("\"appleMusic")
}

async fn handle_rpc(text: &str, state: &Arc<AppState>) -> Option<String> {
    let req: Value = serde_json::from_str(text).ok()?;
    let id = req.get("id").cloned();
    let method = req.get("method")?.as_str()?.to_string();
    let params = req.get("params").cloned().unwrap_or(Value::Null);

    // Notifications (no id) never get a reply.
    let id = id?;

    let result = match method.as_str() {
        "getSystemDefaultDevice" => {
            let (reply, rx) = oneshot::channel();
            let _ = state.tx.send(Cmd::GetDefaultDevice(reply));
            match rx.await.ok().flatten() {
                Some(device) => Ok(serde_json::to_value(device).unwrap_or(Value::Null)),
                None => Err("no default output device".into()),
            }
        }
        "setSystemDefaultDeviceVolume" => {
            if let Some(v) = params.get("volume").and_then(Value::as_f64) {
                let _ = state.tx.send(Cmd::SetDefaultVolume(v as f32));
            }
            Ok(Value::Null)
        }
        "setSystemDefaultDeviceMute" => {
            if let Some(m) = params.get("mute").and_then(Value::as_bool) {
                let _ = state.tx.send(Cmd::SetDefaultMute(m));
            }
            Ok(Value::Null)
        }
        "getApplicationInstanceCount" => {
            let (reply, rx) = oneshot::channel();
            let _ = state.tx.send(Cmd::GetSessions(reply));
            let sessions = rx.await.unwrap_or_default();
            let count = sessions.len();
            *state.snapshot.lock().await = sessions;
            Ok(json!({ "count": count }))
        }
        "getApplicationInstanceAtIndex" => {
            let index = params.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            let snapshot = state.snapshot.lock().await;
            match snapshot.get(index) {
                Some(instance) => Ok(serde_json::to_value(instance).unwrap_or(Value::Null)),
                None => Err("index out of range".into()),
            }
        }
        "setApplicationInstanceVolume" => {
            let id = params.get("processID").and_then(Value::as_u64);
            let v = params.get("volume").and_then(Value::as_f64);
            if let (Some(id), Some(v)) = (id, v) {
                let _ = state.tx.send(Cmd::SetSessionVolume(id as u32, v as f32));
            }
            Ok(Value::Null)
        }
        "setApplicationInstanceMute" => {
            let id = params.get("processID").and_then(Value::as_u64);
            let m = params.get("mute").and_then(Value::as_bool);
            if let (Some(id), Some(m)) = (id, m) {
                let _ = state.tx.send(Cmd::SetSessionMute(id as u32, m));
            }
            Ok(Value::Null)
        }
        // --- Apple Music -----------------------------------------------------
        // These go to the media thread and can legitimately take seconds (they
        // may have to launch the app and wait for its window), so unlike the
        // audio methods they report failure as a JSON-RPC error with a reason
        // the plugin can show on the key. Silently doing nothing is the worst
        // outcome here: the user presses a key and cannot tell whether it
        // worked.
        "appleMusicListPlaylists" => {
            let (reply, rx) = oneshot::channel();
            let _ = state.media_tx.send(MediaCmd::ListPlaylists(reply));
            match rx.await {
                Ok(Ok(playlists)) => Ok(json!({ "playlists": playlists })),
                Ok(Err(message)) => Err(message),
                Err(_) => Err("media thread is not answering".into()),
            }
        }
        "appleMusicPlayPlaylist" => {
            let id = params
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let shuffle = params
                .get("shuffle")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let (reply, rx) = oneshot::channel();
            let _ = state.media_tx.send(MediaCmd::PlayPlaylist {
                id,
                name,
                shuffle,
                reply,
            });
            match rx.await {
                Ok(Ok(())) => Ok(Value::Null),
                Ok(Err(message)) => Err(message),
                Err(_) => Err("media thread is not answering".into()),
            }
        }
        "appleMusicResume" | "appleMusicPause" => {
            let (reply, rx) = oneshot::channel();
            let cmd = if method == "appleMusicResume" {
                MediaCmd::Resume(reply)
            } else {
                MediaCmd::Pause(reply)
            };
            let _ = state.media_tx.send(cmd);
            match rx.await {
                Ok(Ok(())) => Ok(Value::Null),
                Ok(Err(message)) => Err(message),
                Err(_) => Err("media thread is not answering".into()),
            }
        }
        "appleMusicStatus" => {
            let (reply, rx) = oneshot::channel();
            let _ = state.media_tx.send(MediaCmd::Status(reply));
            match rx.await {
                Ok(status) => Ok(serde_json::to_value(status).unwrap_or(Value::Null)),
                Err(_) => Err("media thread is not answering".into()),
            }
        }
        "appleMusicLaunch" => {
            let (reply, rx) = oneshot::channel();
            let _ = state.media_tx.send(MediaCmd::Launch(reply));
            match rx.await {
                Ok(Ok(())) => Ok(Value::Null),
                Ok(Err(message)) => Err(message),
                Err(_) => Err("media thread is not answering".into()),
            }
        }
        _ => Err("unknown method".into()),
    };

    let envelope = match result {
        Ok(value) => json!({ "jsonrpc": "2.0", "id": id, "result": value }),
        Err(message) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32603, "message": message }
        }),
    };
    Some(envelope.to_string())
}
