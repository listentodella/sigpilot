use serde_json::{json, Value};
use std::{collections::VecDeque, sync::Mutex};
use tokio::sync::watch;

/// Capture/UI threads publish without waiting for a browser or network socket.
pub struct Events {
    data: Mutex<(u64, VecDeque<(u64, Value)>)>,
    changed: watch::Sender<u64>,
}

impl Default for Events {
    fn default() -> Self {
        Self {
            data: Mutex::new((0, VecDeque::new())),
            changed: watch::channel(0).0,
        }
    }
}

impl Events {
    pub fn publish(&self, event: Value) {
        if serde_json::to_vec(&event).map_or(true, |b| b.len() > 32 * 1024) {
            return;
        }
        let mut data = self.data.lock().unwrap();
        data.0 = data.0.saturating_add(1);
        let sequence = data.0;
        data.1.push_back((sequence, event));
        while data.1.len() > 64 {
            data.1.pop_front();
        }
        self.changed.send_replace(sequence);
    }

    pub async fn read(&self, after: u64) -> Value {
        let mut receiver = self.changed.subscribe();
        if *receiver.borrow_and_update() == after {
            let _ =
                tokio::time::timeout(std::time::Duration::from_secs(20), receiver.changed()).await;
        }
        let data = self.data.lock().unwrap();
        let resync = after > data.0
            || data
                .1
                .front()
                .is_some_and(|e| after.saturating_add(1) < e.0);
        json!({"sequence":data.0.to_string(), "resync":resync,
            "events": if resync { vec![] } else { data.1.iter().filter(|e| e.0>after).map(|e| e.1.clone()).collect::<Vec<_>>() }})
    }
}
