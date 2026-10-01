mod db;
mod parser;
mod raw_search;
mod sequence;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Rust 原生日志解析引擎（双通道架构，浏览器端不受影响；
        // 详见 plans/rust-parser-design.md）
        .invoke_handler(tauri::generate_handler![
            parser::parse_log,
            parser::parse_dir,
            parser::dir_lines_chunk,
            parser::dir_events_chunk,
            parser::dir_cache_drop,
            db::db_open,
            db::db_event_index_chunk,
            db::db_filter,
            db::db_filter_drop,
            db::db_events_in_window,
            db::db_context_lines,
            db::db_line,
            db::db_close,
            sequence::db_run_sequences
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
