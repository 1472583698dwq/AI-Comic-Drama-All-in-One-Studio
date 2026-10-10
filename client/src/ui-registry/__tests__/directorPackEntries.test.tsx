import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { clearDirectorPackEntries, syncDirectorPackEntries } from '../adapters/directorPackEntries';
import { DirectorPackBridgeContext } from '../directorPackBridge';
import { allEntries } from '../registry';
import { UISlot } from '../UISlot';
import { DIRECTOR_ENVS_HOST, DIRECTOR_PROPS_HOST } from '../types';
import type { DirectorPackEnv, DirectorPackProp } from '../../components/director3d/directorPackSpecs';

/**
 * 设计 §12 桥接的第四个落地样本（`director_packs` 的 props / environments，§12.4-4）：
 *   · 规则 1 声明进注册表：两类声明 → 两批条目（`meta` 留原始声明），重声明即替换；
 *   · 规则 2 回调由宿主注入：条目只报 id，`toggleProp` / `applyEnvironment` / 选中态都由
 *     `DirectorPackBridgeContext` 来（「按下之后发生什么」只有持有场景与镜头的舞台知道）；
 *   · 规则 3 grid 宿主自标：标记落在按钮自身（槽位不加包裹层）。
 *
 * 边界：`director_packs.presets` **有意不进注册表**（同源数组的数据合并，不是 UI 挂载点），
 * 所以这里不涉及 —— 见 `directorPackSpecs.ts` 顶部注释。
 */

const PROPS: DirectorPackProp[] = [{ id: 'spirit_fruit', label: '灵果', icon: '🥑', glb_url: '/models/Avocado.glb', scale: 1 }];
const ENVS: DirectorPackEnv[] = [{ id: 'bamboo', label: '竹林', desc: '青翠竹海远景', icon: '🎋', background_url: '/storage/assets/x.png' }];

afterEach(() => {
  cleanup();
  clearDirectorPackEntries();
});

describe('§12 导演包：声明进注册表', () => {
  it('道具与环境各落一个挂载点（id / order / source / meta）', () => {
    syncDirectorPackEntries(PROPS, ENVS);
    const props = allEntries().filter((e) => e.host === DIRECTOR_PROPS_HOST);
    const envs = allEntries().filter((e) => e.host === DIRECTOR_ENVS_HOST);
    expect(props.map((e) => e.id)).toEqual(['director3d.props.spirit_fruit']);
    expect(envs.map((e) => e.id)).toEqual(['director3d.env.bamboo']);
    expect([...props, ...envs].every((e) => e.kind === 'panel' && e.source === 'plugin:director-pack')).toBe(true);
    expect((props[0].meta as any).packProp.glb_url).toBe('/models/Avocado.glb');
    expect((envs[0].meta as any).packEnv.background_url).toBe('/storage/assets/x.png');
  });

  it('重声明 = 替换（插件增删不留陈旧行）；清空后注册表里没有导演包条目', () => {
    syncDirectorPackEntries(PROPS, ENVS);
    syncDirectorPackEntries([], ENVS);
    expect(allEntries().filter((e) => e.host === DIRECTOR_PROPS_HOST)).toHaveLength(0);
    expect(allEntries().filter((e) => e.host === DIRECTOR_ENVS_HOST)).toHaveLength(1);
    clearDirectorPackEntries();
    expect(allEntries().filter((e) => e.id.startsWith('director3d.')).length).toBe(0);
  });
});

describe('§12 导演包：回调由宿主注入', () => {
  const bridge = (over: Partial<React.ContextType<typeof DirectorPackBridgeContext>> = {}) => ({
    toggleProp: vi.fn(),
    isPropOn: () => false,
    applyEnvironment: vi.fn(),
    activeEnvironmentId: '',
    ...over,
  });

  it('道具行：点按只把 id 交给宿主的 toggleProp；选中态读 isPropOn', () => {
    const b = bridge();
    syncDirectorPackEntries(PROPS, []);
    const { rerender } = render(
      <DirectorPackBridgeContext.Provider value={b}>
        <UISlot host={DIRECTOR_PROPS_HOST} />
      </DirectorPackBridgeContext.Provider>,
    );
    expect(screen.getByText('灵果')).toBeTruthy();
    expect(screen.getByText('Avocado.glb')).toBeTruthy(); // 子标题取 glb 文件名（与改造前一致）
    fireEvent.click(screen.getByText('灵果'));
    expect(b.toggleProp).toHaveBeenCalledWith('spirit_fruit');

    rerender(
      <DirectorPackBridgeContext.Provider value={{ ...b, isPropOn: (id: string) => id === 'spirit_fruit' }}>
        <UISlot host={DIRECTOR_PROPS_HOST} />
      </DirectorPackBridgeContext.Provider>,
    );
    expect(screen.getByText('灵果').closest('button')!.className).toContain('border-brand');
  });

  it('环境行：点按只把 id 交给 applyEnvironment；选中态读 activeEnvironmentId', () => {
    const b = bridge();
    syncDirectorPackEntries([], ENVS);
    const { rerender } = render(
      <DirectorPackBridgeContext.Provider value={b}>
        <UISlot host={DIRECTOR_ENVS_HOST} />
      </DirectorPackBridgeContext.Provider>,
    );
    expect(screen.getByText('竹林')).toBeTruthy();
    fireEvent.click(screen.getByText('竹林'));
    expect(b.applyEnvironment).toHaveBeenCalledWith('bamboo');

    rerender(
      <DirectorPackBridgeContext.Provider value={{ ...b, activeEnvironmentId: 'bamboo' }}>
        <UISlot host={DIRECTOR_ENVS_HOST} />
      </DirectorPackBridgeContext.Provider>,
    );
    expect(screen.getByText('竹林').closest('button')!.className).toContain('border-accent-green');
  });

  it('宿主外渲染（没有 Provider）不崩：回调退化为空实现，行照常渲染', () => {
    syncDirectorPackEntries(PROPS, ENVS);
    render(<UISlot host={DIRECTOR_PROPS_HOST} />);
    fireEvent.click(screen.getByText('灵果'));
    expect(screen.getByText('灵果')).toBeTruthy();
  });

  it('grid 宿主自标：标记就是按钮自身（没有槽位包裹层）', () => {
    syncDirectorPackEntries(PROPS, []);
    render(<UISlot host={DIRECTOR_PROPS_HOST} />);
    const marked = document.querySelector('[data-ui-mark="director3d.props.spirit_fruit"]');
    expect(marked).toBeTruthy();
    expect(marked!.tagName).toBe('BUTTON'); // 标记落在按钮上，不是外层 div
    expect(marked!.parentElement?.hasAttribute('data-ui-mark')).toBe(false);
  });
});
