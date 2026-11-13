#![cfg(unix)]
use sigpilot_terminal::TerminalManager;
use std::{
    thread,
    time::{Duration, Instant},
};

fn until(manager: &TerminalManager, id: &str, marker: &[u8]) -> Vec<u8> {
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut data = Vec::new();
    while Instant::now() < deadline {
        let output = manager.poll(id).unwrap();
        assert!(output.error.is_none(), "{:?}", output.error);
        data.extend(output.data);
        if data.windows(marker.len()).any(|window| window == marker) {
            return data;
        }
        thread::sleep(Duration::from_millis(15));
    }
    panic!("marker missing: {}", String::from_utf8_lossy(&data));
}

#[test]
fn interactive_shell_resize_unicode_flow_control_exit_and_stale_ids() {
    let manager = TerminalManager::default();
    let session = manager.open(&std::env::temp_dir(), 83, 27).unwrap();
    assert_eq!(
        manager.open(&std::env::temp_dir(), 80, 24).unwrap().id,
        session.id
    );
    manager
        .write(&session.id, b"stty -echo; printf '__%s__\\n' READY\r")
        .unwrap();
    until(&manager, &session.id, b"__READY__");
    manager
        .write(
            &session.id,
            "printf '\\033[32m%s\\033[0m\\n' '中文终端'; printf '__%s__\\n' UTF8\r".as_bytes(),
        )
        .unwrap();
    let data = until(&manager, &session.id, b"__UTF8__");
    assert!(String::from_utf8_lossy(&data).contains("中文终端"));
    assert!(data.windows(5).any(|window| window == b"\x1b[32m"));
    manager.resize(&session.id, 97, 31).unwrap();
    manager
        .write(&session.id, b"stty size; printf '__%s__\\n' RESIZED\r")
        .unwrap();
    assert!(
        String::from_utf8_lossy(&until(&manager, &session.id, b"__RESIZED__")).contains("31 97")
    );

    // Exceed the backend output budget without polling, then drain without loss.
    manager
        .write(
            &session.id,
            b"head -c 400000 /dev/zero | tr '\\000' Z; printf '__%s__\\n' FLOOD\r",
        )
        .unwrap();
    thread::sleep(Duration::from_millis(200));
    let data = until(&manager, &session.id, b"__FLOOD__");
    assert_eq!(data.iter().filter(|byte| **byte == b'Z').count(), 400000);
    manager.write(&session.id, b"sleep 20\r").unwrap();
    thread::sleep(Duration::from_millis(100));
    manager.write(&session.id, &[3]).unwrap();
    manager
        .write(&session.id, b"printf '__%s__\\n' INTERRUPTED\r")
        .unwrap();
    until(&manager, &session.id, b"__INTERRUPTED__");
    assert!(manager.write(&session.id, &vec![0; 65537]).is_err());
    assert!(manager.resize(&session.id, 0, 30).is_err());
    manager.write(&session.id, b"exit 7\r").unwrap();
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        let output = manager.poll(&session.id).unwrap();
        if output.exited {
            assert_eq!(output.exit_code, Some(7));
            break;
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(20));
    }
    manager.close(&session.id).unwrap();
    let next = manager.open(&std::env::temp_dir(), 80, 24).unwrap();
    assert_ne!(next.id, session.id);
    assert!(manager.close(&session.id).is_err());
    assert!(manager.write(&session.id, b"exit\r").is_err());
    manager.close(&next.id).unwrap();
    assert!(manager.poll(&next.id).is_err());
}

#[test]
fn close_kills_foreground_process_and_drop_cleans_up_shell() {
    let manager = TerminalManager::default();
    let session = manager.open(&std::env::temp_dir(), 80, 24).unwrap();
    manager
        .write(&session.id, b"stty -echo; printf '__%s__%s\\n' PID $$\r")
        .unwrap();
    let data = until(&manager, &session.id, b"__PID__");
    // A marker prefix can span chunks; finish reading the line.
    let mut text = String::from_utf8_lossy(&data).into_owned();
    let deadline = Instant::now() + Duration::from_secs(3);
    let pid = loop {
        if let Some(value) = text
            .split("__PID__")
            .last()
            .and_then(|tail| tail.lines().next())
            .and_then(|value| value.trim().parse::<i32>().ok())
        {
            break value;
        }
        assert!(Instant::now() < deadline);
        text.push_str(&String::from_utf8_lossy(
            &manager.poll(&session.id).unwrap().data,
        ));
        thread::sleep(Duration::from_millis(10));
    };
    manager.write(&session.id, b"sleep 60\r").unwrap();
    thread::sleep(Duration::from_millis(100));
    drop(manager);
    assert_eq!(
        unsafe { libc::kill(pid, 0) },
        -1,
        "shell survived manager drop"
    );
}
