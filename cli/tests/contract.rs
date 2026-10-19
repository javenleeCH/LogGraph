//! CLI 契约测试（P1-1）：用真实二进制 + sample/ 数据守护 AGENT.md §6 冒烟命令面。
//!
//! 分工：契约层只测「退出码语义（0/1/2/3）+ JSON 信封形状 + 子命令面」，
//! 具体故事线数值验收由 `scripts/verify-samples.mjs`（CI test:samples）负责，
//! 二者不重复。
//!
//! 说明：本文件需 Rust 工具链编译（本地 Linux 无 cargo，由 CI rust job 兜底）。

use assert_cmd::Command;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Output;

/// workspace 根（cli 包的上一级），保证相对路径 `sample/...` 生效。
fn ws_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn bin() -> Command {
    let mut c = Command::cargo_bin("loggraph").expect("cargo bin 'loggraph' 应可解析");
    c.current_dir(ws_root());
    c
}

fn run(args: &[&str]) -> Output {
    bin().args(args).output().expect("CLI 子进程应启动")
}

/// stdout 解析为 JSON（成功路径）
fn json(args: &[&str]) -> Value {
    let out = run(args);
    assert_eq!(out.status.code(), Some(0), "args {args:?} 应退出码 0\nstderr:{}", String::from_utf8_lossy(&out.stderr));
    serde_json::from_slice(&out.stdout).unwrap_or_else(|e| {
        panic!("args {args:?} stdout 应为 JSON: {e}\n{}", String::from_utf8_lossy(&out.stdout))
    })
}

#[test]
fn parse_file_springboot_thread_format() {
    // 契约 §5 解析信封：{events:[{thread,level,message,ts,...}]}
    let r = json(&["parse", "file", "sample/springboot/order-service.log"]);
    let evs = r["events"].as_array().unwrap();
    assert_eq!(evs.len(), 25, "springboot 25 行全部解析");
    let with_thread = evs.iter().filter(|e| !e["raw"].as_str().unwrap_or("").trim().is_empty())
        .filter(|e| e["thread"].is_string() && !e["thread"].as_str().unwrap().is_empty())
        .count();
    assert_eq!(with_thread, 25, "springboot 25/25 提取到 thread");
    // parse file 单文件不带 sourceFile（仅 parse dir 多文件带）
    assert!(evs.iter().all(|e| e["thread"].is_string()));
}

#[test]
fn parse_file_log4j2_variant_format() {
    let r = json(&["parse", "file", "sample/log4j2/legacy-service.log"]);
    let evs = r["events"].as_array().unwrap();
    assert_eq!(evs.len(), 15, "log4j2 15 行全部解析");
}

#[test]
fn parse_dir_full_multifile_identity() {
    // 契约：parse dir --full 多文件会话，事件带 sourceFile 身份
    let r = json(&["parse", "dir", "sample/distributed", "--full"]);
    let evs: Vec<_> = r["events"].as_array().unwrap().iter()
        .filter(|e| !e["raw"].as_str().unwrap_or("").trim().is_empty())
        .collect();
    assert_eq!(evs.len(), 19, "distributed 三服务共 19 事件");
    assert!(evs.iter().all(|e| e["sourceFile"].as_str().map(|s| !s.is_empty()).unwrap_or(false)),
        "每事件带 sourceFile");
    // 关联键原料：raw 均含 traceId（对齐 verify-samples 口径）
    assert!(evs.iter().all(|e| e["raw"].as_str().map(|s| s.contains("traceId=")).unwrap_or(false)),
        "每行 raw 含 traceId");
}

#[test]
fn cep_thread_scope_runs_and_shapes() {
    // 契约 §5.2 信封：{response:{results:{<groupId>:{chains,...}}}}
    let r = json(&["cep", "sample/springboot/order-service.log", "-R",
                   "sample/cep-rules-thread.example.json", "--json"]);
    let results = &r["response"]["results"];
    let recovery = &results["recovery"];
    assert_eq!(recovery["chains"].as_array().unwrap().len(), 1, "recovery 恰 1 链");
    assert_eq!(recovery["chains"][0]["thread"].as_str(), Some("http-nio-8080-exec-1"));
    // 链步形状：reset→retry→done
    let steps: Vec<&str> = recovery["chains"][0]["steps"].as_array().unwrap()
        .iter().map(|s| s["filterId"].as_str().unwrap()).collect();
    assert_eq!(steps, vec!["reset", "retry", "done"]);
    // healthy 3 链
    assert_eq!(results["healthy"]["chains"].as_array().unwrap().len(), 3);
}

