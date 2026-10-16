// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas「音频生成」节点 audio（照 Toonflow audioGenerationNode/index.vue，宽 360）：
 *   输入口 in：图片 / 音频 / 文本（图片 + 音频合计 ≤1，见 connect.ts）；输出口 audio。
 *   卡片：当前结果的波形播放器（无结果时音符图标）；上方工具栏「截取 · 变速 · 历史记录 · 替换音频 | 下载」；
 *   下方提示词面板（660）：参考列表 + 台词输入（{{ref N}}）+ 语音源下拉 + 参数弹层 + 智能规划 + 发送；变速时换成 440 的变速面板。
 * MiniMax 部分：语音源 = useProviderSources('audio')（IndexTTS / CosyVoice / GPT-SoVITS / MiniMax / ElevenLabs / 自定义源），
 *   音色 / 情绪沿用 TTSNode，参数用 DynamicControl；生成走 kit/useGeneration（直接生成 / 智能规划两条路径，结果进 history）。
 * 台词键：节点自身文本读 `text` 优先（后端 inputs.own_prompt 同规则），编辑时同写 `prompt` 兼容旧画布。
 */
import { useCallback, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useReactFlow, type NodeProps } from '@xyflow/react';
import { IconGauge, IconHistory, IconLoader2, IconMusicBolt, IconScissors, IconTransfer } from '@tabler/icons-react';
import {
  NodeSkeleton, PromptPanel, ToolbarButton, appendHistory, assembleInputs, loadProviderDefinition, ownPromptOf, readOutputValue,
  useGeneration, useKitNodeActions, useNodeReferences, useProviderDefinition, useProviderSources,
  type GenSourceOption, type HistoryEntry, type KitNodeData,
} from '../../kit';
import { extractSlotsFromProvider, type DynamicProviderInfo } from '../../providerSkills';
import type { AgentState } from '../../hooks/nodeAgentExecutor';
import { resolveMediaUrl } from '../../../../utils/devOrigin';
import { toast } from '../../../../stores/useDialogStore';
import { AudioPlayer, type AudioPlayerHandle } from './AudioPlayer';
import { AudioSpeedPanel } from './AudioSpeedPanel';
import { AudioTrimDialog } from './AudioTrimDialog';
import { AudioHistoryDialog } from './AudioHistoryDialog';
import { AudioParamsPanel } from './AudioParamsPanel';
import { useAudioProcessing } from './useAudioProcessing';
import { useVoices } from './voices';
import { MEDIA_REF_LIMIT, countMediaRefs } from './connect';
import { audioGenerationInputs, audioPromptValue, declaresAudioSlot, legacyRefAudioOf } from './genInputs';
import { fileNameOf, uploadAudioFile } from './media';
import {
  currentSettingValue, emotionParamKey, paramsOf, paramsSummary, providerSwitchPatch, resolveAudioParams, settingControls, settingLabel,
  voiceParamKey, type ProviderDefLike,
} from './audioSettings';
import './audio.css';

export interface AudioGenData extends KitNodeData {
  /** 台词（主键，后端 own_prompt 对 audio 读 text 优先） */
  text?: string;
  /** 台词镜像（兼容旧画布 / 执行器读 prompt 的路径） */
  prompt?: string;
  provider_id?: string;
  provider?: string;
  params?: Record<string, unknown>;
  provider_params?: Record<string, unknown>;
  voice_id?: string;
  emotion?: string;
  /** Toonflow 音频设置（生成源声明了才下发） */
  language?: string;
  sampleRate?: number;
  format?: string;
  /** 「智能规划」开关 */
  smart_plan?: boolean;
  audio_url?: string;
  agent_state?: AgentState;
}

const EMPTY_DATA: AudioGenData = {};

