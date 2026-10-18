import { describe, expect, it } from 'vitest';
import { describeLoadMode } from './loadMode';

describe('describeLoadMode', () => {
  it('dbMode → 数据库模式（含直扫磁盘与时间列不可编辑边界）', () => {
    const info = describeLoadMode(true, true);
    expect(info.mode).toBe('db');
    expect(info.label).toBe('数据库模式');
    expect(info.summary).toContain('直扫磁盘');
    expect(info.boundaries.join('\n')).toContain('时间列不可编辑');
    expect(info.boundaries.join('\n')).toContain('无限上下文流');
  });

  it('桌面端非 dbMode → 内存模式（时间列可编辑、大文件建议走目录）', () => {
    const info = describeLoadMode(false, true);
    expect(info.mode).toBe('memory');
    expect(info.label).toBe('内存模式');
    expect(info.boundaries.join('\n')).toContain('可编辑');
    expect(info.boundaries.join('\n')).toContain('打开目录');
  });

  it('Web 端非 dbMode → Web 专用文案（目录浏览不可用、引导桌面版）', () => {
    const info = describeLoadMode(false, false);
    expect(info.mode).toBe('web');
    expect(info.label).toContain('Web');
    expect(info.boundaries.join('\n')).toContain('File System Access API');
    expect(info.boundaries.join('\n')).toContain('桌面版');
  });

  it('dbMode 优先于平台判定：Web 端理论上进入 dbMode 时仍报数据库模式', () => {
    const info = describeLoadMode(true, false);
    expect(info.mode).toBe('db');
  });

  it('三种模式的 label 互不相同（状态栏 pill 可一眼区分）', () => {
    const labels = new Set([
      describeLoadMode(true, true).label,
      describeLoadMode(false, true).label,
      describeLoadMode(false, false).label,
    ]);
    expect(labels.size).toBe(3);
  });
});
