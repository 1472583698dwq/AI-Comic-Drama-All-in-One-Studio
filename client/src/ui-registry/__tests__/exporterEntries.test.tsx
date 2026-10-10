import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { clearExporterEntries, syncExporterEntries } from '../adapters/exporterEntries';
import { ExportBridgeContext } from '../exportBridge';
import { allEntries, register } from '../registry';
import { UISlot } from '../UISlot';
import { EXPORTER_ROWS_HOST } from '../types';
import type { ExporterInfo } from '../../services/exporterSpecs';

/**
 * 设计 §12 桥接的第二个落地样本（`exporters` 扩展点）：
 *   · 规则 1 **声明进注册表**：每个导出器是一条条目，列表替换时不留旧行；
 *   · 规则 2 **回调由宿主注入**：条目只报 id，`runExport` / 忙碌态 / 结果都从 `ExportBridgeContext` 来，
 *     宿主外渲染退化为空实现（因此可单测、不崩）；
 *   · 规则 3 **布局敏感宿主自标**：`modal.export` 是 grid 宿主，槽位不加包裹层，标记落在行卡片自己身上。
 */

const SPECS: ExporterInfo[] = [
  { id: 'srt_demo', name: 'SRT 字幕', description: '导出字幕', run: { extension: 'mcp_tool:foo' } },
  { id: 'ffmpeg_demo', name: 'FFmpeg 命令', run: { extension: 'custom_node:bar' } },
];

afterEach(() => {
  cleanup();
  clearExporterEntries();
});

describe('§12 导出器桥接：声明进注册表', () => {
  it('每个导出器一条条目（host / kind / order / meta / source）', () => {
    syncExporterEntries(SPECS);
    const rows = allEntries().filter((e) => e.host === EXPORTER_ROWS_HOST);
    expect(rows.map((e) => e.id)).toEqual(['exporter.srt_demo', 'exporter.ffmpeg_demo']);
    expect(rows.every((e) => e.kind === 'panel' && e.source === 'plugin:exporter')).toBe(true);
    expect((rows[0].meta as any).exporter.id).toBe('srt_demo');
    expect(rows[1].order).toBeGreaterThan(rows[0].order);
  });

  it('重跑一次同步 = 列表被替换（插件增删不留陈旧行）', () => {
    syncExporterEntries(SPECS);
    syncExporterEntries([SPECS[1]]);
    const rows = allEntries().filter((e) => e.host === EXPORTER_ROWS_HOST);
    expect(rows.map((e) => e.id)).toEqual(['exporter.ffmpeg_demo']);
  });

  it('清空（宿主关闭 / 卸载）后注册表里没有导出器条目', () => {
    syncExporterEntries(SPECS);
    clearExporterEntries();
    expect(allEntries().filter((e) => e.host === EXPORTER_ROWS_HOST)).toHaveLength(0);
  });

  it('按来源回滚且限定作用域（第 9 条 / L8）：只清 `modal.export`，不动别的挂载点', () => {
    // 同一来源但挂在别的 host 上的条目（模拟将来别的模块也用 plugin:exporter）
    const undoOther = register({
      id: 'exporter.other.host', kind: 'panel', host: 'other.host', order: 1,
      source: 'plugin:exporter', render: () => null,
    });
    syncExporterEntries(SPECS);
    clearExporterEntries();

    expect(allEntries().filter((e) => e.host === EXPORTER_ROWS_HOST)).toHaveLength(0);
    expect(allEntries().some((e) => e.host === 'other.host')).toBe(true); // 别的挂载点不受影响
    undoOther();
  });
});

describe('§12 导出器桥接：回调由宿主注入', () => {
  it('点「运行导出」把 id 交给宿主的 runExport；忙碌与结果由桥接驱动', () => {
    const runExport = vi.fn();
    syncExporterEntries([SPECS[0]]);
    const { rerender } = render(
      <ExportBridgeContext.Provider value={{ runExport, busyId: '', results: {} }}>
        <UISlot host={EXPORTER_ROWS_HOST} />
      </ExportBridgeContext.Provider>,
    );
    expect(screen.getByText('SRT 字幕')).toBeTruthy();
    fireEvent.click(screen.getByText('运行导出'));
    expect(runExport).toHaveBeenCalledWith('srt_demo');

    rerender(
      <ExportBridgeContext.Provider value={{ runExport, busyId: 'srt_demo', results: {} }}>
        <UISlot host={EXPORTER_ROWS_HOST} />
      </ExportBridgeContext.Provider>,
    );
    const busyBtn = screen.getByText('执行中…') as HTMLButtonElement;
    expect(busyBtn.disabled).toBe(true);

    rerender(
      <ExportBridgeContext.Provider value={{ runExport, busyId: '', results: { srt_demo: { file_url: '/storage/x.srt' } } }}>
        <UISlot host={EXPORTER_ROWS_HOST} />
      </ExportBridgeContext.Provider>,
    );
    expect(screen.getByText(/下载 \/ 预览/)).toBeTruthy();

    rerender(
      <ExportBridgeContext.Provider value={{ runExport, busyId: '', results: { srt_demo: { error: '导出失败：磁盘满' } } }}>
        <UISlot host={EXPORTER_ROWS_HOST} />
      </ExportBridgeContext.Provider>,
    );
    expect(screen.getByText(/导出失败：磁盘满/)).toBeTruthy();
  });

  it('宿主外渲染（没有 Provider）不崩：回调退化为空实现，行照常渲染', () => {
    syncExporterEntries([SPECS[0]]);
    render(<UISlot host={EXPORTER_ROWS_HOST} />);
    fireEvent.click(screen.getByText('运行导出'));
    expect(screen.getByText('SRT 字幕')).toBeTruthy();
  });

  it('条目自标：标记落在行卡片自身（grid 宿主不加包裹层）', () => {
    syncExporterEntries([SPECS[0]]);
    render(<UISlot host={EXPORTER_ROWS_HOST} />);
    const marked = document.querySelector('[data-ui-mark="exporter.srt_demo"]');
    expect(marked).toBeTruthy();
    expect(marked!.textContent).toContain('SRT 字幕');
    expect(marked!.parentElement?.hasAttribute('data-ui-mark')).toBe(false);
  });
});
