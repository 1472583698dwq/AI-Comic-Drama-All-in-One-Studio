// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas「音频」节点 load-audio（照 Toonflow audioNode/index.vue，宽 360）：
 *   空态：大号上传按钮（也可把本地音频文件 / 素材库卡片拖进来）；
 *   有音频：波形播放器；上方工具栏「截取 · 变速 · 替换音频 | 下载」（+ 宿主的「添加到素材库」）；
 *   截取 → 弹窗选区间；变速 → 下方 440 宽面板；两者都经后端 /media/ops/* 处理，产物落成右侧新的音频节点。
 * 数据：audio_url / audio / url 三键同写（旧 LoaderNodes 与迁移约定），上传时登记的素材 id 写 asset_id。
 */
import { useCallback, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import type { NodeProps } from '@xyflow/react';
import { IconGauge, IconLoader2, IconScissors, IconTransfer, IconUpload } from '@tabler/icons-react';
import { NodeSkeleton } from '../../kit/NodeSkeleton';
import { ToolbarButton } from '../../kit/FloatingToolbar';
import { useKitNodeActions } from '../../kit/hostContext';
import { resolveMediaUrl } from '../../../../utils/devOrigin';
import { toast } from '../../../../stores/useDialogStore';
import { AudioPlayer, type AudioPlayerHandle } from './AudioPlayer';
import { AudioSpeedPanel } from './AudioSpeedPanel';
import { AudioTrimDialog } from './AudioTrimDialog';
import { useAudioProcessing } from './useAudioProcessing';
import { dragMayCarryAudio, fileNameOf, loadAudioPatch, loadAudioUrlOf, readDropPayload, resolveDroppedAudioUrl, uploadAudioFile } from './media';
import './audio.css';

export interface LoadAudioData extends Record<string, unknown> {
  label?: string;
  audio_url?: string;
  audio?: string;
  url?: string;
  name?: string;
  asset_id?: string;
  duration?: number;
}

const EMPTY_DATA: LoadAudioData = {};

export function LoadAudioNode(props: NodeProps) {
  const { id } = props;
  const data = (props.data ?? EMPTY_DATA) as LoadAudioData;
  const actions = useKitNodeActions(id);
  const storedUrl = loadAudioUrlOf(data);
  const playUrl = resolveMediaUrl(storedUrl);
  const label = typeof data.label === 'string' && data.label ? data.label : '音频';
  const player = useRef<AudioPlayerHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const pause = useCallback(() => player.current?.pause(), []);
  const proc = useAudioProcessing({ sourceUrl: storedUrl, label, actions, onBeforeRun: pause });
  const busy = uploading || proc.processing;

  const fail = (e: unknown, title: string) => {
    const msg = String((e as Error)?.message || e || title);
    setNote(msg);
    toast.error(msg, title);
  };

  const uploadFile = async (file: File) => {
    if (busy) return;
    setUploading(true);
    setNote(null);
    try {
      const res = await uploadAudioFile(file, { projectId: actions.projectId });
      // ACT（Toonflow）：替换不删除旧音频，复制出的节点 / 撤销记录可能仍引用它
      actions.update(loadAudioPatch(res.url, { asset_id: res.assetId, name: res.name, duration: undefined }));
    } catch (e) {
      fail(e, '音频上传失败');
    } finally {
      setUploading(false);
    }
  };

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (file) void uploadFile(file);
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (busy || !dragMayCarryAudio(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (!dragOver) setDragOver(true);
  };
  const onDrop = async (e: DragEvent<HTMLDivElement>) => {
    setDragOver(false);
    const payload = readDropPayload(e.dataTransfer);
    if (!payload || busy) return;
    // 自己处理，不让宿主再按「拖素材到画布」新建节点
    e.preventDefault();
    e.stopPropagation();
    if (payload.file) {
      void uploadFile(payload.file);
      return;
    }
    setUploading(true);
    setNote(null);
    try {
      const res = await resolveDroppedAudioUrl(payload);
      actions.update(loadAudioPatch(res.url, { asset_id: res.assetId, name: res.name ?? fileNameOf(res.url), duration: undefined }));
    } catch (err) {
      fail(err, '无法使用该素材');
    } finally {
      setUploading(false);
    }
  };

  const toolbar = (
    <>
      <ToolbarButton icon={IconScissors} title="截取音频" disabled={!storedUrl || busy} onClick={() => proc.open('trim')}>截取</ToolbarButton>
      <ToolbarButton icon={IconGauge} title="音频变速" disabled={!storedUrl || busy} onClick={() => proc.open('speed')}>变速</ToolbarButton>
      <ToolbarButton icon={IconTransfer} title="替换音频" loading={uploading} disabled={proc.processing} onClick={() => fileInput.current?.click()}>替换音频</ToolbarButton>
    </>
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
      ) : undefined}
      panelWidth={440}
    >
      <div
        className={['cv-audio-content nopan', dragOver ? 'is-dragover' : ''].filter(Boolean).join(' ')}
        aria-busy={busy}
        onDragOver={onDragOver}
        onDragEnter={onDragOver}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
        }}
        onDrop={(e) => void onDrop(e)}
      >
        {playUrl ? (
          <AudioPlayer ref={player} src={playUrl} label={label} />
        ) : (
          <button
            type="button"
            className="cv-audio-upload nodrag"
            title="上传音频（也可拖入音频文件或素材库里的音频）"
            aria-label="上传音频"
            disabled={uploading}
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); fileInput.current?.click(); }}
          >
            {uploading ? <IconLoader2 size={32} className="cv-spin" aria-hidden /> : <IconUpload size={48} stroke={1.5} aria-hidden />}
            <span>{uploading ? '上传中…' : '上传音频 / 拖入素材'}</span>
          </button>
        )}
        {uploading && playUrl && (
          <div className="cv-audio-busy" role="status"><IconLoader2 size={18} className="cv-spin" aria-hidden />上传中…</div>
        )}
        <input ref={fileInput} type="file" accept="audio/*" hidden aria-label="选择音频" disabled={busy} onChange={onFileChange} />
      </div>
      {note && <div className="cv-audio-note is-error" role="alert" title={note}>{note}</div>}
      {proc.mode === 'trim' && playUrl && (
        <AudioTrimDialog
          src={playUrl}
          processing={proc.processing}
          error={proc.error}
          onClose={proc.close}
          onRun={(s, e) => void proc.runTrim(s, e)}
        />
      )}
    </NodeSkeleton>
  );
}
