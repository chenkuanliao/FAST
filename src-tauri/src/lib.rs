use std::{
    borrow::Cow,
    fs,
    path::PathBuf,
    process::Command,
    sync::mpsc,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use arboard::{Clipboard, ImageData};
use base64::{engine::general_purpose, Engine as _};
use image::GenericImageView;
use tauri::{Manager, PhysicalPosition, WebviewWindow};

#[cfg(target_os = "macos")]
use objc2::MainThreadMarker;
#[cfg(target_os = "macos")]
use objc2_app_kit::NSApplication;

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

fn png_data_url(bytes: &[u8]) -> String {
    format!(
        "data:image/png;base64,{}",
        general_purpose::STANDARD.encode(bytes)
    )
}

fn decode_png_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    let encoded = data_url
        .strip_prefix("data:image/png;base64,")
        .ok_or_else(|| "Expected a PNG data URL".to_string())?;

    general_purpose::STANDARD
        .decode(encoded)
        .map_err(|err| format!("Could not decode PNG: {err}"))
}

fn temp_capture_path() -> PathBuf {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    std::env::temp_dir().join(format!("fast-capture-{millis}.png"))
}

#[cfg(target_os = "macos")]
fn ensure_screen_capture_permission() -> Result<(), String> {
    let has_permission = unsafe { CGPreflightScreenCaptureAccess() };
    if has_permission {
        return Ok(());
    }

    let granted = unsafe { CGRequestScreenCaptureAccess() };
    if granted {
        return Ok(());
    }

    Err(
        "FAST needs Screen Recording permission to capture regions. Enable FAST in System Settings > Privacy & Security > Screen & System Audio Recording, then quit and reopen FAST."
            .into(),
    )
}

struct CaptureWindowState {
    window: WebviewWindow,
    position: Option<PhysicalPosition<i32>>,
}

#[cfg(target_os = "macos")]
fn set_native_app_hidden(app: &tauri::AppHandle, hidden: bool) -> Result<(), String> {
    let (sender, receiver) = mpsc::channel();

    app.run_on_main_thread(move || {
        if let Some(marker) = MainThreadMarker::new() {
            let ns_app = NSApplication::sharedApplication(marker);
            if hidden {
                for window in ns_app.windows().iter() {
                    window.setAlphaValue(0.0);
                    window.orderOut(None);
                }
                ns_app.hide(None);
            } else {
                ns_app.unhide(None);
                for window in ns_app.windows().iter() {
                    window.setAlphaValue(1.0);
                }
            }
        }

        let _ = sender.send(());
    })
    .map_err(|err| format!("Could not schedule macOS app visibility change: {err}"))?;

    receiver
        .recv_timeout(Duration::from_millis(500))
        .map_err(|err| format!("Timed out changing macOS app visibility: {err}"))
}

fn wait_for_window_visibility(
    window: &WebviewWindow,
    visible: bool,
    timeout: Duration,
) -> Result<(), String> {
    let started = SystemTime::now();

    loop {
        match window.is_visible() {
            Ok(current) if current == visible => return Ok(()),
            Ok(_) | Err(_) => {}
        }

        if started.elapsed().unwrap_or_default() >= timeout {
            let state = if visible { "visible" } else { "hidden" };
            return Err(format!("Timed out waiting for FAST to become {state}."));
        }

        thread::sleep(Duration::from_millis(20));
    }
}

fn hide_app_for_capture(app: &tauri::AppHandle) -> Result<Vec<CaptureWindowState>, String> {
    let mut windows = Vec::new();

    for window in app.webview_windows().into_values() {
        let position = window.outer_position().ok();
        let _ = window.set_position(PhysicalPosition::new(-32_000, -32_000));

        if let Err(err) = window.hide() {
            let _ = restore_app_after_capture(app, windows);
            return Err(format!("Could not hide FAST for capture: {err}"));
        }

        windows.push(CaptureWindowState { window, position });
    }

    #[cfg(target_os = "macos")]
    if let Err(err) = set_native_app_hidden(app, true) {
        let _ = restore_app_after_capture(app, windows);
        return Err(err);
    }

    let visibility_error = windows.iter().find_map(|state| {
        wait_for_window_visibility(&state.window, false, Duration::from_millis(750)).err()
    });

    if let Some(err) = visibility_error {
        let _ = restore_app_after_capture(app, windows);
        return Err(err);
    }

    Ok(windows)
}

fn restore_app_after_capture(
    app: &tauri::AppHandle,
    windows: Vec<CaptureWindowState>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    set_native_app_hidden(app, false)?;

    for state in windows {
        if let Some(position) = state.position {
            let _ = state.window.set_position(position);
        }

        state
            .window
            .show()
            .map_err(|err| format!("Could not show FAST after capture: {err}"))?;
        let _ = state.window.unminimize();
        let _ = state.window.set_focus();
    }

    Ok(())
}

#[tauri::command]
async fn capture_region(window: tauri::Window) -> Result<String, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        return Err("Region capture is currently implemented for macOS first.".into());
    }

    #[cfg(target_os = "macos")]
    {
        let app = window.app_handle().clone();
        let path = temp_capture_path();
        ensure_screen_capture_permission()?;
        let hidden_windows = hide_app_for_capture(&app)?;
        thread::sleep(Duration::from_millis(80));

        let capture_result = Command::new("/usr/sbin/screencapture")
            .args(["-i", "-x"])
            .arg(&path)
            .status();

        restore_app_after_capture(&app, hidden_windows)?;
        let _ = window.set_focus();

        let status =
            capture_result.map_err(|err| format!("Could not start macOS region capture: {err}"))?;

        if !status.success() {
            let _ = fs::remove_file(&path);
            return Err("Capture canceled.".into());
        }

        let bytes = fs::read(&path).map_err(|err| format!("Could not read capture: {err}"))?;
        let _ = fs::remove_file(&path);

        if bytes.is_empty() {
            return Err("Capture canceled.".into());
        }

        Ok(png_data_url(&bytes))
    }
}

#[tauri::command]
fn save_png(data_url: String) -> Result<String, String> {
    let bytes = decode_png_data_url(&data_url)?;
    let Some(path) = rfd::FileDialog::new()
        .set_title("Save FAST Snapshot")
        .add_filter("PNG image", &["png"])
        .set_file_name("fast-snapshot.png")
        .save_file()
    else {
        return Err("Save canceled.".into());
    };

    fs::write(&path, bytes).map_err(|err| format!("Could not save PNG: {err}"))?;
    Ok(path.display().to_string())
}

#[tauri::command]
fn copy_png_to_clipboard(data_url: String) -> Result<(), String> {
    let bytes = decode_png_data_url(&data_url)?;
    let image = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
        .map_err(|err| format!("Could not decode PNG image: {err}"))?;
    let (width, height) = image.dimensions();
    let rgba = image.to_rgba8().into_raw();

    let mut clipboard =
        Clipboard::new().map_err(|err| format!("Could not open clipboard: {err}"))?;
    clipboard
        .set_image(ImageData {
            width: width as usize,
            height: height as usize,
            bytes: Cow::Owned(rgba),
        })
        .map_err(|err| format!("Could not copy image to clipboard: {err}"))
}

#[tauri::command]
fn close_window(window: tauri::Window) -> Result<(), String> {
    window
        .close()
        .map_err(|err| format!("Could not close FAST: {err}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            capture_region,
            close_window,
            copy_png_to_clipboard,
            save_png
        ])
        .run(tauri::generate_context!())
        .expect("error while running FAST");
}
