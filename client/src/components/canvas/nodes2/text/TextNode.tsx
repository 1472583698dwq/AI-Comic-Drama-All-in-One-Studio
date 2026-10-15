// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N1 文本节点 `prompt`（对照 Toonflow packages/nodes/textNode/src/index.vue）。
 *
 * 卡片：Markdown 渲染预览（最高 240、可滚动）+「编辑」按钮 → 文本弹窗（预览 ⇄ 编辑，tiptap 富文本 / 原文）；
 * 上方浮动工具栏：添加到素材库 ｜ 复制文本 · 下载 .md · 全屏阅读；
 * 下方提示词面板（kit PromptPanel）：参考列表 + `{{ref N}}` 提示词 + 技能下拉（替换 Toonflow 的模型下拉）+ 发送。
 * 技能执行经 useKitNodeActions(id).execute(overrides) 交给宿主原有分支（键见 skills.TextExecuteOverrides）；
 * MiniMax 的文本接口不是流式，生成中显示转圈，完成后整段替换正文。颜色只用 --cv-* 变量（text.css）。
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
  GEN_PROMPT_KEY, TEXT_SKILLS, buildSkillRequest, documentOf, documentPatch, isRunningState, markdownFileName, skillOf,
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
  const [dismissed, setDismissed] = useState<string | null>(null);
  const failure = state?.status === 'failed' ? (state.error || '生成失败') : null;
  const failureKey = failure ? `${state?.updated_at ?? ''}|${failure}` : null;
  const showFailure = !!failure && !running && failureKey !== dismissed;
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

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
    try {
      // REQ-toonflow-canvas 宿主按 skill_id 路由（键见 skills.TextExecuteOverrides / progress/N1.md）
      await actions.execute(request.overrides);
      if (!hostTouched()) actions.update({ agent_state: { status: 'completed', tool, updated_at: new Date().toISOString() } });
    } catch (e) {
      if (!hostTouched()) actions.update({ agent_state: { status: 'failed', tool, error: errorMessage(e), updated_at: new Date().toISOString() } });
    } finally {
      if (aliveRef.current) setPending(false);
    }
  }, [running, request, rf, id, actions]);

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
      onSend={() => void send()}
      sendDisabled={!request.ok}
      sendTitle={request.ok ? `${skill.label}（⌘/Ctrl + Enter）` : request.reason}
      warnings={request.warnings}
      extraFooter={running ? (
        <span className="cv-text__footer-status" role="status">
          <IconLoader2 className="cv-spin" size={14} aria-hidden />
          {skill.label}中…
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
          <div className="cv-text__preview nopan nowheel" aria-label="文本内容">
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
        {running && (
          <div className="cv-text__running" role="status" aria-label="文本生成中">
            <IconLoader2 className="cv-spin" size={22} aria-hidden />
            <span>生成中…</span>
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
