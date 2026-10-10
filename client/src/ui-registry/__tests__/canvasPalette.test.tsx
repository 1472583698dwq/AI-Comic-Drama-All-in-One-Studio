import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { clearCanvasPaletteEntries, syncCanvasPaletteEntries } from '../adapters/canvasPalette';
import { CanvasPaletteBridgeContext } from '../canvasPaletteBridge';
import { allEntries } from '../registry';
import { UISlot } from '../UISlot';
import { CANVAS_PALETTE_HOST } from '../types';

/**
 * 设计 §12 桥接的第三个落地样本（`custom_nodes` + `canvas_nodes` 的画布调色板行）：
 *   · 规则 1 声明进注册表：两张清单 → 一批条目（`meta` 留原始声明），重声明即替换；
 *   · 规则 2 回调由宿主注入：条目只声明「创建哪种节点 + 数据」，位置/state/选中由 `createNode` 负责；
 *   · 拖拽载荷（`application/canvas-nodetype` / `canvas-nodeid`）是画布落地契约，由条目写。
 */

const CUSTOM = [{ id: 'upscale_demo', name: '视频超分', kind: 'video', language: 'python' }];
const EXT = [{ id: 'ext_upscale', name: '超分扩展节点', kind: 'utility', inputs: [{}, {}], outputs: [{}] }];

afterEach(() => {
  cleanup();
  clearCanvasPaletteEntries();
});

describe('§12 调色板：声明进注册表', () => {
  it('两张清单 → 两类条目（id / order / source / meta），先自定义后扩展', () => {
    syncCanvasPaletteEntries(CUSTOM, EXT);
    const rows = allEntries().filter((e) => e.host === CANVAS_PALETTE_HOST);
    expect(rows.map((e) => e.id)).toEqual(['canvas.palette.custom.upscale_demo', 'canvas.palette.ext.ext_upscale']);
    expect(rows.every((e) => e.kind === 'panel' && e.source === 'plugin:canvas')).toBe(true);
    expect(rows[1].order).toBeGreaterThan(rows[0].order);
    expect((rows[0].meta as any).customNode.id).toBe('upscale_demo');
    expect((rows[1].meta as any).canvasNodeSpec.id).toBe('ext_upscale');
  });

  it('重声明 = 替换（插件增删不留陈旧行）；清空后注册表里没有调色板条目', () => {
    syncCanvasPaletteEntries(CUSTOM, EXT);
    syncCanvasPaletteEntries([], EXT);
    expect(allEntries().filter((e) => e.host === CANVAS_PALETTE_HOST).map((e) => e.id))
      .toEqual(['canvas.palette.ext.ext_upscale']);
    clearCanvasPaletteEntries();
    expect(allEntries().filter((e) => e.host === CANVAS_PALETTE_HOST)).toHaveLength(0);
  });
});

describe('§12 调色板：回调由宿主注入', () => {
  it('点自定义节点行 → createNode("custom", { custom_node_id })', () => {
    const createNode = vi.fn();
    syncCanvasPaletteEntries(CUSTOM, []);
    render(
      <CanvasPaletteBridgeContext.Provider value={{ createNode }}>
        <UISlot host={CANVAS_PALETTE_HOST} />
      </CanvasPaletteBridgeContext.Provider>,
    );
    fireEvent.click(screen.getByText('视频超分'));
    expect(createNode).toHaveBeenCalledWith('custom', { custom_node_id: 'upscale_demo' });
  });

  it('点扩展节点行 → createNode("ext-node", { canvas_node_id, definition })（definition 是整份声明）', () => {
    const createNode = vi.fn();
    syncCanvasPaletteEntries([], EXT);
    render(
      <CanvasPaletteBridgeContext.Provider value={{ createNode }}>
        <UISlot host={CANVAS_PALETTE_HOST} />
      </CanvasPaletteBridgeContext.Provider>,
    );
    fireEvent.click(screen.getByText('超分扩展节点'));
    expect(createNode).toHaveBeenCalledWith('ext-node', { canvas_node_id: 'ext_upscale', definition: EXT[0] });
  });

  it('拖拽写画布落地契约的两个键（type / nodeid）', () => {
    syncCanvasPaletteEntries([], EXT);
    render(<UISlot host={CANVAS_PALETTE_HOST} />);
    const setData = vi.fn();
    fireEvent.dragStart(screen.getByText('超分扩展节点'), { dataTransfer: { setData } });
    expect(setData).toHaveBeenCalledWith('application/canvas-nodetype', 'ext-node');
    expect(setData).toHaveBeenCalledWith('application/canvas-nodeid', 'ext_upscale');
  });

  it('宿主外渲染（无 Provider）不崩：回调退化为空实现', () => {
    syncCanvasPaletteEntries(CUSTOM, []);
    render(<UISlot host={CANVAS_PALETTE_HOST} />);
    fireEvent.click(screen.getByText('视频超分'));
    expect(screen.getByText('视频超分')).toBeTruthy();
  });

  it('本宿主仍由槽位自动标注（不是覆盖层/网格宿主，标注落在槽位包裹层上）', () => {
    syncCanvasPaletteEntries(CUSTOM, []);
    render(<UISlot host={CANVAS_PALETTE_HOST} />);
    const row = screen.getByText('视频超分');
    expect(row.closest('[data-ui-mark]')?.getAttribute('data-ui-mark')).toBe('canvas.palette.custom.upscale_demo');
  });
});
