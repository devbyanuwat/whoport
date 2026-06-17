// Port Scanner backend
// Strategy on macOS:
//   1. `lsof -nP -iTCP -sTCP:LISTEN -F...` -> listening TCP ports + owning PID (machine-readable)
//   2. `ps -p <pids> -o pid=,comm=` -> full executable path for each PID (lsof truncates names)
// Results are merged into one row per listening port.

use serde::Serialize;
use std::collections::HashMap;
use std::process::Command;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

#[derive(Serialize, Clone)]
struct PortEntry {
    port: u32,
    protocol: String,
    ip_version: String,
    address: String,
    pid: i32,
    command: String, // short name reported by lsof
    name: String,    // full executable basename (from ps)
    path: String,    // full executable path (from ps)
    user: String,
    system: bool,    // true = macOS system/daemon process, risky to kill
}

// Heuristic: is this a macOS-owned process the user should not casually kill?
fn is_system_process(path: &str, user: &str) -> bool {
    let system_user = user == "root" || user.starts_with('_');
    let system_path = path.starts_with("/System/")
        || path.starts_with("/usr/bin/")
        || path.starts_with("/usr/sbin/")
        || path.starts_with("/usr/libexec/")
        || path.starts_with("/sbin/")
        || path.starts_with("/bin/");
    // /usr/local and /opt/homebrew are user-installed, not system.
    system_user || system_path
}

fn scan_ports() -> Result<Vec<PortEntry>, String> {
    // Step 1: listening TCP ports, machine-readable fields:
    //   p = pid, c = command, L = login (user), f = file descriptor (record delimiter),
    //   t = type (IPv4/IPv6), n = name (addr:port)
    let out = Command::new("/usr/sbin/lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-FpcLftn"])
        .output()
        .map_err(|e| format!("lsof failed: {e}"))?;

    if out.stdout.is_empty() {
        if !out.status.success() {
            return Err(format!(
                "lsof error: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        return Ok(Vec::new());
    }

    let text = String::from_utf8_lossy(&out.stdout);
    let mut entries: Vec<PortEntry> = Vec::new();

    let mut cur_pid: i32 = 0;
    let mut cur_cmd = String::new();
    let mut cur_user = String::new();
    let mut cur_type = String::new();

    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        let (tag, val) = line.split_at(1);
        match tag {
            "p" => cur_pid = val.parse().unwrap_or(0),
            "c" => cur_cmd = val.to_string(),
            "L" => cur_user = val.to_string(),
            "f" => cur_type.clear(), // start of a new file record
            "t" => cur_type = val.to_string(),
            "n" => {
                // val looks like "*:8770", "127.0.0.1:4321", or "[::1]:5000"
                if let Some(idx) = val.rfind(':') {
                    if let Ok(port) = val[idx + 1..].parse::<u32>() {
                        entries.push(PortEntry {
                            port,
                            protocol: "TCP".into(),
                            ip_version: cur_type.clone(),
                            address: val.to_string(),
                            pid: cur_pid,
                            command: cur_cmd.clone(),
                            name: String::new(),
                            path: String::new(),
                            user: cur_user.clone(),
                            system: false,
                        });
                    }
                }
            }
            _ => {}
        }
    }

    // Step 2: resolve full executable path for every unique PID.
    let mut pids: Vec<i32> = entries.iter().map(|e| e.pid).collect();
    pids.sort_unstable();
    pids.dedup();

    if !pids.is_empty() {
        let pid_list: Vec<String> = pids.iter().map(|p| p.to_string()).collect();
        let ps_out = Command::new("/bin/ps")
            .arg("-p")
            .arg(pid_list.join(","))
            .args(["-o", "pid=,comm="])
            .output()
            .map_err(|e| format!("ps failed: {e}"))?;

        let ps_text = String::from_utf8_lossy(&ps_out.stdout);
        let mut info: HashMap<i32, (String, String)> = HashMap::new();
        for line in ps_text.lines() {
            let line = line.trim_start();
            // "<pid> <full path which may contain spaces>"
            if let Some((pid_s, rest)) = line.split_once(char::is_whitespace) {
                if let Ok(pid) = pid_s.trim().parse::<i32>() {
                    let path = rest.trim().to_string();
                    let name = path.rsplit('/').next().unwrap_or(&path).to_string();
                    info.insert(pid, (path, name));
                }
            }
        }

        for e in entries.iter_mut() {
            if let Some((path, name)) = info.get(&e.pid) {
                e.path = path.clone();
                e.name = name.clone();
            } else {
                e.name = e.command.clone();
            }
        }
    }

    for e in entries.iter_mut() {
        e.system = is_system_process(&e.path, &e.user);
    }

    entries.sort_by(|a, b| a.port.cmp(&b.port).then(a.pid.cmp(&b.pid)));
    Ok(entries)
}

#[tauri::command]
fn list_ports() -> Result<Vec<PortEntry>, String> {
    scan_ports()
}

#[tauri::command]
fn kill_process(pid: i32, force: bool) -> Result<(), String> {
    if pid <= 1 {
        return Err(format!("refusing to kill pid {pid}"));
    }
    let signal = if force { "-9" } else { "-15" };
    let status = Command::new("/bin/kill")
        .arg(signal)
        .arg(pid.to_string())
        .status()
        .map_err(|e| format!("kill failed: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("kill exited with status {status}"))
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![list_ports, kill_process])
        .on_window_event(|window, event| {
            // Closing the window keeps the app alive in the menu bar instead of quitting.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            // Live in the menu bar only: no Dock icon, app stays until "Quit" from the tray.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let open_item =
                MenuItem::with_id(app, "open", "Open Port Scanner", true, None::<&str>)?;
            let refresh_item =
                MenuItem::with_id(app, "refresh", "Refresh", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(
                app,
                &[&open_item, &refresh_item, &separator, &quit_item],
            )?;

            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Port Scanner")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "refresh" => {
                        let _ = app.emit("refresh-ports", ());
                        show_main_window(app);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
