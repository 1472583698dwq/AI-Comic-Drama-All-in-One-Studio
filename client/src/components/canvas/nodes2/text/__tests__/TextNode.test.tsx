import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { IconPhoto } from '@tabler/icons-react';
import { CanvasHostProvider, NodeSkeleton, defineNode, getNodeDef, nodeTypesMap, readOutputValue, type CanvasHost } from '../../../kit';
import { textNodeDef } from '../index';

/** REQ-toonflow-canvas N1：文本节点渲染冒烟（真实 <ReactFlow>，jsdom 补齐布局 API）。 */

beforeAll(() => {
  class RO {
    cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) { this.cb = cb; }
    observe(target: Element) { this.cb([{ target, contentRect: { width: 1000, height: 800 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver); }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', RO);
  class DMR { m22 = 1; constructor(t?: string) { const s = t?.match(/scale\(([\d.]+)\)/)?.[1]; this.m22 = s ? Number(s) : 1; } }
  vi.stubGlobal('DOMMatrixReadOnly', DMR);
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: { configurable: true, get() { return parseFloat((this as HTMLElement).style.height) || 100; } },
    offsetWidth: { configurable: true, get() { return parseFloat((this as HTMLElement).style.width) || 220; } },
  });
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 } as DOMRect);
  // tiptap / ProseMirror 在 jsdom 里需要的布局 API
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] } as unknown as DOMRectList);
  document.elementFromPoint = () => null;
});
afterEach(() => { cleanup(); });

// 上游图片（测试用）
function DemoImage(props: NodeProps) {
  return <NodeSkeleton node={props}><IconPhoto size={24} /></NodeSkeleton>;
}
defineNode({ type: 't-n1-image', label: '图片', icon: IconPhoto, category: 'image', component: DemoImage, inPalette: false, ports: [{ id: 'image', type: 'source', dataType: 'IMAGE' }] });

let latestNodes: Node[] = [];
function Canvas({ initial, edges: initialEdges = [], host = {} }: { initial: Node[]; edges?: Edge[]; host?: CanvasHost }) {
  const [nodes, , onNodesChange] = useNodesState(initial);
  const [edges, , onEdgesChange] = useEdgesState(initialEdges);
  latestNodes = nodes;
  return (
    <div style={{ width: 1000, height: 800 }}>
      <CanvasHostProvider value={host}>
        <ReactFlow className="cv-canvas" nodes={nodes} edges={edges} nodeTypes={nodeTypesMap()} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} />
      </CanvasHostProvider>
    </div>
  );
}
const mount = (initial: Node[], edges: Edge[] = [], host: CanvasHost = {}) => render(<ReactFlowProvider><Canvas initial={initial} edges={edges} host={host} /></ReactFlowProvider>);
const dataOf = (id: string) => latestNodes.find((n) => n.id === id)?.data as Record<string, unknown>;
const nodeEl = (container: HTMLElement, id: string) => container.querySelector(`.react-flow__node[data-id="${id}"] .cv-node`) as HTMLElement;

const DOC = '## 第一场\n雨夜，**霓虹**街道。';

