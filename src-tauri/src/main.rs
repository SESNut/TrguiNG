// TrguiNG - next gen remote GUI for transmission torrent daemon
// Modified to support auto-close on external association add

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::{sync::Arc, time::Duration};

use createtorrent::CreationRequestsHandle;
use geoip::MmdbReaderHandle;
use poller::PollerHandle;
use tauri::{async_runtime, App, AppHandle, Listener, Manager, State, Emitter};
use tauri_plugin_cli::CliExt;
use tokio::sync::RwLock;
use torrentcache::TorrentCacheHandle;

mod commands;
mod createtorrent;
mod geoip;
mod integrations;
mod ipc;
#[cfg(target_os = "macos")]
mod macos;
mod poller;
mod sound;
mod torrentcache;
mod tray;

struct ListenerHandle(Arc<RwLock<ipc::Ipc>>);

#[cfg(target_os = "macos")]
fn handle_uris(app: &AppHandle, uris: Vec<String>) {
    let listener_state: State<ListenerHandle> = app.state();
    let listener_lock = listener_state.0.clone();
    let app_handle = app.clone();
    async_runtime::spawn(async move {
        let listener = listener_lock.read().await;
        if let Err(e) = listener.send(&uris, app_handle).await {
            println!("Unable to send args to listener: {:?}", e);
        }
    });
}

fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "macos")]
    {
        let app_handle = app.handle().clone();
        macos::set_handler(move |uris| {
            handle_uris(&app_handle, uris);
        })
        .expect("Unable to set apple event handler");
        macos::listen_url();
    }

    let mut torrents: Vec<String> = vec![];
    match app.cli().matches() {
        Ok(matches) => {
            if matches.args.contains_key("help") {
                println!("{}", matches.args["help"].value.as_str().unwrap());
                app.handle().exit(0);
                return Ok(());
            }

            if matches.args["torrent"].value.is_array() {
                torrents = matches.args["torrent"]
                    .value
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap().to_string())
                    .collect();
            }
        }
        Err(_) => {
            println!("Unable to read cli args");
            app.handle().exit(0);
        }
    }

    let app_handle: AppHandle = app.handle().clone();

    async_runtime::spawn(async move {
        let poller_state: State<PollerHandle> = app_handle.state();
        let mut poller = poller_state.0.lock().await;
        poller.set_app_handle(&app_handle);

        let listener_state: State<ListenerHandle> = app_handle.state();
        let listener_lock = listener_state.0.clone();

        let mut listener = listener_lock.write().await;
        listener.init().await;
        listener.listen(&app_handle).await.ok();

        if listener.listening {
            let listener_lock1 = listener_lock.clone();
            let _ = app_handle.listen("listener-start", move |_| {
                let listener_lock = listener_lock1.clone();
                async_runtime::spawn(async move {
                    let mut listener = listener_lock.write().await;
                    listener.start();
                });
            });
            let listener_lock2 = listener_lock.clone();
            let _ = app_handle.listen("listener-pause", move |_| {
                let listener_lock = listener_lock2.clone();
                async_runtime::spawn(async move {
                    let mut listener = listener_lock.write().await;
                    listener.pause().await;
                });
            });
            tray::toggle_main_window(&app_handle, None);
        }
        drop(listener);

        let app_clone = app_handle.clone();
        async_runtime::spawn(async move {
            let listener = listener_lock.read().await;
            
            // Check if we are actually adding something from the CLI
            let has_external_torrents = !torrents.is_empty();

            if let Err(e) = listener.send(&torrents, app_clone.clone()).await {
                println!("Unable to send args to listener: {e}");
            } else if has_external_torrents {
                // Emit event to frontend to signal an external add occurred
                let _ = app_clone.emit("close-after-external-add", ());
            }

            #[cfg(target_os = "macos")]
            {
                macos::listen_open_documents();
                macos::listen_reopen_app();
            }
        });

        let app_clone = app_handle.clone();
        app_handle.listen("app-exit", move |_| {
            println!("Exiting");
            let appc = app_clone.clone();
            let _ = app_clone.run_on_main_thread(move || {
                appc.cleanup_before_exit();
                std::process::exit(0);
            });
        });

        let app_clone = app_handle.clone();
        app_handle.listen("window-hidden", move |_| {
            tray::set_tray_showhide_text(&app_clone, "Show");
        })
    });

    Ok(())
}

static APP_USER_AGENT: &str = concat!(env!("CARGO_PKG_NAME"), "/", env!("CARGO_PKG_VERSION"));

pub struct HttpClients {
    pub default: reqwest::Client,
    pub insecure: reqwest::Client,
}

fn client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .user_agent(APP_USER_AGENT)
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(40))
        .timeout(Duration::from_secs(60))
}

fn http_clients() -> HttpClients {
    let default = client_builder()
        .build()
        .expect("Failed to initialize http client");

    let insecure = client_builder()
        .danger_accept_invalid_certs(true)
        .build()
        .expect("Failed to initialize insecure http client");

    HttpClients { default, insecure }
}

fn main() {
    let context = tauri::generate_context!();

    let app_builder = tauri::Builder::default()
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::remove_file,
            commands::shell_open,
            commands::set_poller_config,
            commands::app_integration,
            commands::get_file_stats,
            commands::create_torrent,
            commands::check_create_torrent,
            commands::cancel_create_torrent,
            commands::save_create_torrent,
            commands::pass_to_window,
            commands::list_system_fonts,
            commands::create_tray,
            commands::save_text_file,
            commands::load_text_file,
        ])
        .manage(ListenerHandle(Arc::new(RwLock::new(ipc::Ipc::new()))))
        .manage(TorrentCacheHandle::default())
        .manage(PollerHandle::default())
        .manage(MmdbReaderHandle::default())
        .manage(CreationRequestsHandle::default())
        .manage(http_clients())
        .setup(setup);

    #[cfg(target_os = "macos")]
    let app_builder = app_builder
        .menu(macos::make_menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "appquit" => {
                tray::exit(app.clone());
            }
            _ => {}
        });

    let app = app_builder
        .build(context)
        .expect("error while running tauri application");

    #[allow(clippy::single_match)]
    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            api.prevent_exit();
            tray::set_tray_showhide_text(app_handle, "Show");
        }
        _ => {}
    });
}
