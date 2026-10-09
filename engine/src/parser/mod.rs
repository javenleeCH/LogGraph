//! 日志解析：时间戳格式探测与提取（5 种格式，语义对齐前端 timestampFormats.ts）。
//! 纯函数、零数据库依赖。

pub mod timestamp;

pub use timestamp::{
    detect_timestamp_format, extract_timestamp, find_format, formats, TsFormat,
};
