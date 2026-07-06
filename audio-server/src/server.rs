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

pub struct AppState {
    tx: Sender<Cmd>,
    /// Snapshot taken on getApplicationInstanceCount and read by index, so a
    /// count+index burst from the plugin sees a consistent list.
    snapshot: Mutex<Vec<AppInstance>>,
}

pub async fn serve(addr: &str, tx: Sender<Cmd>) -> std::io::Result<()> {
    let listener = TcpListener::bind(addr).await?;
    println!("hiyoko-audio-server listening on {addr}");
    let state = Arc::new(AppState {
        tx,
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

    while let Some(msg) = read.next().await {
        match msg? {
            Message::Text(text) => {
                if let Some(reply) = handle_rpc(&text, &state).await {
                    write.send(Message::Text(reply)).await?;
                }
            }
            Message::Ping(payload) => write.send(Message::Pong(payload)).await?,
            Message::Close(_) => break,
            _ => {}
        }
    }
    Ok(())
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
                None => Err("no default output device"),
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
                None => Err("index out of range"),
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
        _ => Err("unknown method"),
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
