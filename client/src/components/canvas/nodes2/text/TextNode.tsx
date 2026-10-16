// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N1 文本节点 `prompt`（对照 Toonflow packages/nodes/textNode/src/index.vue）。
 *
 * 卡片：Markdown 渲染预览（最高 240、可滚动）+「编辑」按钮 → 文本弹窗（预览 ⇄ 编辑，tiptap 富文本 / 原文）；
 * 上方浮动工具栏：添加到素材库 ｜ 复制文本 · 下载 .md · 全屏阅读；
 * 下方提示词面板（kit PromptPanel）：参考列表 + `{{ref N}}` 提示词 + 技能下拉（替换 Toonflow 的模型下拉）+ 发送。
 * 技能执行经 useKitNodeActions(id).execute(overrides) 交给宿主原有分支（键见 skills.TextExecuteOverrides）；
 * 自由生成 / 扩写 / 策划案由宿主流式写回正文（B1，agent_state.streaming）：正文边生成边显示，发送键变「停止生成」
 * （overrides.signal 中止，保留已生成部分）；剧本拆解不流式，生成中整块转圈，完成后整段替换。颜色只用 --cv-* 变量（text.css）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { useReactFlow, type NodeProps } from '@xyflow/react';
import { IconCheck, IconCopy, IconEdit, IconLoader2, IconX } from '@tabler/icons-react';
import {
  FloatingToolbar, NodeSkeleton, PromptPanel, ToolbarButton, refName, useKitNodeActions, useNodeReferences,
  type GenSourceOption, type PortDef, type RefItem,
} from '../../kit';
import { MarkdownPreview } from './MarkdownPreview';
import { TextDocumentDialog, type TextDialogMode } from './TextDocumentDialog';
import { copyText } from './clipboard';
import {
  GEN_PROMPT_KEY, STREAMING_SKILLS, TEXT_SKILLS, buildSkillRequest, documentOf, documentPatch, isRunningState, markdownFileName, skillOf,
  type TextNodeData,
} from './skills';
import './text.css';

export const TEXT_NODE_TYPE = 'prompt';

/** 端口：输出口 id 沿用存量连线的 `prompt`（COORDINATION 第 1 条），输入口为单一 `in`（同 Toonflow textNode）。 */
export const TEXT_NODE_PORTS: PortDef[] = [
  { id: 'in', type: 'target', dataType: ['VIDEO', 'IMAGE', 'STRING'], label: '视频、图片、文本输入' },
  { id: 'prompt', type: 'source', dataType: 'STRING', label: '文本输出' },
];

/** Toonflow textNode 沿用 nodeSkeleton 默认宽 220。 */
export const TEXT_NODE_WIDTH = 220;

const SKILL_OPTIONS: GenSourceOption[] = TEXT_SKILLS.map((s) => ({ id: s.id, label: s.label, group: s.group, description: s.description }));
const PROMPT_KEYS = [GEN_PROMPT_KEY];
const stop = (e: SyntheticEvent) => e.stopPropagation();

type DialogState =
  | { kind: 'doc'; mode: TextDialogMode; fullscreen: boolean }
  | { kind: 'ref'; title: string; value: string; fullscreen: boolean };

function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return (msg || '生成失败').slice(0, 220);
}

