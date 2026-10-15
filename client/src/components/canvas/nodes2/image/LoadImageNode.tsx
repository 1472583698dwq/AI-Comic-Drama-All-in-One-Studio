// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas 「图片」节点 load-image（Toonflow packages/nodes/imageNode 的 React 版，接 MiniMax 后端）。
 * - 上传 / 替换（≤100MB）、素材库拖入、全屏、下载、保存到素材库（宿主）；
 * - 标记：涂抹层画标记 → compose-mask → 右侧新图片节点（从本节点 image 连到它的 in，Toonflow 同款）；
 * - 局部重绘：涂抹 + 下方重绘面板（生成源 / 参数 / 要求）→ useGeneration → 结果替换当前图片，原图留在历史版本；
 * - 宫格切分：rows×cols → /media/ops/grid-split → 宫格排布的 N 个图片节点（保留原图）。
 * 数据键沿用 MiniMax：image_url（+ image / url 同写）、asset_id；新增 history、inpaint_prompt、inpaint_provider_id、
 * inpaint_params、inpaint_model（局部重绘期间还会写 agent_state / result_url / width / height）。
 */
import { useCallback, useEffect, useMemo, type ChangeEvent } from 'react';
import type { NodeProps } from '@xyflow/react';
import { IconBrush, IconLayoutGrid, IconLoader2, IconPencil, IconPhotoOff, IconTransfer, IconUpload } from '@tabler/icons-react';
import { NodeSkeleton } from '../../kit/NodeSkeleton';
import { ToolbarButton } from '../../kit/FloatingToolbar';
import { PromptPanel } from '../../kit/PromptPanel';
import { useKitNodeActions } from '../../kit/hostContext';
import { appendHistory, useGeneration } from '../../kit/useGeneration';
import { resolveMediaUrl } from '../../../../utils/devOrigin';
import { ImageStage, PaintToolbar } from './ImageEditor';
import { GridSplitPopover } from './GridSplitPopover';
import { HistoryStrip, historyOf, withCurrent } from './HistoryStrip';
import { GenParamsPanel } from './GenParamsPanel';
import { usePaintEditor } from './usePaintEditor';
import { useImageMedia, LOAD_IMAGE_TYPE } from './useImageMedia';
import { useImageGenConfig } from './useImageGenConfig';
import { useInpaint } from './useInpaint';
import { agentError, isAgentRunning } from './generation';
import { fileNameOf, imageUrlOf, loadImagePatch } from './media';
import { aspectLabel } from './imageParams';
import './image.css';

type Data = Record<string, unknown>;

