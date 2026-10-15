mod engine_api;
mod parser;
mod ws;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        // Rust 原生日志解析引擎（双通道架构，浏览器端不受影响；
        // 详见 plans/rust-parser-design.md）
        .invoke_handler(tauri::generate_handler![
            parser::parse_log,
            parser::parse_dir,
            parser::dir_lines_chunk,
            parser::dir_events_chunk,
            parser::dir_cache_drop,
            ws::ws_info,
            ws::ws_filters,
            ws::ws_lines,
            ws::ws_line,
            ws::ws_sequences,
            ws::ws_reveal_path,
            ws::ws_open_path,
            engine_api::engine_search,
            engine_api::engine_run_cep,
            engine_api::engine_validate_rules,
            engine_api::engine_walk
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
