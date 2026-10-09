//! cargo run -p loggraph-engine --example walk_list -- <目录> [--no-ignore] [--hidden]
use loggraph_engine::search::{walk, WalkOptions};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let root = args.get(1).cloned().unwrap_or_else(|| ".".into());
    let opts = WalkOptions {
        no_ignore: args.iter().any(|a| a == "--no-ignore"),
        hidden: args.iter().any(|a| a == "--hidden"),
        ..Default::default()
    };
    match walk(std::path::Path::new(&root), &opts) {
        Ok(files) => {
            for f in &files {
                println!("{}", f.display());
            }
            eprintln!("共 {} 个文件", files.len());
        }
        Err(e) => eprintln!("错误: {e}"),
    }
}
