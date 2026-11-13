//! Local-only verification fixture using the production PTY manager.
use serde_json::{json, Value};
use sigpilot_terminal::TerminalManager;
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::Arc,
};

fn respond(mut socket: TcpStream, manager: Arc<TerminalManager>) {
    let _ = socket.set_read_timeout(Some(std::time::Duration::from_secs(5)));
    let mut request = Vec::new();
    let mut buffer = [0; 4096];
    let end = loop {
        let count = match socket.read(&mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        request.extend_from_slice(&buffer[..count]);
        if request.len() > 256 * 1024 {
            return;
        }
        if let Some(end) = request.windows(4).position(|b| b == b"\r\n\r\n") {
            break end + 4;
        }
    };
    let header = String::from_utf8_lossy(&request[..end]);
    let first = header.lines().next().unwrap_or_default();
    let path = first
        .split_whitespace()
        .nth(1)
        .unwrap_or_default()
        .to_owned();
    let length = header
        .lines()
        .find_map(|line| {
            line.strip_prefix("Content-Length: ")
                .or_else(|| line.strip_prefix("content-length: "))
        })
        .and_then(|n| n.parse::<usize>().ok())
        .unwrap_or(0);
    if length > 128 * 1024 {
        return;
    }
    while request.len() < end + length {
        let count = match socket.read(&mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        request.extend_from_slice(&buffer[..count]);
    }
    let value: Value = serde_json::from_slice(&request[end..end + length]).unwrap_or(json!({}));
    let id = value["id"].as_str().unwrap_or_default();
    let result: Result<Value, String> = match path.as_str() {
        "/open" => manager
            .open(
                &std::env::temp_dir(),
                value["cols"].as_u64().unwrap_or(80) as u16,
                value["rows"].as_u64().unwrap_or(24) as u16,
            )
            .map(|v| json!(v)),
        "/poll" => manager.poll(id).map(|v| json!(v)),
        "/write" => manager
            .write(id, value["data"].as_str().unwrap_or_default().as_bytes())
            .map(|_| json!(null)),
        "/resize" => manager
            .resize(
                id,
                value["cols"].as_u64().unwrap_or(80) as u16,
                value["rows"].as_u64().unwrap_or(24) as u16,
            )
            .map(|_| json!(null)),
        "/close" => manager.close(id).map(|_| json!(null)),
        _ => Err("Unknown fixture route".into()),
    };
    let status = if result.is_ok() {
        "200 OK"
    } else {
        "400 Bad Request"
    };
    let body = serde_json::to_vec(&result.unwrap_or_else(|error| json!({"error":error}))).unwrap();
    let header = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len());
    let _ = socket.write_all(header.as_bytes());
    let _ = socket.write_all(&body);
}

fn main() {
    let port = std::env::args().nth(1).unwrap().parse::<u16>().unwrap();
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).unwrap();
    let manager = Arc::new(TerminalManager::default());
    for socket in listener.incoming().flatten() {
        let manager = manager.clone();
        std::thread::spawn(move || respond(socket, manager));
    }
}
