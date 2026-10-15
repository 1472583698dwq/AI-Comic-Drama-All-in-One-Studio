// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 「视频生成」节点 `video`（照 Toonflow packages/nodes/videoGenerationNode，接 MiniMax 后端）。
 *
 * 端口：target `in`[IMAGE, VIDEO, AUDIO, STRING]（有序参考列表）；source `video`[VIDEO]。
 * 卡片：当前结果播放器 + 历史版本；工具栏：提取音轨 / 分离音视频 / 截取片段 / 历史记录 / 替换视频 | 截帧 · 下载 · 全屏。
 * 底部 PromptPanel：参考列表（点卡片指定首帧 / 尾帧 / 参考图 → data.refRoles）、{{ref N}} 提示词、生成源下拉（useProviderSources('video')）、
 *   参数弹层（模式〔缺省自动〕/ 时长 / 分辨率 / 比例〔缺省 9:16〕/ 生成音频 + DynamicControl 其余参数）、智能规划开关（data.smart_plan）、发送 / 停止。
 * 生成走 kit/useGeneration（直接生成 / 智能规划、视频轮询、agent_state、history）；挂载时 `_polling && _taskId` 自动恢复轮询。
 * 数据键（沿用 MiniMax）：prompt(+text 镜像)、provider_id(+provider)、params(+provider_params，engine 顶层键同步)、mode、refOrder、refRoles、
 *   smart_plan、video_url、history、agent_state、_taskId、_polling、_last_agent_plan、polished_prompt、aspect_ratio。
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { NodeProps } from '@xyflow/react';
import {
  IconCameraAi, IconCheck, IconLayersSubtract, IconLoader2, IconMusic, IconRefresh, IconScissors, IconTransfer,
} from '@tabler/icons-react';
import { NodeSkeleton } from '../../kit/NodeSkeleton';
import { ToolbarButton } from '../../kit/FloatingToolbar';
import { PromptPanel, type GenSourceOption } from '../../kit/PromptPanel';
import { MenuList, Popover, type MenuItemSpec } from '../../kit/ui/Popover';
import { useKitNodeActions } from '../../kit/hostContext';
import { useNodeReferences } from '../../kit/useNodeReferences';
import { useGeneration, appendHistory } from '../../kit/useGeneration';
import { loadProviderDefinition, useProviderDefinition, useProviderSources } from '../../kit/useProviderSources';
import { assembleInputs, ownPromptOf } from '../../kit/assembleInputs';
import { refRolesOf } from '../../kit/inputRules';
import { refName } from '../../kit/references';
import { SLOT_LABELS } from '../../kit/RefList';
import type { GenMode, RefItem, Slot } from '../../kit/types';
import { extractSlotsFromProvider, paramsSchemaToSpecs, type DynamicProviderInfo } from '../../providerSkills';
import { resolveMediaUrl } from '../../../../utils/devOrigin';
import { toast } from '../../../../stores/useDialogStore';
import { FrameCaptureButton, VideoPlayer, type VideoMeta, type VideoPlayerHandle } from './VideoPlayer';
import { VideoActionsDialog } from './VideoActionsDialog';
import { HistoryButton, historyItems, type VideoHistoryItem } from './HistoryDialog';
import { VideoGenSettings, VIDEO_MODE_LABELS } from './VideoGenSettings';
import { useVideoOps } from './useVideoOps';
import { useVideoTaskRecovery, taskIdOf } from './useTaskRecovery';
import { mediaNodeWidth } from './LoadVideoNode';
import { fileNameOf, uploadVideoFile, validateVideoFile } from './media';
import {
  carryOverParams, currentRatio, dataForRun, effectiveMode, isRatioShape, modeHint, modeOptions, paramsPatch, paramsSummary,
  quickParamKeys, quickParamsOf, resolveAutoMode, type ProviderDefLike,
} from './videoParams';
import './video.css';

export const VIDEO_GEN_LABEL = '视频生成';

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

interface AgentStateLike {
  status?: 'idle' | 'running' | 'completed' | 'failed';
  error?: string;
  provider_id?: string;
}

function sourceGroup(raw: Record<string, unknown>): string {
  if (raw.builtin) return '内置';
  if (raw.provider_type === 'comfyui') return 'ComfyUI';
  return '自定义';
}