export function LoadImageNode(props: NodeProps) {
  const { id, selected } = props;
  const data = (props.data || {}) as Data;
  const actions = useKitNodeActions(id);
  const label = typeof data.label === 'string' && data.label ? data.label : '图片';
  const url = imageUrlOf(LOAD_IMAGE_TYPE, data);
  const history = historyOf(data);
  // useGeneration 的回写签名是 (nodeId, patch)，actions.update 只收 patch
  const writeBack = useCallback((_nid: string, patch: Data) => actions.update(patch), [actions]);
  const gen = useGeneration(id, writeBack);
  const agentBusy = gen.running || isAgentRunning(data.agent_state);

  // —— 新图片（上传 / 拖入）：三键同写；已有历史版本时一并记入 ——
  const onImage = useCallback((next: string, meta: { assetId?: string }) => {
    const patch: Data = { ...loadImagePatch(next), asset_id: meta.assetId };
    if (history.length) patch.history = appendHistory(withCurrent(history, url), { url: next, created_at: new Date().toISOString() });
    actions.update(patch);
  }, [actions, history, url]);

  const media = useImageMedia({ id, label, url, actions, onImage, busy: agentBusy });
  const editor = usePaintEditor(url, { disabled: media.uploading || agentBusy });

  // —— 局部重绘的生成源与参数（只在本节点用，键带 inpaint_ 前缀，不和下游混淆）——
  const providerId = typeof data.inpaint_provider_id === 'string' ? data.inpaint_provider_id : '';
  const params = useMemo(() => (data.inpaint_params && typeof data.inpaint_params === 'object' ? data.inpaint_params as Data : {}), [data.inpaint_params]);
  const cfg = useImageGenConfig(providerId, params);
  const prompt = typeof data.inpaint_prompt === 'string' ? data.inpaint_prompt : '';
  const inpaint = useInpaint({
    id, kind: 'load-image', url, data, editor, gen, actions, providerId, params,
    model: typeof data.inpaint_model === 'string' ? data.inpaint_model : undefined,
    slots: cfg.slots, ratioSpec: cfg.quick.ratio, natural: media.natural, refs: [], prompt,
  });
  const running = agentBusy || inpaint.inpainting;
  const busy = running || media.uploading || media.splitting || editor.busy;

  useEffect(() => { if (!selected) media.setGridAnchor(null); }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) void media.upload(file);
  };

  const failedMsg = agentError(data.agent_state);
  const display = url ? resolveMediaUrl(url) : '';
  const lockedRatio = media.natural ? aspectLabel(media.natural.width, media.natural.height) : undefined;

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
  const toolbarRight = (
    <ToolbarButton icon={IconPencil} title="标记" iconOnly disabled={busy || !url || media.failed} onClick={() => editor.start('mark')} />
  );

  const panel = editor.mode === 'inpaint' ? (
    <PromptPanel
      refs={[]}
      prompt={prompt}
      onPromptChange={(v) => actions.update({ inpaint_prompt: v })}
      placeholder="描述涂抹区域要改成什么"
      sources={cfg.sourceOptions.filter((s) => s.id)}
      sourceId={providerId}
      sourcePlaceholder="选择图片生成源"
      onSourceChange={(pid) => cfg.selectProvider(pid, (nid, defaults) => actions.update({ inpaint_provider_id: nid, inpaint_params: defaults }))}
      sourcesLoading={cfg.sourcesLoading}
      onSourcesOpen={cfg.refreshSources}
      paramsSummary={cfg.quick.ratio ? `跟随原图${cfg.quick.size ? ` · ${String(params[cfg.quick.size.param_name] ?? cfg.quick.size.default_value ?? '')}` : ''}` : cfg.summary.text}
      paramsRatio={lockedRatio}
      renderParams={() => (
        <GenParamsPanel
          quick={cfg.quick}
          params={params}
          onParamChange={(k, v) => actions.update({ inpaint_params: { ...params, [k]: v } })}
          modelSpec={cfg.modelSpec}
          model={typeof data.inpaint_model === 'string' ? data.inpaint_model : undefined}
          onModelChange={(m) => actions.update({ inpaint_model: m })}
          ratioLocked={lockedRatio ?? '原图'}
          noProvider={!providerId}
        />
      )}
      running={running}
      onSend={() => void inpaint.run()}
      onStop={inpaint.stop}
      sendDisabled={!providerId || !prompt.trim() || editor.busy}
      sendTitle={!providerId ? '请先选择图片生成源' : '局部重绘'}
      warnings={failedMsg ? [failedMsg] : undefined}
    />
  ) : undefined;

  return (
    <NodeSkeleton
      node={props}
      width={media.width}
      toolbar={toolbar}
      toolbarRight={toolbarRight}
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
          <ImageStage src={url} alt="节点图片" editor={editor} natural={media.natural} nodeWidth={media.width} onLoad={media.onLoad} onError={media.onError} />
        ) : url ? (
          <div className="cv-img-empty is-error" role="img" aria-label="图片无法预览">
            <IconPhotoOff size={40} stroke={1.25} aria-hidden />
            <span>无法预览该图片</span>
          </div>
        ) : (
          <button type="button" className="cv-img-upload nodrag" title="上传图片" aria-label="上传图片" disabled={media.uploading} onClick={media.openFilePicker} onDoubleClick={(e) => e.stopPropagation()}>
            {media.uploading ? <IconLoader2 size={40} className="cv-spin" aria-hidden /> : <IconUpload size={48} stroke={1.5} aria-hidden />}
            <span>{media.uploading ? '上传中…' : '上传图片 / 拖入素材'}</span>
          </button>
        )}
        {(running || (media.uploading && !!url)) && (
          <div className="cv-img-busy" role="status">
            <IconLoader2 size={22} className="cv-spin" aria-hidden />
            <span>{running ? '局部重绘中…' : '上传中…'}</span>
          </div>
        )}
        <input ref={media.fileInputRef} className="cv-img-file" type="file" accept="image/*" aria-label="选择图片" disabled={media.uploading} onChange={onFile} />
      </div>
      <HistoryStrip
        history={history}
        current={url}
        disabled={busy}
        onSelect={(h) => actions.update({ ...loadImagePatch(h.url), asset_id: undefined })}
      />
      {failedMsg && !panel && <div className="cv-img-error" title={failedMsg}>{failedMsg}</div>}
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