export function TextNode(props: NodeProps) {
  const { id, selected } = props;
  const data = (props.data || {}) as TextNodeData;
  const rf = useReactFlow();
  const actions = useKitNodeActions(id);
  const { refs, moveRef, removeRef } = useNodeReferences(id, { promptKeys: PROMPT_KEYS });

  const doc = documentOf(data);
  const hasDoc = doc.trim().length > 0;
  const instruction = typeof data.gen_prompt === 'string' ? data.gen_prompt : '';
  const skill = skillOf(data.skill_id);
  const request = useMemo(
    () => buildSkillRequest({ skillId: skill.id, instruction, document: doc, refs, refRoles: data.refRoles }),
    [skill.id, instruction, doc, refs, data.refRoles],
  );

  // —— 运行态 / 错误：来自 data.agent_state（宿主写；宿主分支没写时节点自己收尾）——
  const [pending, setPending] = useState(false);
  const state = data.agent_state ?? null;
  const running = pending || isRunningState(state);
  // B1：宿主流式写回正文中——显示正在增长的正文（不盖整块转圈），预览自动滚到底
  const streaming = running && state?.status === 'running' && state.streaming === true;
  // 本页面发起、可中止的流式运行：发送键变「停止生成」
  const abortRef = useRef<AbortController | null>(null);
  const [stoppable, setStoppable] = useState(false);
  // 流式技能发出后、首个增量到达前（网关首字可能要等 70–80 秒）：显示「等待模型响应…」
  const waitingFirstDelta = pending && stoppable && !streaming;
  const previewBoxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!streaming) return;
    const el = previewBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [streaming, doc]);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const failure = state?.status === 'failed' ? (state.error || '生成失败') : null;
  const failureKey = failure ? `${state?.updated_at ?? ''}|${failure}` : null;
  const showFailure = !!failure && !running && failureKey !== dismissed;
  const aliveRef = useRef(true);
  // REQ-toonflow-canvas H1：StrictMode 下 effect 会先卸载再挂载，挂载时要把标记复位（否则发送后「生成中」一直不消失）
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);

  const send = useCallback(async () => {
    if (running || !request.ok) return;
    const startedAt = new Date().toISOString();
    const tool = `text/${request.skill.id}`;
    // 宿主写过（比本次开始更新、且不是本节点写的 running 标记）就不再覆盖
    const hostTouched = () => {
      const st = (rf.getNode(id)?.data as TextNodeData | undefined)?.agent_state;
      return !!st?.updated_at && st.updated_at >= startedAt && !(st.status === 'running' && st.updated_at === startedAt && st.tool === tool);
    };
    setPending(true);
    setDismissed(null);
    actions.update({ agent_state: { status: 'running', tool, updated_at: startedAt } });
    const ctrl = STREAMING_SKILLS.has(request.skill.id) && typeof AbortController !== 'undefined' ? new AbortController() : null;
    abortRef.current = ctrl;
    setStoppable(!!ctrl);
    try {
      // REQ-toonflow-canvas 宿主按 skill_id 路由（键见 skills.TextExecuteOverrides / progress/N1.md）；
      // signal 只用于「停止生成」，宿主不会把它写进节点或请求体
      await actions.execute(ctrl ? { ...request.overrides, signal: ctrl.signal } : request.overrides);
      if (!hostTouched()) actions.update({ agent_state: { status: 'completed', tool, updated_at: new Date().toISOString() } });
    } catch (e) {
      if (!hostTouched()) actions.update({ agent_state: { status: 'failed', tool, error: errorMessage(e), updated_at: new Date().toISOString() } });
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      if (aliveRef.current) { setPending(false); setStoppable(false); }
    }
  }, [running, request, rf, id, actions]);
  const stopGeneration = useCallback(() => { abortRef.current?.abort(); }, []);
  // 卸载时中止本节点发起的流式请求（节点被删 / 切画布）
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  // —— 正文编辑：text / prompt 两键同步 ——
  const setDocument = useCallback((markdown: string) => actions.update(documentPatch(markdown)), [actions]);

  // —— 复制 / 下载 / 全屏 ——
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(t);
  }, [copied]);
  const copy = useCallback(() => { void copyText(doc).then((ok) => ok && setCopied(true)); }, [doc]);
  const [downloadUrl, setDownloadUrl] = useState<string | undefined>();
  useEffect(() => {
    // 同 Toonflow：只在选中且有正文时生成 Blob 链接，内容变化 / 取消选中即回收
    if (!selected || !hasDoc || typeof URL.createObjectURL !== 'function') { setDownloadUrl(undefined); return; }
    const url = URL.createObjectURL(new Blob([doc], { type: 'text/markdown;charset=utf-8' }));
    setDownloadUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [selected, hasDoc, doc]);

  const [dialog, setDialog] = useState<DialogState | null>(null);
  const openEditor = () => setDialog({ kind: 'doc', mode: 'edit', fullscreen: false });
  const previewRef = useCallback((item: RefItem, index: number) => {
    if (!item.value) return;
    if (item.dataType === 'STRING') {
      setDialog({ kind: 'ref', title: `${refName(index + 1)}${item.label ? ` · ${item.label}` : ''}`, value: item.value, fullscreen: false });
    } else if (item.dataType === 'IMAGE' || item.dataType === 'VIDEO' || item.dataType === 'AUDIO') {
      actions.openFullscreen(item.value, item.dataType === 'IMAGE' ? 'image' : item.dataType === 'VIDEO' ? 'video' : 'audio');
    }
  }, [actions]);

  const label = typeof data.label === 'string' && data.label ? data.label : '文本';
  const toolbar = (
    <FloatingToolbar
      onSaveToAssets={actions.saveToAssets ? () => void actions.saveToAssets?.() : undefined}
      saveDisabled={!actions.canSaveToAssets || !hasDoc}
      right={<ToolbarButton icon={copied ? IconCheck : IconCopy} title={copied ? '已复制' : '复制文本'} iconOnly disabled={!hasDoc} onClick={copy} />}
      downloadUrl={downloadUrl}
      downloadName={markdownFileName(label)}
      onFullscreen={() => setDialog({ kind: 'doc', mode: 'read', fullscreen: true })}
      fullscreenDisabled={!hasDoc}
    />
  );

  const panel = (
    <PromptPanel
      refs={refs}
      prompt={instruction}
      onPromptChange={(v) => actions.update({ [GEN_PROMPT_KEY]: v })}
      onMoveRef={moveRef}
      onRemoveRef={removeRef}
      onPreviewRef={previewRef}
      sources={SKILL_OPTIONS}
      sourceId={skill.id}
      onSourceChange={(sid) => actions.update({ skill_id: sid })}
      sourcePlaceholder="选择技能"
      placeholder={skill.placeholder}
      disabled={running}
      running={pending && stoppable ? true : undefined}
      onStop={pending && stoppable ? stopGeneration : undefined}
      onSend={() => void send()}
      sendDisabled={!request.ok}
      sendTitle={request.ok ? `${skill.label}（⌘/Ctrl + Enter）` : request.reason}
      warnings={request.warnings}
      extraFooter={running ? (
        <span className="cv-text__footer-status" role="status">
          <IconLoader2 className="cv-spin" size={14} aria-hidden />
          {waitingFirstDelta ? '等待模型响应…' : `${skill.label}中…`}
        </span>
      ) : null}
    />
  );

  return (
    <NodeSkeleton node={props} topSlot={toolbar} topWidth="max-content" panel={panel} panelWidth={660}>
      <div className={['cv-text', hasDoc ? '' : 'is-empty'].filter(Boolean).join(' ')}>
        {showFailure && (
          <div className="cv-text__alert nodrag" role="alert">
            <span className="cv-text__alert-text" title={failure!}>{failure}</span>
            <button type="button" className="cv-text__alert-close" aria-label="关闭错误提示" onClick={(e) => { e.stopPropagation(); setDismissed(failureKey); }}>
              <IconX size={14} aria-hidden />
            </button>
          </div>
        )}
        {hasDoc && (
          <div ref={previewBoxRef} className="cv-text__preview nopan nowheel" aria-label="文本内容" aria-busy={streaming || undefined}>
            <MarkdownPreview value={doc} />
          </div>
        )}
        <button
          type="button"
          className="cv-btn cv-text__edit nodrag nopan"
          disabled={running}
          title={running ? '生成中，暂不能编辑' : '编辑文本'}
          onDoubleClick={stop}
          onClick={(e) => { e.stopPropagation(); openEditor(); }}
        >
          <IconEdit size={16} aria-hidden />
          编辑
        </button>
        {streaming && (
          <div className="cv-text__streaming" role="status" aria-label="文本生成中">
            <IconLoader2 className="cv-spin" size={12} aria-hidden />
            <span>生成中…</span>
          </div>
        )}
        {running && !streaming && (
          <div className="cv-text__running" role="status" aria-label="文本生成中">
            <IconLoader2 className="cv-spin" size={22} aria-hidden />
            <span>{waitingFirstDelta ? '等待模型响应…' : '生成中…'}</span>
            {!pending && (
              // 不是本页面发起的运行（Agent 执行 / 刷新前残留的状态）：允许不再等待
              <button
                type="button"
                className="cv-btn cv-btn--sm nodrag nopan"
                onDoubleClick={stop}
                onClick={(e) => { e.stopPropagation(); actions.update({ agent_state: { status: 'idle', updated_at: new Date().toISOString() } }); }}
              >
                不再等待
              </button>
            )}
          </div>
        )}
      </div>
      {dialog?.kind === 'doc' && (
        <TextDocumentDialog
          title={label}
          value={doc}
          onChange={setDocument}
          mode={dialog.mode}
          onModeChange={(mode) => setDialog({ ...dialog, mode })}
          fullscreen={dialog.fullscreen}
          onFullscreenChange={(fullscreen) => setDialog({ ...dialog, fullscreen })}
          readOnly={running}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'ref' && (
        <TextDocumentDialog
          title={dialog.title}
          value={dialog.value}
          mode="read"
          fullscreen={dialog.fullscreen}
          onFullscreenChange={(fullscreen) => setDialog({ ...dialog, fullscreen })}
          onClose={() => setDialog(null)}
        />
      )}
    </NodeSkeleton>
  );
}