export function VideoGenNode(props: NodeProps) {
  const { id } = props;
  const data = useMemo(() => (props.data || {}) as Record<string, unknown>, [props.data]);
  const actions = useKitNodeActions(id);
  const updateForGen = useCallback((_nid: string, patch: Record<string, unknown>) => actions.update(patch), [actions]);
  const gen = useGeneration(id, updateForGen);
  const recovery = useVideoTaskRecovery(id, data, actions.update);
  const { refs, moveRef, removeRef } = useNodeReferences(id, { promptKeys: ['prompt', 'text'] });

  // —— 生成源 / 定义 / 槽位 / 快捷参数 ——
  const { sources, loading: sourcesLoading } = useProviderSources('video');
  const providerId = str(data.provider_id) || str(data.provider);
  const rawDef = useProviderDefinition(providerId || undefined) as (ProviderDefLike & DynamicProviderInfo) | null;
  const def = rawDef && (!rawDef.id || rawDef.id === providerId) ? rawDef : null;
  const slots = useMemo(() => (providerId && def ? extractSlotsFromProvider(def) : null), [providerId, def]);
  const q = useMemo(() => quickParamsOf(def), [def]);
  const params = useMemo(() => (data.params && typeof data.params === 'object' ? { ...(data.params as Record<string, unknown>) } : {}), [data.params]);
  const smartPlan = data.smart_plan === true;

  // —— 参考 → 组装（模式缺省自动；旧 i2v/r2v/t2v 映射成新模式）——
  const em = effectiveMode(data.mode, refs, slots);
  const ownPrompt = ownPromptOf('video', data);
  const refRoles = useMemo(() => refRolesOf(data), [data]);
  const assembled = useMemo(
    () => assembleInputs({ refs, targetType: 'video', prompt: ownPrompt, mode: em.assembleMode, refRoles, slots }),
    [refs, ownPrompt, em.assembleMode, refRoles, slots],
  );
  const displayMode = (assembled.mode || em.mode) as GenMode;
  /** 「自动」会选的模式（显示在模式下拉的自动项里）。 */
  const autoResolved = resolveAutoMode(refs, slots);
  const modeValue: GenMode | '' = em.auto ? '' : displayMode;

  // —— 运行态 ——
  const agentState = (data.agent_state || {}) as AgentStateLike;
  const externalRunning = agentState.status === 'running' && !gen.running && !recovery.recovering;
  const anyRunning = gen.running || recovery.recovering || externalRunning;
  const [uploading, setUploading] = useState(false);

  // —— 当前结果 / 历史 ——
  // 只认 video_url：旧画布视频节点上的 url / image 是上游图片经旧传播逻辑拷进来的（存量实测 V1.url=/storage/test/c.png）
  const url = str(data.video_url);
  const src = resolveMediaUrl(url);
  const history = useMemo(() => historyItems(data.history, url), [data.history, url]);
  const playerRef = useRef<VideoPlayerHandle>(null);
  const [meta, setMeta] = useState<VideoMeta | null>(null);
  const ops = useVideoOps(id, {
    videoUrl: url,
    label: typeof data.label === 'string' && data.label ? data.label : VIDEO_GEN_LABEL,
    getCurrentTime: () => playerRef.current?.currentTime() ?? 0,
    aspect: meta?.width && meta?.height ? meta.width / meta.height : undefined,
  });
  const busy = anyRunning || uploading || ops.processing;

  const sourceOptions = useMemo<GenSourceOption[]>(
    () => sources.map((s) => ({ id: s.id, label: s.name, group: sourceGroup(s.raw), description: str(s.raw.description) || undefined })),
    [sources],
  );
  const sourceName = useCallback((pid: string) => sources.find((s) => s.id === pid)?.name ?? pid, [sources]);

  // —— 写数据 ——
  const providerRef = useRef(providerId);
  providerRef.current = providerId;
  const onSourceChange = (pid: string) => {
    if (!pid || pid === providerId) return;
    // 切源即清旧计划 / 排队任务（同 NodeAgentConsole.selectProvider），参数等定义到了再按新源缺省 + 合法旧值重算
    actions.update({ provider_id: pid, provider: pid, _last_agent_plan: undefined, _taskId: undefined, _polling: false });
    void loadProviderDefinition(pid).then((d) => {
      if (providerRef.current !== pid) return;
      const next = carryOverParams(params, d as ProviderDefLike | null);
      actions.update(paramsPatch(next, quickParamsOf(d as ProviderDefLike | null), params));
    });
  };
  const setParam = (key: string, value: unknown) => {
    const next: Record<string, unknown> = { ...params, [key]: value };
    if (value === undefined || value === '') delete next[key];
    actions.update(paramsPatch(next, q, params));
  };
  // 旧节点可能只有 text（连线传播写进来的）：显示时回落 text，编辑时两键同写（ownPromptOf 也是 prompt → text）
  const promptValue = typeof data.prompt === 'string' && data.prompt ? data.prompt : typeof data.text === 'string' ? data.text : '';
  const setPrompt = (v: string) => actions.update({ prompt: v, text: v });

  // —— 发送 / 停止 ——
  const sendBlock = !assembled.prompt.trim()
    ? '请输入提示词'
    : !smartPlan && !providerId
      ? '请先选择生成源（或开启智能规划由 Agent 选源）'
      : '';
  const onSend = async () => {
    if (sendBlock || busy) return;
    const res = await gen.run({
      nodeType: 'video',
      kind: 'video',
      data: dataForRun(data, def, assembled.args),
      assembled,
      providerId: providerId || undefined,
      params,
      smartPlan,
      intent: assembled.prompt,
    });
    // 智能规划写回的 params 同步 engine 顶层键（engine.py 先读顶层再读 params）
    const planned = res?.patch?.params;
    if (planned && typeof planned === 'object') actions.update(paramsPatch(planned as Record<string, unknown>, undefined, params));
  };
  const onStop = () => {
    gen.cancel();
    recovery.stop();
  };

  // —— 替换视频（上传）——
  const fileRef = useRef<HTMLInputElement>(null);
  const onFile = async (file: File | undefined) => {
    if (!file || busy) return;
    const err = validateVideoFile(file);
    if (err) { toast.error(err); return; }
    setUploading(true);
    try {
      const up = await uploadVideoFile(file, actions.projectId);
      // 保留历史输出（Toonflow：不破坏撤销与副本引用），上传结果也进历史便于切回
      setMeta(null);
      actions.update({
        video_url: up.url,
        history: appendHistory(history, { url: up.url, created_at: new Date().toISOString(), source: 'upload' } as VideoHistoryItem),
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '视频替换失败');
    } finally {
      setUploading(false);
    }
  };

  // —— 参考卡片：点开指定槽位（首帧 / 尾帧 / 参考图）——
  const panelRef = useRef<HTMLDivElement>(null);
  const [roleMenu, setRoleMenu] = useState<{ item: RefItem; index: number; anchor: HTMLElement } | null>(null);
  const openRoleMenu = (item: RefItem, index: number) => {
    const el = panelRef.current?.querySelectorAll<HTMLElement>('.cv-reflist .cv-ref')[index];
    if (el) setRoleMenu({ item, index, anchor: el });
  };
  const setRole = (key: string, role: Slot | null) => {
    const roles: Record<string, string> = { ...refRolesOf(data) };
    if (role) {
      // 首帧 / 尾帧只能有一个：指定给新参考时清掉其他参考上的同一槽位
      if (role === 'first_frame' || role === 'last_frame') for (const k of Object.keys(roles)) if (k !== key && roles[k] === role) delete roles[k];
      roles[key] = role;
    } else delete roles[key];
    actions.update({ refRoles: roles });
  };
  const roleItems = (item: RefItem): MenuItemSpec[] => {
    const explicit = refRoles[item.key] as Slot | undefined;
    const assigned = assembled.assignments[item.key];
    const check = <IconCheck size={14} aria-hidden />;
    const choice = (slot: Slot, label: string): MenuItemSpec => ({ key: slot, label, extra: explicit === slot ? check : undefined, onSelect: () => setRole(item.key, slot) });
    const auto: MenuItemSpec = {
      key: 'auto',
      label: `自动（${assigned ? SLOT_LABELS[assigned] : '未使用'}）`,
      extra: !explicit ? check : undefined,
      onSelect: () => setRole(item.key, null),
    };
    const tail: MenuItemSpec[] = [
      ...(item.dataType !== 'STRING' && item.value ? [{
        key: 'preview', label: '预览', divided: true,
        onSelect: () => actions.openFullscreen(resolveMediaUrl(item.value), item.dataType === 'IMAGE' ? 'image' : item.dataType === 'VIDEO' ? 'video' : 'audio'),
      } as MenuItemSpec] : []),
      { key: 'remove', label: '断开引用', danger: true, divided: item.dataType === 'STRING' || !item.value, onSelect: () => removeRef(item) },
    ];
    if (item.dataType === 'IMAGE') return [auto, choice('first_frame', '首帧'), choice('last_frame', '尾帧'), choice('reference_images', '参考图'), ...tail];
    if (item.dataType === 'STRING') return [auto, choice('prompt', '提示词'), choice('camera_prompt', '机位提示词'), ...tail];
    return [{ key: 'fixed', label: `固定作为${item.dataType === 'AUDIO' ? '参考音频' : '参考视频'}`, disabled: true }, ...tail];
  };

  // 参考卡片显示用：/storage 相对地址回源（RefList / 引用标签直接用 value / thumb 作 src）
  const viewRefs = useMemo<RefItem[]>(() => refs.map((r) => (r.dataType === 'STRING' ? r : {
    ...r,
    value: resolveMediaUrl(r.value),
    thumb: r.thumb ? resolveMediaUrl(r.thumb) : undefined,
  })), [refs]);

  // —— 面板提示 / 告警 ——
  const imageCount = refs.filter((r) => r.dataType === 'IMAGE').length;
  const manualImageRoles = refs.some((r) => r.dataType === 'IMAGE' && ['first_frame', 'last_frame', 'reference_images'].includes(String(refRoles[r.key] ?? '')));
  const plan = data._last_agent_plan as Record<string, unknown> | undefined;
  const warnings = useMemo(() => {
    const w = [...assembled.warnings];
    if (providerId && !sourcesLoading && sources.length && !sources.some((s) => s.id === providerId)) w.push(`生成源「${providerId}」不在可用列表中，请重新选择`);
    return w;
  }, [assembled.warnings, providerId, sourcesLoading, sources]);
  const header = refs.length > 0 || (smartPlan && plan) ? (
    <div className="cv-vgen-hint" data-testid="cv-vgen-mode">
      {refs.length > 0 && (
        <span>
          模式：<b>{VIDEO_MODE_LABELS[displayMode]}</b>{em.auto ? '（自动）' : ''}
          {imageCount > 0 && <span> · {modeHint(displayMode)}{manualImageRoles ? '（手动指定的槽位优先）' : ''}</span>}
          {imageCount > 0 && <span className="cv-vgen-hint__muted"> · 点击参考卡片可指定首帧 / 尾帧 / 参考图</span>}
        </span>
      )}
      {smartPlan && plan && str(plan.provider_id) && (
        <div className="cv-vgen-hint__muted">上次智能规划：{sourceName(str(plan.provider_id))}{str(plan.reasoning) ? ` · ${str(plan.reasoning).slice(0, 80)}` : ''}</div>
      )}
    </div>
  ) : null;

  const ratio = currentRatio(q, params, data);
  const specs = useMemo(() => {
    const quick = new Set(quickParamKeys(q));
    return paramsSchemaToSpecs(def?.params_schema ?? undefined).filter((s) => !quick.has(s.param_name));
  }, [def, q]);

  // —— 卡片状态 ——
  const taskId = taskIdOf(data);
  const failedText = agentState.status === 'failed' || agentState.status === 'idle' ? str(agentState.error) : '';
  const errorText = failedText || (gen.error && !anyRunning ? gen.error : '');
  const canRequery = !!taskId && !busy && agentState.status !== 'completed';
  const statusText = uploading
    ? '上传中…'
    : recovery.recovering
      ? '正在恢复视频任务…'
      : data._polling ? '视频排队生成中…' : '生成中…';
  const dims = meta ?? (Number(data.width) > 0 && Number(data.height) > 0 ? { width: Number(data.width), height: Number(data.height) } : null);
  const width = useMemo(() => (src ? mediaNodeWidth(dims) : undefined), [src, dims?.width, dims?.height]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <NodeSkeleton
      node={props}
      width={width}
      downloadUrl={src || undefined}
      downloadName={url ? fileNameOf(url) : undefined}
      onFullscreen={() => void playerRef.current?.enterFullscreen()}
      fullscreenDisabled={!src}
      toolbar={(
        <>
          <ToolbarButton icon={IconMusic} title="提取音轨" disabled={!url || busy} onClick={() => ops.open('extractAudio')}>提取音轨</ToolbarButton>
          <ToolbarButton icon={IconLayersSubtract} title="分离音视频" disabled={!url || busy} onClick={() => ops.open('separate')}>分离音视频</ToolbarButton>
          <ToolbarButton icon={IconScissors} title="截取片段" disabled={!url || busy} onClick={() => ops.open('trim')}>截取片段</ToolbarButton>
          <HistoryButton items={history} current={url} disabled={busy} sourceName={sourceName} onSelect={(it) => { setMeta(null); actions.update({ video_url: it.url }); }} />
          <ToolbarButton icon={IconTransfer} title="替换视频" loading={uploading} disabled={anyRunning || ops.processing} onClick={() => fileRef.current?.click()}>替换视频</ToolbarButton>
        </>
      )}
      toolbarRight={<FrameCaptureButton onSelect={(at) => void ops.capture(at)} loading={ops.capturing} disabled={!url || busy || ops.capturing} />}
      panel={(
        <div
          ref={panelRef}
          onKeyDown={(e) => {
            // 键盘：焦点在参考卡片上按 Enter / 空格 → 打开槽位菜单（kit RefList 只支持点击预览）
            if ((e.key !== 'Enter' && e.key !== ' ') || e.altKey || e.metaKey || e.ctrlKey) return;
            const card = (e.target as HTMLElement).closest?.('.cv-ref');
            if (!card || card !== e.target) return;
            const index = Array.from(panelRef.current?.querySelectorAll('.cv-reflist .cv-ref') ?? []).indexOf(card);
            if (index < 0 || !refs[index]) return;
            e.preventDefault();
            openRoleMenu(viewRefs[index], index);
          }}
        >
          <PromptPanel
            refs={viewRefs}
            prompt={promptValue}
            onPromptChange={setPrompt}
            onMoveRef={moveRef}
            onRemoveRef={removeRef}
            onPreviewRef={openRoleMenu}
            slotOf={(item) => assembled.assignments[item.key] ?? null}
            sources={sourceOptions}
            sourceId={providerId || undefined}
            onSourceChange={onSourceChange}
            sourcesLoading={sourcesLoading}
            sourcePlaceholder="选择生成源"
            paramsSummary={paramsSummary(q, params, data)}
            paramsRatio={isRatioShape(ratio) ? ratio : undefined}
            renderParams={() => (
              <VideoGenSettings
                q={q}
                params={params}
                ratio={ratio}
                modeValue={modeValue}
                autoModeLabel={VIDEO_MODE_LABELS[autoResolved]}
                modes={modeOptions(slots, modeValue)}
                onMode={(m) => actions.update({ mode: m })}
                onParam={setParam}
                specs={specs}
                providerSelected={!!providerId}
                disabled={busy}
              />
            )}
            smartPlan={smartPlan}
            onSmartPlanChange={(v) => actions.update({ smart_plan: v })}
            running={anyRunning}
            onSend={() => void onSend()}
            onStop={onStop}
            sendDisabled={!!sendBlock || uploading || ops.processing}
            sendTitle={sendBlock || '生成视频'}
            header={header}
            warnings={warnings}
            placeholder="描述镜头运动与主体动作，输入 @ 引用参考"
          />
          <Popover
            open={!!roleMenu}
            anchor={roleMenu?.anchor ?? null}
            placement="top-start"
            onClose={() => setRoleMenu(null)}
            role="menu"
            aria-label="参考设置"
            className="cv-ref-role-pop"
          >
            {roleMenu && (
              <>
                <div className="cv-ref-role-pop__title">{`${refName(roleMenu.index + 1)}${roleMenu.item.label ? ` · ${roleMenu.item.label}` : ''}`}</div>
                <MenuList items={roleItems(roleMenu.item)} onClose={() => setRoleMenu(null)} />
              </>
            )}
          </Popover>
        </div>
      )}
    >
      <div className="cv-video-content nopan" aria-busy={busy}>
        {src ? (
          <VideoPlayer
            key={src}
            ref={playerRef}
            src={src}
            label="生成视频"
            onMetadata={setMeta}
            onCapture={(at) => void ops.capture(at)}
            capturing={ops.capturing}
            captureDisabled={busy}
            onFullscreenFallback={() => actions.openFullscreen(src, 'video')}
          />
        ) : (
          <div className="cv-video-empty" role="img" aria-label="暂无生成视频">
            <IconCameraAi size={48} stroke={1.25} aria-hidden />
          </div>
        )}
        {(anyRunning || uploading) && (
          <div className="cv-video-loading" role="status" aria-live="polite">
            <IconLoader2 className="cv-spin" size={24} aria-hidden />
            <span>{statusText}</span>
          </div>
        )}
        <input
          ref={fileRef}
          className="cv-video-file"
          type="file"
          accept="video/*"
          aria-label="选择替换视频"
          disabled={busy}
          onChange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; void onFile(f); }}
        />
      </div>
      {errorText && <div className="cv-video-error nodrag" role="alert">✗ {errorText}</div>}
      {canRequery && (
        <div className="cv-video-task nodrag">
          <span title={taskId}>任务 {taskId.length > 14 ? `${taskId.slice(0, 12)}…` : taskId}</span>
          <ToolbarButton icon={IconRefresh} title="重新查询任务" onClick={() => recovery.resume(taskId)}>重新查询</ToolbarButton>
        </div>
      )}
      <VideoActionsDialog
        action={ops.action}
        src={src}
        processing={ops.processing}
        onRunTrim={(r) => void ops.runTrim(r)}
        onRetry={ops.retry}
        onClose={ops.close}
        onCancel={ops.cancel}
        disabled={anyRunning || uploading}
      />
    </NodeSkeleton>
  );
}
