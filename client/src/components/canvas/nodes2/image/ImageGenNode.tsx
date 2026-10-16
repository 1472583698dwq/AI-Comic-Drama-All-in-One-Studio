// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 「图片生成」节点 image（Toonflow packages/nodes/imageGenerationNode 的 React 版，接 MiniMax 生成源）。
 * - 卡片：当前结果（按宽高比 240 高）+ 历史版本条（点选切换 → 写回 image_url，下游跟着变）+ 运行 / 失败状态；
 * - 上方工具栏：局部重绘、宫格切分、替换图片、标记、下载、全屏、添加到素材库（宿主）；
 * - 下方提示词面板：有序参考（{{ref N}}）、生成源下拉（useProviderSources）、参数弹层（比例 / 分辨率快捷项 + 全部
 *   DynamicControl）、技能（角色一致性可绑定角色三视图）、智能规划开关；发送 → kit/useGeneration。
 * 数据键沿用 MiniMax：prompt、provider_id(+provider)、params(+provider_params)、model、image_url(+result_url)、skill_id、
 * agent_state、_last_agent_plan；kit 追加 refOrder、refRoles、history；本节点追加 smart_plan、inpaint_prompt。
 */
import { useCallback, useEffect, useMemo, type ChangeEvent } from 'react';
import { useReactFlow, type Node, type NodeProps } from '@xyflow/react';
import { IconBrush, IconLayoutGrid, IconLoader2, IconPencil, IconPhotoAi, IconPhotoOff, IconSparkles, IconTransfer } from '@tabler/icons-react';
import { NodeSkeleton } from '../../kit/NodeSkeleton';
import { ToolbarButton } from '../../kit/FloatingToolbar';
import { PromptPanel } from '../../kit/PromptPanel';
import { useKitNodeActions } from '../../kit/hostContext';
import { appendHistory, useGeneration } from '../../kit/useGeneration';
import { useNodeReferences } from '../../kit/useNodeReferences';
import { loadProviderDefinition } from '../../kit/useProviderSources';
import { assembleInputs, ownPromptOf } from '../../kit/assembleInputs';
import type { RefItem } from '../../kit/types';
import { resolveMediaUrl } from '../../../../utils/devOrigin';
import { toast } from '../../../../stores/useDialogStore';
import { useProjectStore } from '../../../../stores/useProjectStore';
import { ImageStage, PaintToolbar } from './ImageEditor';
import { GridSplitPopover } from './GridSplitPopover';
import { HistoryStrip, historyOf, withCurrent } from './HistoryStrip';
import { GenParamsPanel } from './GenParamsPanel';
import { CharacterBinder, CHARACTER_SKILL_ID, SkillPicker, type CharacterView } from './SkillPicker';
import { usePaintEditor } from './usePaintEditor';
import { useImageMedia, IMAGE_GEN_TYPE, LOAD_IMAGE_TYPE } from './useImageMedia';
import { useImageGenConfig } from './useImageGenConfig';
import { useInpaint } from './useInpaint';
import { agentError, generationData, generationLanded, isAgentRunning } from './generation';
import { assembleInpaint, inpaintBlockedReason } from './inpaint';
import { fileNameOf, genImagePatch, imageUrlOf, loadImagePatch } from './media';
import { aspectLabel, defaultModelOf, effectiveParams, paramsPatch, resolveImageParams } from './imageParams';
import { siblingRects, stackLeftOf } from './layout';
import './image.css';

type Data = Record<string, unknown>;

/** 参考重排时同步改写这些键里的 {{ref N}}（prompt 为主，旧镜像 text / idea 与局部重绘要求跟着改）。 */
export const IMAGE_PROMPT_KEYS = ['prompt', 'text', 'idea', 'inpaint_prompt'];
const EMPTY_CHARS: unknown[] = [];

/** 写提示词：prompt 为准；旧数据里的 text / idea 镜像一起改，免得 prompt 清空后回落到旧文本。 */
export function promptPatch(value: string, data: Data): Data {
  const patch: Data = { prompt: value };
  if (typeof data.text === 'string') patch.text = value;
  if (typeof data.idea === 'string') patch.idea = value;
  return patch;
}

/** 面板展示用参考：缩略图回源（dev 下 /storage 相对地址要拼后端源），组装仍用原值。 */
function displayRefs(refs: readonly RefItem[]): RefItem[] {
  return refs.map((r) => (r.thumb ? { ...r, thumb: resolveMediaUrl(r.thumb) } : r.dataType === 'IMAGE' && r.value ? { ...r, thumb: resolveMediaUrl(r.value) } : r));
}