describe('文本节点 prompt', () => {
  it('注册：类型 prompt、标题「文本」、宽 220、端口 in[VIDEO,IMAGE,STRING] → prompt[STRING]', () => {
    expect(getNodeDef('prompt')).toBe(textNodeDef);
    expect(textNodeDef.label).toBe('文本');
    expect(textNodeDef.width).toBe(220);
    expect(textNodeDef.ports).toEqual([
      { id: 'in', type: 'target', dataType: ['VIDEO', 'IMAGE', 'STRING'], label: '视频、图片、文本输入' },
      { id: 'prompt', type: 'source', dataType: 'STRING', label: '文本输出' },
    ]);
    // 下游取值读 data.prompt（= 节点显示的正文）
    expect(readOutputValue({ type: 'prompt', data: { prompt: DOC, text: DOC } }, 'prompt', 'STRING')).toBe(DOC);
  });

  it('未选中：标题 + Markdown 预览 + 编辑按钮；不显示浮层', async () => {
    const { container } = mount([{ id: 't1', type: 'prompt', position: { x: 0, y: 0 }, data: { label: '剧情', prompt: DOC, text: DOC } }]);
    await act(async () => {});
    const el = nodeEl(container, 't1');
    expect(el.style.width).toBe('220px');
    expect(el.querySelector('.cv-node__title')?.textContent).toContain('剧情');
    expect(Array.from(el.querySelectorAll('.cv-handle')).map((h) => h.getAttribute('data-handleid'))).toEqual(['in', 'prompt']);
    const preview = el.querySelector('.cv-text__preview') as HTMLElement;
    expect(preview.classList.contains('nowheel')).toBe(true);
    expect(preview.querySelector('h2')?.textContent).toBe('第一场');
    expect(preview.querySelector('strong')?.textContent).toBe('霓虹');
    expect(within(el).getByRole('button', { name: '编辑' })).toBeTruthy();
    expect(el.querySelector('.cv-node__slot')).toBeNull();
  });

  it('空正文：只显示居中的编辑按钮', async () => {
    const { container } = mount([{ id: 't1', type: 'prompt', position: { x: 0, y: 0 }, data: { ...textNodeDef.defaultData!() } }]);
    await act(async () => {});
    const body = nodeEl(container, 't1').querySelector('.cv-text') as HTMLElement;
    expect(body.classList.contains('is-empty')).toBe(true);
    expect(body.querySelector('.cv-text__preview')).toBeNull();
  });

  it('选中：工具栏（素材库 / 复制 / 下载 / 全屏）+ 提示词面板（参考、技能下拉）；发送走宿主 execute 并收尾 agent_state', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const execute = vi.fn().mockResolvedValue(undefined);
    const host: CanvasHost = { execute, saveToAssets: vi.fn() };
    const nodes: Node[] = [
      { id: 'img', type: 't-n1-image', position: { x: -400, y: 0 }, data: { image_url: 'http://x/a.png' } },
      { id: 't1', type: 'prompt', position: { x: 0, y: 0 }, selected: true, data: { label: '剧情', prompt: DOC, text: DOC, gen_prompt: '按 {{ref 1}} 的画面写一段旁白' } },
    ];
    const { container } = mount(nodes, [{ id: 'e1', source: 'img', sourceHandle: 'image', target: 't1', targetHandle: 'in' }], host);
    await act(async () => {});
    const el = nodeEl(container, 't1');
    const top = el.querySelector('.cv-node__slot--top') as HTMLElement;
    fireEvent.click(within(top).getByLabelText('添加到素材库'));
    expect(host.saveToAssets).toHaveBeenCalledWith('t1');
    fireEvent.click(within(top).getByLabelText('复制文本'));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith(DOC);
    expect(within(top).getByLabelText('全屏')).toHaveProperty('disabled', false);

    const bottom = el.querySelector('.cv-node__slot--bottom') as HTMLElement;
    expect(bottom.style.width).toBe('660px');
    expect(within(bottom).getAllByRole('listitem')).toHaveLength(1);
    const select = within(bottom).getByRole('button', { name: '生成源' });
    expect(select.textContent).toContain('自由生成');
    expect(bottom.querySelector('.cv-ref-chip')?.textContent).toContain('参考 1');

    fireEvent.click(bottom.querySelector('.cv-send') as HTMLElement);
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    const [nodeId, overrides] = execute.mock.calls[0];
    expect(nodeId).toBe('t1');
    expect(overrides).toMatchObject({
      skill_id: 'free_generation',
      prompt: '按 参考 1 的画面写一段旁白\n\n（参考编号对应：参考 1=第 1 张参考图）',
      gen_prompt: '按 {{ref 1}} 的画面写一段旁白',
      source_text: DOC,
      input_source: 'instruction',
      reference_images: ['http://x/a.png'],
    });
    await waitFor(() => expect((dataOf('t1').agent_state as { status: string }).status).toBe('completed'));
    // overrides 不落盘
    expect(dataOf('t1').prompt).toBe(DOC);
  });

  it('切换技能写 skill_id；宿主报错 → agent_state=failed 并在卡片上提示，可关闭', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('LLM 超时'));
    const { container } = mount([{ id: 't1', type: 'prompt', position: { x: 0, y: 0 }, selected: true, data: { prompt: DOC, text: DOC } }], [], { execute });
    await act(async () => {});
    const el = nodeEl(container, 't1');
    const bottom = el.querySelector('.cv-node__slot--bottom') as HTMLElement;
    // 自由生成 + 空提示词：不能发送
    expect((bottom.querySelector('.cv-send') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(bottom).getByRole('button', { name: '生成源' }));
    const list = await screen.findByRole('listbox', { name: '生成源' });
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['自由生成', '扩写', '剧本拆解', '策划案']);
    fireEvent.click(within(list).getByRole('option', { name: '扩写' }));
    await waitFor(() => expect(dataOf('t1').skill_id).toBe('prompt_expansion'));
    // 扩写：提示词为空时处理当前正文
    const send = nodeEl(container, 't1').querySelector('.cv-send') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute.mock.calls[0][1]).toMatchObject({ skill_id: 'prompt_expansion', input_source: 'document', prompt: DOC });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('LLM 超时');
    expect((dataOf('t1').agent_state as { status: string; error: string })).toMatchObject({ status: 'failed', error: 'LLM 超时' });
    fireEvent.click(within(alert).getByLabelText('关闭错误提示'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('agent_state=running（宿主 / Agent 在跑）：卡片转圈、编辑禁用；「不再等待」恢复', async () => {
    const { container } = mount([{ id: 't1', type: 'prompt', position: { x: 0, y: 0 }, data: { prompt: DOC, agent_state: { status: 'running', updated_at: new Date().toISOString() } } }]);
    await act(async () => {});
    const el = nodeEl(container, 't1');
    expect(within(el).getByRole('status', { name: '文本生成中' })).toBeTruthy();
    const edit = within(el).getByRole('button', { name: '编辑' }) as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    expect(edit.title).toBe('生成中，暂不能编辑');
    fireEvent.click(within(el).getByText('不再等待'));
    await waitFor(() => expect((dataOf('t1').agent_state as { status: string }).status).toBe('idle'));
    expect(within(nodeEl(container, 't1')).queryByRole('status', { name: '文本生成中' })).toBeNull();
  });

  it('B1 流式：agent_state.streaming 时显示正在增长的正文 + 角标，不盖整块转圈', async () => {
    const { container } = mount([{ id: 't1', type: 'prompt', position: { x: 0, y: 0 }, data: { prompt: '雨夜，霓虹', text: '雨夜，霓虹', agent_state: { status: 'running', streaming: true, updated_at: new Date().toISOString() } } }]);
    await act(async () => {});
    const el = nodeEl(container, 't1');
    expect(el.querySelector('.cv-text__running')).toBeNull();
    expect(el.querySelector('.cv-text__streaming')).toBeTruthy();
    expect(within(el).getByRole('status', { name: '文本生成中' })).toBeTruthy();
    expect(el.querySelector('.cv-text__preview')?.textContent).toContain('雨夜，霓虹');
    expect(el.querySelector('.cv-text__preview')?.getAttribute('aria-busy')).toBe('true');
    expect((within(el).getByRole('button', { name: '编辑' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('B1 停止生成：流式技能发送后发送键变「停止生成」，点了中止 overrides.signal；剧本拆解不可停止', async () => {
    let signal: AbortSignal | undefined;
    const execute = vi.fn((_id: string, ov?: Record<string, unknown>) => new Promise<void>((resolve) => {
      signal = ov?.signal as AbortSignal | undefined;
      signal?.addEventListener('abort', () => resolve());
    }));
    const { container } = mount([{ id: 't1', type: 'prompt', position: { x: 0, y: 0 }, selected: true, data: { prompt: DOC, text: DOC, gen_prompt: '写旁白' } }], [], { execute });
    await act(async () => {});
    const send = () => nodeEl(container, 't1').querySelector('.cv-send') as HTMLButtonElement;
    fireEvent.click(send());
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(signal).toBeInstanceOf(AbortSignal);
    await waitFor(() => expect(send().title).toBe('停止生成'));
    expect(send().disabled).toBe(false);
    // 首个增量到达前：等待模型响应（网关首字可能要等很久）
    expect(within(nodeEl(container, 't1')).getByRole('status', { name: '文本生成中' }).textContent).toContain('等待模型响应…');
    fireEvent.click(send());
    expect(signal!.aborted).toBe(true);
    await waitFor(() => expect(send().title).not.toBe('停止生成'));

    // 剧本拆解：不流式、不传 signal
    const exec2 = vi.fn().mockResolvedValue(undefined);
    cleanup();
    const r2 = mount([{ id: 't2', type: 'prompt', position: { x: 0, y: 0 }, selected: true, data: { prompt: DOC, text: DOC, skill_id: 'script_generation' } }], [], { execute: exec2 });
    await act(async () => {});
    fireEvent.click(nodeEl(r2.container, 't2').querySelector('.cv-send') as HTMLElement);
    await waitFor(() => expect(exec2).toHaveBeenCalledTimes(1));
    expect(exec2.mock.calls[0][1]).not.toHaveProperty('signal');
  });

  it('编辑弹窗：富文本可还原的正文用 tiptap；原文编辑回写 text + prompt 两键，预览跟着变', async () => {
    const { container } = mount([{ id: 't1', type: 'prompt', position: { x: 0, y: 0 }, data: { prompt: DOC, text: DOC } }]);
    await act(async () => {});
    fireEvent.click(within(nodeEl(container, 't1')).getByRole('button', { name: '编辑' }));
    const dialog = await screen.findByRole('dialog', { name: '编辑文本' });
    const rich = await within(dialog).findByRole('textbox', { name: '编辑文本内容' });
    expect(rich.querySelector('h2')?.textContent).toBe('第一场');
    // 编辑器一挂上工具条就可用（撤销 / 重做无历史时置灰）
    await waitFor(() => expect((within(dialog).getByRole('button', { name: '加粗' }) as HTMLButtonElement).disabled).toBe(false));
    expect((within(dialog).getByRole('button', { name: '撤销' }) as HTMLButtonElement).disabled).toBe(true);
    // 切到原文编辑
    fireEvent.click(within(dialog).getByRole('button', { name: '原文' }));
    const source = within(dialog).getByLabelText('编辑 Markdown 原文') as HTMLTextAreaElement;
    expect(source.value).toBe(DOC);
    fireEvent.change(source, { target: { value: '# 新标题\n[中景] 1girl_solo' } });
    await waitFor(() => expect(dataOf('t1')).toMatchObject({ text: '# 新标题\n[中景] 1girl_solo', prompt: '# 新标题\n[中景] 1girl_solo' }));
    // 预览 / 编辑切换
    fireEvent.click(within(dialog).getByRole('button', { name: '预览' }));
    expect(within(dialog).getByLabelText('文本内容').querySelector('h1')?.textContent).toBe('新标题');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(nodeEl(container, 't1').querySelector('.cv-text__preview h1')?.textContent).toBe('新标题');
  });

  it('富文本会改写的正文默认原文编辑并提示', async () => {
    const lossy = '| a | b |\n|-|-|\n| 1 | 2 |';
    const { container } = mount([{ id: 't1', type: 'prompt', position: { x: 0, y: 0 }, data: { prompt: lossy } }]);
    await act(async () => {});
    fireEvent.click(within(nodeEl(container, 't1')).getByRole('button', { name: '编辑' }));
    const dialog = await screen.findByRole('dialog', { name: '编辑文本' });
    expect(((await within(dialog).findByLabelText('编辑 Markdown 原文')) as HTMLTextAreaElement).value).toBe(lossy);
    expect(within(dialog).getByRole('note').textContent).toContain('已默认用原文编辑');
  });

  it('全屏：只读预览，可切到编辑', async () => {
    const { container } = mount([{ id: 't1', type: 'prompt', position: { x: 0, y: 0 }, selected: true, data: { label: '剧情', prompt: DOC } }]);
    await act(async () => {});
    fireEvent.click(within(nodeEl(container, 't1').querySelector('.cv-node__slot--top') as HTMLElement).getByLabelText('全屏'));
    const dialog = await screen.findByRole('dialog', { name: '剧情' });
    expect(dialog.classList.contains('is-fullscreen')).toBe(true);
    expect(within(dialog).getByRole('button', { name: '预览' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(dialog).getByLabelText('文本内容').querySelector('h2')?.textContent).toBe('第一场');
    fireEvent.click(within(dialog).getByRole('button', { name: '编辑' }));
    expect(await screen.findByRole('dialog', { name: '编辑文本' })).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog')).getByLabelText('关闭'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('焦点落在 body 时 Esc 也能关闭弹窗（模式切换卸载了被点的按钮）', async () => {
    const { container } = mount([{ id: 't1', type: 'prompt', position: { x: 0, y: 0 }, selected: true, data: { label: '剧情', prompt: DOC } }]);
    await act(async () => {});
    fireEvent.click(within(nodeEl(container, 't1').querySelector('.cv-node__slot--top') as HTMLElement).getByLabelText('全屏'));
    await screen.findByRole('dialog', { name: '剧情' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(container.querySelectorAll('.react-flow__node')).toHaveLength(1);
  });
});
