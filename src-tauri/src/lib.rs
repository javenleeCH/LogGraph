mod parser;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Rust 原生日志解析引擎（双通道架构，浏览器端不受影响；
        // 详见 plans/rust-parser-design.md）
        .invoke_handler(tauri::generate_handler![
            parser::parse_log,
            parser::parse_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