export function ImageGenNode(props: NodeProps) {
  const { id, selected } = props;
  const data = (props.data || {}) as Data;
  const actions = useKitNodeActions(id);
  const rf = useReactFlow();
  const label = typeof data.label === 'string' && data.label ? data.label : '图片生成';
  const url = imageUrlOf(IMAGE_GEN_TYPE, data);
  const history = historyOf(data);
  const writeBack = useCallback((_nid: string, patch: Data) => actions.update(patch), [actions]);
  const gen = useGeneration(id, writeBack);
  const agentBusy = gen.running || isAgentRunning(data.agent_state);

  const { refs, moveRef, removeRef } = useNodeReferences(id, { promptKeys: IMAGE_PROMPT_KEYS });
  const uiRefs = useMemo(() => displayRefs(refs), [refs]);

  // provider_id 为准，旧数据只有 provider 时回落（同执行器 d.provider_id || d.provider）
  const providerId = (typeof data.provider_id === 'string' && data.provider_id) || (typeof data.provider === 'string' && data.provider) || '';
  const params = useMemo(() => {
    const p = data.params ?? data.provider_params;
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Data) : {};
  }, [data.params, data.provider_params]);
  const model = typeof data.model === 'string' ? data.model : undefined;
  const smartPlan = data.smart_plan === true;
  const skillId = typeof data.skill_id === 'string' ? data.skill_id : '';
  const cfg = useImageGenConfig(providerId, params, data);

  // —— 新图片（上传 / 拖入替换）：写当前版本并记入历史（Toonflow：替换的文件也在历史里）——
  const onImage = useCallback((next: string) => {
    actions.update({
      ...genImagePatch(next, data),
      history: appendHistory(withCurrent(history, url), { url: next, created_at: new Date().toISOString() }),
    });
  }, [actions, data, history, url]);

  const media = useImageMedia({ id, label, url, actions, onImage, busy: agentBusy });
  const editor = usePaintEditor(url, { disabled: media.uploading || agentBusy });
  const inpaintMode = editor.mode === 'inpaint';
  const inpaintPrompt = typeof data.inpaint_prompt === 'string' ? data.inpaint_prompt : '';
  const ownPrompt = ownPromptOf(IMAGE_GEN_TYPE, data);
  const refRoles = (data.refRoles && typeof data.refRoles === 'object' ? data.refRoles : null) as Record<string, string> | null;

  // 局部重绘只走直接生成：参数与模型按弹层显示的值下发（FX-2）
  const inpaint = useInpaint({
    id, kind: 'image', url, data, editor, gen, actions, providerId, params: cfg.resolved, model: model || defaultModelOf(cfg.def),
    slots: cfg.slots, ratioSpec: cfg.quick.ratio, natural: media.natural, refs, refRoles, prompt: inpaintPrompt,
  });
  const running = agentBusy || inpaint.inpainting;
  const busy = running || media.uploading || media.splitting || editor.busy;

  useEffect(() => { if (!selected) media.setGridAnchor(null); }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  // —— 组装（与后端 inputs.py 同规则；生成源已知时按其 input_schema 映射键名 / 截断）——
  const assembled = useMemo(
    () => assembleInputs({ refs, targetType: IMAGE_GEN_TYPE, prompt: ownPrompt, refRoles, slots: cfg.slots }),
    [refs, ownPrompt, refRoles, cfg.slots],
  );
  const inpaintPreview = useMemo(
    () => (inpaintMode && url ? assembleInpaint({ sourceUrl: url, guideUrl: '__guide__', refs, prompt: inpaintPrompt, refRoles, slots: cfg.slots }) : null),
    [inpaintMode, url, refs, inpaintPrompt, refRoles, cfg.slots],
  );

  const send = useCallback(async () => {
    if (gen.running) return;
    if (!assembled.prompt.trim()) { toast.info('请输入生成提示词，或连入文本参考'); return; }
    if (!providerId && !smartPlan) { toast.info('请先选择生成源，或开启智能规划由 Agent 自动选源'); return; }
    // FX-2：直接生成下发弹层显示的参数 / 模型（定义还没到时现取一次）；智能规划只发手动存过的参数，其余由 Agent 规划
    const liveDef = smartPlan ? null : cfg.def ?? (providerId ? await loadProviderDefinition(providerId) : null);
    const runParams = effectiveParams(smartPlan ? params : resolveImageParams(liveDef, params, data));
    const runModel = model || (smartPlan ? undefined : defaultModelOf(liveDef));
    const res = await gen.run({
      nodeType: IMAGE_GEN_TYPE,
      kind: 'image',
      data: generationData({ ...data, history: withCurrent(history, url) }, cfg.slots, runParams, runModel ? { model: runModel } : {}),
      assembled,
      providerId,
      params: runParams,
      smartPlan,
      intent: assembled.prompt,
    });
    if (!generationLanded(res)) {
      // 失败态由执行器写进 agent_state（受控画布下一帧才落到 store），读一帧后再提示
      window.setTimeout(() => {
        const err = agentError((rf.getNode(id)?.data as Data | undefined)?.agent_state);
        if (err) toast.error(err, '图片生成失败');
      }, 0);
      return;
    }
    // runGeneration 只保证 image_url；result_url / 旧 image 键对齐到同一张（没差异就不写）
    const cur = rf.getNode(id)?.data as Data | undefined;
    const fix = genImagePatch(res.url, cur);
    if (Object.entries(fix).some(([k, v]) => cur?.[k] !== v)) actions.update(fix);
  }, [gen, assembled, providerId, smartPlan, params, data, history, url, cfg.slots, cfg.def, model, rf, id, actions]);

  const selectProvider = (pid: string) => {
    if (pid === providerId) return;
    cfg.selectProvider(pid, (nid, defaults) => {
      const prev = (rf.getNode(id)?.data as Data | undefined)?.params as Data | undefined;
      actions.update({
        provider_id: nid || undefined,
        provider: nid || undefined,
        model: undefined,
        ...paramsPatch(defaults, prev),
        _last_agent_plan: undefined,
      });
    });
  };
  const setParam = (key: string, value: unknown) => {
    const next = { ...params, [key]: value };
    if (value === '' || value === undefined || value === null) delete next[key];
    actions.update(paramsPatch(next, params));
  };

  // —— 角色一致性：项目角色三视图 → 左侧新图片节点并连到 in ——
  const characters = useProjectStore((s) => (s.project?.characters as unknown[] | undefined) ?? EMPTY_CHARS) as any[];
  const boundViews = useMemo(() => {
    const set = new Set<string>();
    for (const r of refs) {
      const origin = (rf.getNode(r.sourceId)?.data as Data | undefined)?._origin as { op?: string; character_id?: string; view?: string } | undefined;
      if (origin?.op === 'character' && origin.character_id) set.add(`${origin.character_id}|${origin.view}`);
    }
    return set;
  }, [refs, rf]);
  const bindCharacter = (c: any, views: CharacterView[]) => {
    const todo = views.filter((v) => !boundViews.has(`${c.id}|${v.key}`));
    if (!todo.length) return;
    // 左侧竖排，绝对坐标（K1 h）：锚点在分组里时宿主换算成相对坐标
    const { anchor, others } = siblingRects(rf.getNodes() as Node[], id);
    const positions = anchor ? stackLeftOf(anchor, todo.length, others) : [];
    const ids = actions.createNodes(
      todo.map((v, i) => ({
        type: LOAD_IMAGE_TYPE,
        ...(positions[i] ? { position: positions[i] } : {}),
        data: { label: `${c.name || '角色'}·${v.label}`, ...loadImagePatch(v.url), _origin: { op: 'character', character_id: c.id, view: v.key, from: id } },
      })),
      { select: false },
    );
    // 宿主 createNodes 只能从锚点连出；参考要连进本节点，直接加边（受控画布会走宿主 onEdgesChange）
    rf.addEdges(ids.map((nid) => ({ id: `e_${nid}_image_${id}_in`, source: nid, sourceHandle: 'image', target: id, targetHandle: 'in' })));
    toast.success(`已绑定 ${c.name || '角色'} 的 ${todo.map((v) => v.label).join(' / ')} 为参考`);
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) void media.upload(file);
  };

  // —— 面板 ——
  const failedMsg = agentError(data.agent_state);
  const lastPlan = data._last_agent_plan as { provider_id?: string; skill_id?: string; model?: string; prompt?: string; params?: Data; reasoning?: string; plan_source?: string } | undefined;
  const planVisible = smartPlan && !inpaintMode && !!lastPlan && (!lastPlan.provider_id || !providerId || lastPlan.provider_id === providerId);
  const planSourceLabel = lastPlan?.provider_id ? (cfg.sourceOptions.find((s) => s.id === lastPlan.provider_id)?.label ?? lastPlan.provider_id) : '';
  const display = url ? resolveMediaUrl(url) : '';
  const inpaintBlocked = inpaintPreview ? inpaintBlockedReason(inpaintPreview) : null;
  const warnings = [
    ...(inpaintMode ? (inpaintBlocked ? [inpaintBlocked] : []) : assembled.warnings),
    ...(failedMsg ? [failedMsg] : []),
  ];
  // 编辑框显示原文（prompt 为准；旧数据只有 text 时显示 text）
  const promptValue = typeof data.prompt === 'string' && data.prompt ? data.prompt : typeof data.text === 'string' ? data.text : '';
  const lockedRatio = media.natural ? aspectLabel(media.natural.width, media.natural.height) : undefined;
  const sendTitle = running ? '停止生成' : inpaintMode ? (providerId ? '局部重绘' : '局部重绘需要先选择生成源') : (!providerId && !smartPlan ? '请先选择生成源，或开启智能规划' : '生成图片');
  const sendDisabled = inpaintMode
    ? !providerId || !inpaintPrompt.trim() || editor.busy
    : (!providerId && !smartPlan) || !assembled.prompt.trim() || editor.busy;

  const header = (
    <>
      {skillId === CHARACTER_SKILL_ID && !inpaintMode && (
        <CharacterBinder characters={characters} bound={boundViews} onBind={bindCharacter} disabled={busy} />
      )}
      {planVisible && (
        <div className="cv-img-plan" title={[lastPlan?.reasoning, lastPlan?.prompt ? `润色后：${lastPlan.prompt}` : ''].filter(Boolean).join('\n')}>
          <IconSparkles size={14} aria-hidden />
          <span>
            智能规划 · {planSourceLabel || '自动选源'}
            {lastPlan?.model ? ` · ${lastPlan.model}` : ''}
            {lastPlan?.params && Object.keys(lastPlan.params).length ? ` · ${Object.entries(lastPlan.params).slice(0, 4).map(([k, v]) => `${k}=${String(v)}`).join('，')}` : ''}
            {lastPlan?.plan_source === 'rule' ? ' · 规则降级' : ''}
          </span>
        </div>
      )}
    </>
  );

  const panel = editor.mode === 'mark' ? undefined : (
    <PromptPanel
      // 切换「生成 / 局部重绘」时重建输入框（tiptap 的 placeholder 只在创建时生效）
      key={inpaintMode ? 'inpaint' : 'generate'}
      refs={uiRefs}
      prompt={inpaintMode ? inpaintPrompt : promptValue}
      onPromptChange={(v) => actions.update(inpaintMode ? { inpaint_prompt: v } : promptPatch(v, data))}
      onMoveRef={moveRef}
      onRemoveRef={removeRef}
      onPreviewRef={(item) => { if (item.dataType === 'IMAGE' && item.value) actions.openFullscreen(resolveMediaUrl(item.value), 'image'); }}
      slotOf={() => null}
      placeholder={inpaintMode ? '描述涂抹区域要改成什么，输入 @ 引用参考' : '描述画面，输入 @ 引用参考'}
      sources={inpaintMode ? cfg.sourceOptions.filter((s) => s.id) : cfg.sourceOptions}
      sourceId={providerId}
      sourcePlaceholder={inpaintMode ? '选择图片生成源' : 'Agent 自动选源'}
      onSourceChange={selectProvider}
      sourcesLoading={cfg.sourcesLoading}
      onSourcesOpen={cfg.refreshSources}
      paramsSummary={inpaintMode && cfg.quick.ratio ? `跟随原图${cfg.quick.size ? ` · ${String(cfg.resolved[cfg.quick.size.param_name] ?? cfg.quick.size.default_value ?? '')}` : ''}` : cfg.summary.text}
      paramsRatio={inpaintMode ? lockedRatio : cfg.summary.ratio}
      renderParams={() => (
        <GenParamsPanel
          quick={cfg.quick}
          params={cfg.resolved}
          onParamChange={setParam}
          modelSpec={cfg.modelSpec}
          model={model}
          onModelChange={(m) => actions.update({ model: m || undefined })}
          ratioLocked={inpaintMode ? lockedRatio ?? '原图' : undefined}
          noProvider={!providerId}
        />
      )}
      smartPlan={smartPlan}
      onSmartPlanChange={inpaintMode ? undefined : (v) => actions.update({ smart_plan: v })}
      running={running}
      onSend={() => void (inpaintMode ? inpaint.run() : send())}
      onStop={inpaint.inpainting ? inpaint.stop : gen.cancel}
      sendDisabled={sendDisabled}
      sendTitle={sendTitle}
      header={header}
      extraFooter={inpaintMode ? undefined : <SkillPicker skillId={skillId} onChange={(s) => actions.update({ skill_id: s || undefined })} smartPlan={smartPlan} disabled={running} />}
      warnings={warnings.length ? warnings : undefined}
    />
  );

  const toolbar = (
    <>
      <ToolbarButton icon={IconBrush} title="局部重绘" disabled={busy || !url || media.failed} onClick={() => editor.start('inpaint')}>局部重绘</ToolbarButton>
      <ToolbarButton
        icon={IconLayoutGrid}
        title="宫格切分"
        loading={media.splitting}
        disabled={busy || !url || media.failed}
        onClick={(e) => media.setGridAnchor(media.gridAnchor ? null : e.currentTarget)}
      >
        宫格切分
      </ToolbarButton>
      <ToolbarButton icon={IconTransfer} title="替换图片" loading={media.uploading} disabled={running || editor.busy} onClick={media.openFilePicker}>替换图片</ToolbarButton>
    </>
  );

  return (
    <NodeSkeleton
      node={props}
      width={media.width}
      toolbar={toolbar}
      toolbarRight={<ToolbarButton icon={IconPencil} title="标记" iconOnly disabled={busy || !url || media.failed} onClick={() => editor.start('mark')} />}
      topSlot={editor.mode ? <PaintToolbar editor={editor} onSave={() => void media.saveMark(editor)} saving={media.markSaving} /> : undefined}
      downloadUrl={display || undefined}
      downloadName={fileNameOf(url)}
      onFullscreen={() => { if (display) actions.openFullscreen(display, 'image'); }}
      fullscreenDisabled={!display || media.failed}
      panel={panel}
      panelOpen={!!panel}
    >
      <div
        className={['cv-img-media nopan', media.dragOver ? 'is-drag-over' : ''].filter(Boolean).join(' ')}
        onDragOver={media.onDragOver}
        onDragLeave={media.onDragLeave}
        onDrop={media.onDrop}
        aria-busy={running || media.uploading}
      >
        {url && !media.failed ? (
          <ImageStage src={url} alt="生成图片" editor={editor} natural={media.natural} nodeWidth={media.width} onLoad={media.onLoad} onError={media.onError} />
        ) : url ? (
          <div className="cv-img-empty is-error" role="img" aria-label="图片无法预览">
            <IconPhotoOff size={40} stroke={1.25} aria-hidden />
            <span>无法预览该图片</span>
          </div>
        ) : (
          <div className="cv-img-empty" role="img" aria-label="暂无生成图片">
            <IconPhotoAi size={48} stroke={1.25} aria-hidden />
          </div>
        )}
        {(running || media.uploading) && (
          <div className="cv-img-busy" role="status">
            <IconLoader2 size={22} className="cv-spin" aria-hidden />
            <span>{media.uploading ? '上传中…' : inpaint.inpainting ? '局部重绘中…' : smartPlan ? '智能规划并生成中…' : '生成中…'}</span>
          </div>
        )}
        <input ref={media.fileInputRef} className="cv-img-file" type="file" accept="image/*" aria-label="选择替换图片" disabled={media.uploading} onChange={onFile} />
      </div>
      <HistoryStrip history={history} current={url} disabled={busy} onSelect={(h) => actions.update(genImagePatch(h.url, data))} />
      {failedMsg && !selected && <div className="cv-img-error" title={failedMsg}>{failedMsg}</div>}
      <GridSplitPopover
        open={!!media.gridAnchor && !!selected}
        anchor={media.gridAnchor}
        onClose={() => media.setGridAnchor(null)}
        src={url}
        splitting={media.splitting}
        disabled={busy && !media.splitting}
        onSplit={(r, c) => void media.split(r, c)}
      />
    </NodeSkeleton>
  );
}