export function AudioGenNode(props: NodeProps) {
  const { id } = props;
  const d = (props.data ?? EMPTY_DATA) as AudioGenData;
  const rf = useReactFlow();
  const actions = useKitNodeActions(id);
  // useGeneration 的回写签名是 (nodeId, patch)；actions.update 只收 patch
  const updateNode = useCallback((_nodeId: string, patch: Record<string, unknown>) => actions.update(patch), [actions]);
  const gen = useGeneration(id, updateNode);
  const { refs, moveRef, removeRef } = useNodeReferences(id);
  const { sources, loading: sourcesLoading } = useProviderSources('audio');
  const providerId = String(d.provider_id || d.provider || '');
  const rawDef = useProviderDefinition(providerId || undefined) as DynamicProviderInfo | null;
  // 切源后旧定义还在 state 里，id 对不上就当未知
  const def = rawDef && String((rawDef as { id?: unknown }).id ?? providerId) === providerId ? rawDef : null;
  const source = sources.find((s) => s.id === providerId);
  const providerName = String(def?.display_name || def?.name || source?.name || providerId);
  const { catalog, loading: voicesLoading } = useVoices(providerId || undefined, providerName);
  // 按生成源声明的槽位组装（不传 nodeKind：不要兜底槽位，生成源不支持参考音频 / 参考图时如实提示）
  const slots = useMemo(() => (def ? extractSlotsFromProvider(def) : null), [def]);
  const params = useMemo(() => paramsOf(d), [d]);
  // FX-2：弹层显示与直接生成下发同一份参数（没存值的按生成源缺省补齐，见 resolveAudioParams）
  const resolved = useMemo(() => resolveAudioParams(def as ProviderDefLike, params, d), [def, params, d]);
  const assembled = useMemo(
    () => assembleInputs({ refs, targetType: 'audio', prompt: ownPromptOf('audio', d), refRoles: d.refRoles, slots }),
    [refs, d, slots],
  );
  const smartPlan = !!d.smart_plan;
  const storedUrl = readOutputValue({ type: 'audio', data: d }, 'audio', 'AUDIO');
  const playUrl = resolveMediaUrl(storedUrl);
  const label = typeof d.label === 'string' && d.label ? d.label : '音频生成';

  const player = useRef<AudioPlayerHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pause = useCallback(() => player.current?.pause(), []);
  const proc = useAudioProcessing({ sourceUrl: storedUrl, label, actions, onBeforeRun: pause });
  const [uploading, setUploading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const busy = gen.running || uploading || proc.processing;

  // —— 校验与提示 ——
  const mediaCount = countMediaRefs(refs);
  const overLimit = mediaCount > MEDIA_REF_LIMIT;
  const refAudioIndex = refs.findIndex((r) => assembled.assignments[r.key] === 'ref_audio');
  const refAudio = refAudioIndex >= 0 ? { index: refAudioIndex + 1, label: refs[refAudioIndex].label } : null;
  const legacyRefAudio = refAudio ? '' : legacyRefAudioOf(d);
  const warnings = [...assembled.warnings];
  if (overLimit) warnings.push(`图片和音频参考合计最多 ${MEDIA_REF_LIMIT} 个（当前 ${mediaCount} 个），请删除多余的参考后再生成`);
  if (providerId && catalog?.configured === false) warnings.push(`语音源「${providerName}」未配置，请先在设置中完成配置`);
  else if (providerId && catalog?.healthy === false) warnings.push(`语音源「${providerName}」服务未就绪（健康检查未通过），生成可能失败`);
  const hasPrompt = !!assembled.prompt.trim();
  const canSend = hasPrompt && (smartPlan || !!providerId) && !overLimit && !busy;
  const sendTitle = !hasPrompt
    ? '请输入要朗读的台词'
    : !providerId && !smartPlan
      ? '请先选择语音源，或打开「智能规划」'
      : overLimit
        ? '图片和音频参考合计最多 1 个'
        : '生成音频';
  const agentState = d.agent_state;
  const failure = gen.running ? null : (gen.error || (agentState?.status === 'failed' ? agentState.error || '生成失败' : null));

  // —— 参数摘要（Toonflow：中文 · 24k · wav；这里先音色 / 情绪，再列生成源声明了的音频设置）——
  const voiceKey = voiceParamKey(def);
  const voiceId = String((voiceKey ? params[voiceKey] : undefined) ?? d.voice_id ?? '');
  const voiceName = catalog?.voices.find((v) => v.id === voiceId)?.name || voiceId;
  const emotionKey = emotionParamKey(def);
  const emotion = emotionKey ? String(resolved[emotionKey] ?? '') : '';
  const summary = providerId
    ? paramsSummary([
      voiceKey ? voiceName || '默认音色' : '',
      emotion,
      ...settingControls(def).map((c) => settingLabel(c.key, currentSettingValue(c, params, d, def))),
    ]) || '参数'
    : '参数';

  const sourceOptions = useMemo<GenSourceOption[]>(() => sources.map((s) => ({
    id: s.id,
    label: s.name,
    group: s.raw.builtin ? '内置语音源' : '自定义语音源',
    description: String(s.raw.description || s.name),
  })), [sources]);

  const selectProvider = async (pid: string) => {
    const nextDef = pid ? await loadProviderDefinition(pid) : null;
    const cur = ((rf.getNode(id)?.data as Record<string, unknown> | undefined) ?? d) as Record<string, unknown>;
    actions.update(providerSwitchPatch(cur, pid, nextDef as ProviderDefLike));
  };

  const send = async () => {
    if (!canSend) return;
    pause();
    setNote(null);
    // FX-2：直接生成下发弹层显示的参数（定义还没到时现取一次）；智能规划只发手动存过的参数，其余由 Agent 规划
    const liveDef = smartPlan ? null : def ?? (providerId ? ((await loadProviderDefinition(providerId)) as ProviderDefLike) : null);
    const res = await gen.run({
      nodeType: 'audio',
      kind: 'audio',
      data: d,
      assembled: audioGenerationInputs(assembled),
      providerId: providerId || undefined,
      params: smartPlan ? params : resolveAudioParams(liveDef, params, d),
      smartPlan,
      intent: assembled.prompt,
    });
    // 旧数据若带 audio 键（readOutputValue 优先读它），同步到新结果，避免下游拿到旧音频
    if (res?.url && typeof d.audio === 'string' && d.audio !== res.url) actions.update({ audio: res.url });
  };

  const setCurrent = (url: string, extra: Record<string, unknown> = {}) => {
    const patch: Record<string, unknown> = { audio_url: url, ...extra };
    if (typeof d.audio === 'string') patch.audio = url;
    actions.update(patch);
  };

  const onFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file || busy) return;
    setUploading(true);
    setNote(null);
    try {
      const res = await uploadAudioFile(file, { projectId: actions.projectId });
      let history: HistoryEntry[] = Array.isArray(d.history) ? d.history : [];
      // 被替换的当前结果不在历史里时先补进去，还能在历史记录里切回来
      if (storedUrl && !history.some((h) => h?.url === storedUrl)) history = [...history, { url: storedUrl, created_at: '' }];
      // ACT（Toonflow）：替换不删除旧音频
      setCurrent(res.url, { history: appendHistory(history, { url: res.url, created_at: new Date().toISOString() }) });
    } catch (err) {
      const msg = String((err as Error)?.message || err || '音频替换失败');
      setNote(msg);
      toast.error(msg, '音频替换失败');
    } finally {
      setUploading(false);
    }
  };

  const toolbar = (
    <>
      <ToolbarButton icon={IconScissors} title="截取音频" disabled={!storedUrl || busy} onClick={() => proc.open('trim')}>截取</ToolbarButton>
      <ToolbarButton icon={IconGauge} title="音频变速" disabled={!storedUrl || busy} onClick={() => proc.open('speed')}>变速</ToolbarButton>
      <ToolbarButton
        icon={IconHistory}
        title="历史记录"
        disabled={busy || (!storedUrl && !(Array.isArray(d.history) && d.history.length))}
        onClick={() => { pause(); setHistoryOpen(true); }}
      >
        历史记录
      </ToolbarButton>
      <ToolbarButton icon={IconTransfer} title="替换音频" loading={uploading} disabled={gen.running || proc.processing} onClick={() => fileInput.current?.click()}>替换音频</ToolbarButton>
    </>
  );

  const promptPanel = (
    <PromptPanel
      refs={refs}
      prompt={audioPromptValue(d)}
      onPromptChange={(v) => actions.update({ text: v, prompt: v })}
      onMoveRef={moveRef}
      onRemoveRef={removeRef}
      slotOf={(item) => assembled.assignments[item.key] ?? null}
      sources={sourceOptions}
      sourceId={providerId || undefined}
      onSourceChange={(pid) => void selectProvider(pid)}
      sourcesLoading={sourcesLoading}
      sourcePlaceholder={smartPlan ? 'Agent 自动选源' : '选择语音源'}
      paramsSummary={summary}
      renderParams={() => (
        <AudioParamsPanel
          data={d}
          def={def}
          providerId={providerId}
          providerName={providerName}
          catalog={catalog}
          voicesLoading={voicesLoading}
          refAudio={refAudio}
          refAudioSupported={def ? declaresAudioSlot(def) : undefined}
          legacyRefAudio={legacyRefAudio}
          disabled={busy}
          onPatch={actions.update}
        />
      )}
      smartPlan={smartPlan}
      onSmartPlanChange={(v) => actions.update({ smart_plan: v })}
      running={gen.running}
      onSend={() => void send()}
      onStop={gen.cancel}
      sendDisabled={!canSend}
      sendTitle={sendTitle}
      warnings={warnings}
      placeholder="输入要朗读的台词，或描述想要的音频效果（@ 引用上游文本）"
    />
  );

  return (
    <NodeSkeleton
      node={props}
      width={360}
      toolbar={toolbar}
      downloadUrl={playUrl || undefined}
      downloadName={fileNameOf(storedUrl) || undefined}
      onFullscreen={null}
      panel={proc.mode === 'speed' ? (
        <AudioSpeedPanel processing={proc.processing} error={proc.error} disabled={!storedUrl} onClose={proc.close} onRun={(r) => void proc.runSpeed(r)} />
      ) : promptPanel}
      panelWidth={proc.mode === 'speed' ? 440 : 660}
    >
      <div className="cv-audio-content nopan" aria-busy={gen.running || uploading}>
        {playUrl ? (
          <AudioPlayer ref={player} src={playUrl} label={label} />
        ) : (
          <div className="cv-audio-empty" role="img" aria-label="暂无生成音频">
            <IconMusicBolt size={48} stroke={1.25} aria-hidden />
          </div>
        )}
        {(gen.running || uploading) && (
          <div className="cv-audio-busy" role="status">
            <IconLoader2 size={18} className="cv-spin" aria-hidden />
            {uploading ? '上传中…' : smartPlan ? '规划并生成中…' : '生成中…'}
          </div>
        )}
        <input ref={fileInput} type="file" accept="audio/*" hidden aria-label="选择替换音频" disabled={busy} onChange={(e) => void onFileChange(e)} />
      </div>
      {failure && <div className="cv-audio-note is-error" role="alert" title={failure}>生成失败：{failure}</div>}
      {note && <div className="cv-audio-note is-error" role="alert" title={note}>{note}</div>}
      {proc.mode === 'trim' && playUrl && (
        <AudioTrimDialog src={playUrl} processing={proc.processing} error={proc.error} onClose={proc.close} onRun={(s, e) => void proc.runTrim(s, e)} />
      )}
      {historyOpen && (
        <AudioHistoryDialog
          history={d.history}
          currentUrl={storedUrl}
          sourceName={(pid) => sources.find((s) => s.id === pid)?.name}
          disabled={busy}
          onClose={() => setHistoryOpen(false)}
          onSelect={(h) => setCurrent(h.url)}
        />
      )}
    </NodeSkeleton>
  );
}