#[test]
fn cep_key_scope_bucket_isolates() {
    let r = json(&["cep", "sample/distributed", "-R", "sample/cep-rules-key.example.json", "--json"]);
    let key = &r["response"]["results"]["trace-failure"];
    assert_eq!(key["chains"].as_array().unwrap().len(), 2, "key 恰 2 链");
    // 桶隔离：每条链所有步骤同属一个 traceId（步骤可回退到链级 traceId，对齐 verify-samples）
    for c in key["chains"].as_array().unwrap() {
        let ct = c.get("traceId").and_then(|v| v.as_str());
        let traces: Vec<&str> = c["steps"].as_array().unwrap().iter()
            .map(|s| s.get("traceId").and_then(|v| v.as_str()).or(ct).unwrap_or(""))
            .collect();
        let uniq: std::collections::HashSet<&str> = traces.iter().copied().collect();
        assert_eq!(uniq.len(), 1, "链步骤须同属一个 traceId: {traces:?}");
    }
    // keyStats 质量指纹
    let expected: Value = json!({ "totalEvents": 13, "withKey": 13, "distinctKeys": 5 });
    assert_eq!(key.get("keyStats"), Some(&expected));
    // 对照组：global 无 keyStats（keyStats 字段缺省 → Null）
    let glob = &r["response"]["results"]["trace-failure-global-contrast"];
    assert!(glob["keyStats"].is_null(), "global 对照无 keyStats");
}

#[test]
fn validate_contract_exit_codes_and_json() {
    // 合法规则 → 退出 0，valid，0 错 0 警
    let ok = json(&["validate", "sample/cep-rules-key.example.json", "--json"]);
    assert_eq!(ok["valid"].as_bool(), Some(true));
    assert_eq!(ok["errors"].as_array().unwrap().len(), 0);
    assert_eq!(ok["warnings"].as_array().unwrap().len(), 0);

    // S12 关联键闸门：scope=key 缺 keyPattern → 退出 1，errors 含 S12
    let dir = std::env::temp_dir().join("loggraph-contract-s12.json");
    std::fs::write(&dir, r#"{"filters":[{"id":"a","pattern":"x"}],
        "groups":[{"groupId":"g","scope":"key","filterIds":["a"],"edges":[]}]}"#).unwrap();
    let out = run(&["validate", dir.to_str().unwrap(), "--json"]);
    assert_eq!(out.status.code(), Some(1), "S12 违规应退出码 1");
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["valid"].as_bool(), Some(false));
    assert!(v["errors"].as_array().unwrap().iter()
        .any(|e| e["rule"] == "S12"));
    let _ = std::fs::remove_file(&dir);

    // 文件不存在 → 退出码 2（E_* 错误）
    let out = run(&["validate", "sample/does-not-exist.json", "--json"]);
    assert_eq!(out.status.code(), Some(2), "缺文件应退出码 2");
}

#[test]
fn schema_cep_contract_synced() {
    let r = json(&["schema", "cep"]);
    let group = &r["$defs"]["group"];
    let scope = &group["properties"]["scope"]["enum"];
    assert!(scope.as_array().unwrap().iter().any(|v| v.as_str() == Some("key")), "scope enum 含 key");
    assert!(group["properties"]["keyPattern"].is_object(), "group 含 keyPattern 属性");
}

#[test]
fn search_json_envelope_and_hits() {
    // 契约 §5.1：{files, stats} 信封；命中 > 0 → 退出 0
    let r = json(&["search", "sample/sample.log", "Connection reset", "--json"]);
    assert!(r["files"].is_array());
    assert!(r["stats"].is_object());
    // 无命中 → 退出码 1
    let out = run(&["search", "sample/sample.log", "this-pattern-matches-nothing-xyz", "--json"]);
    assert_eq!(out.status.code(), Some(1), "无命中应退出码 1");
}

#[test]
fn ws_info_files_contract() {
    // ws info 产出 ctx（唯一付整读价入口）：信封含 files/stats
    let ctx = run(&["ws", "info", "sample", "--file", "sample.log"]);
    assert_eq!(ctx.status.code(), Some(0));
    let ctx_json: Value = serde_json::from_slice(&ctx.stdout).unwrap();
    assert!(ctx_json["files"].is_array(), "ctx 信封含 files");
    assert!(ctx_json["totalLines"].is_u64(), "ctx 含 totalLines");
    assert!(ctx_json["fileCount"].is_u64(), "ctx 含 fileCount");

    // ws files：文件清单（命令面 `ws files <DIR>`，无 --file 参数）
    let r = json(&["ws", "files", "sample"]);
    let files = r.as_array().expect("ws files 返回数组");
    assert!(!files.is_empty(), "sample 目录有文件");
    assert!(files.iter().all(|f| f["name"].is_string() && f["path"].is_string()),
        "每项含 name/path");
}

#[test]
fn ws_filters_default_ctx_rebuild() {
    // 缺省 --ctx = 内部重建 ctx（付整读价），命令面与结果形状仍成立
    let r = json(&["ws", "filters", "sample", "-q", "sample/filters-crossline.example.json"]);
    let filters = r["filters"].as_array().unwrap();
    assert!(!filters.is_empty());
    let by_id: std::collections::HashMap<&str, &Value> =
        filters.iter().map(|f| (f["filterId"].as_str().unwrap(), f)).collect();
    assert!(by_id.contains_key("reset-104-only"), "聚合条目可见");
    assert!(by_id.contains_key("reset-104-only\u{0}0"), "子条件条目可见（契约 §3.14 缓存表示）");
}
