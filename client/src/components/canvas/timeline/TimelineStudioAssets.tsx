// -*- coding: utf-8 -*-
/**
 * 全屏编辑器左侧素材面板：已导入素材 / 我的资产 两页签 + 类型筛选 + 导入 + 拖拽落点。
 *
 * 「导入」按钮交给画布统一的四源选择器（画布产出 / 角色库 / 项目素材库 / 本地上传），
 * 本面板只额外负责「把文件拖到这里」这条最顺手的路径：拖进来即入素材库再入时间线，
 * 不做第二套上传实现。
 *
 * 只列视频与音频：合片内核不接受图片（后端有后缀白名单），列了也只会让用户白点。
 */
import React, { useEffect, useState } from 'react';
import { Loader2, Music, Plus, UploadCloud, Video as VideoIcon } from 'lucide-react';
import { apiService } from '../../../services/api';
import { resolveMediaUrl } from '../../../utils/devOrigin';
import { clipSpan, formatTimecode, mediaKindFromUrl, type TimelineClip } from '../../../types/timeline';

type Tab = 'imported' | 'library';
type KindFilter = 'all' | 'video' | 'audio';

interface Props {
  clips: TimelineClip[];
  projectId?: string;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onAddUrls: (urls: string[]) => void;
  onBrowse: () => void;
  onNotice: (message: string | null) => void;
}

export const TimelineStudioAssets: React.FC<Props> = ({
  clips,
  projectId,
  selectedId,
  onSelect,
  onAddUrls,
  onBrowse,
  onNotice,
}) => {
  const [tab, setTab] = useState<Tab>('imported');
  const [filter, setFilter] = useState<KindFilter>('all');
  const [assets, setAssets] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (tab !== 'library') return;
    setLoading(true);
    apiService
      .listAssets({ project_id: projectId, limit: 60, sort: 'updated_at' })
      .then((res: any) => setAssets(res?.assets || []))
      .catch((e) => console.error('[Timeline] 素材库加载失败', e))
      .finally(() => setLoading(false));
  }, [tab, projectId]);

  const matchFilter = (url: string) => {
    const kind = mediaKindFromUrl(url);
    if (!kind) return false;
    return filter === 'all' || filter === kind;
  };

  const handleFiles = (files: FileList | null) => {
    const list = Array.from(files || []).filter((f) => mediaKindFromUrl(f.name));
    if (!list.length) {
      onNotice('拖入的文件里没有视频或音频（合片只接受 mp4/mov/webm/mkv/wav/mp3/m4a/aac/flac/ogg）');
      return;
    }
    setUploading(true);
    apiService
      .batchImportAssets(list)
      .then((res: any) => {
        const urls = (res?.assets || []).map((a: any) => a.file_url || a.thumb_url).filter(Boolean);
        if (urls.length) {
          onAddUrls(urls);
          onNotice(`已导入 ${urls.length} 个素材到时间线`);
        } else {
          onNotice('素材入库失败，请改用「+ 导入」选择器重试');
        }
      })
      .catch((e) => onNotice(`本地文件导入失败：${e?.message || e}`))
      .finally(() => setUploading(false));
  };

  const chip = (id: KindFilter, label: string) => (
    <button
      key={id}
      onClick={() => setFilter(id)}
      className={`px-2 py-0.5 rounded-full text-[10px] border transition-colors ${
        filter === id
          ? 'border-brand/60 bg-brand/15 text-brand'
          : 'border-white/70 dark:border-white/12 [color:var(--color-text-muted)] hover:[color:var(--color-text-secondary)]'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div
      className={`w-[236px] shrink-0 my-3 ml-3 rounded-2xl border border-white/70 dark:border-white/12 overflow-hidden flex flex-col transition-colors ${dragging ? 'bg-brand/8' : ''}`}
      style={{ background: 'var(--color-surface)' }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        handleFiles(e.dataTransfer?.files || null);
      }}
    >
      {/* 页签 */}
      <div className="flex items-center px-2 pt-2 gap-1">
        {(['imported', 'library'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors ${
              tab === t ? 'bg-brand/15 text-brand' : '[color:var(--color-text-muted)] hover:[color:var(--color-text-secondary)]'
            }`}
          >
            {t === 'imported' ? '已导入素材' : '我的资产'}
          </button>
        ))}
        <button
          onClick={onBrowse}
          title="从画布产出 / 角色库 / 项目素材库 / 本地上传中挑选"
          className="ml-auto h-6 px-1.5 rounded-md border border-white/70 dark:border-white/12 text-[10.5px] [color:var(--color-text-secondary)] hover:text-brand hover:border-brand/50 flex items-center gap-0.5 transition-colors"
        >
          <Plus className="w-3 h-3" strokeWidth={2} />
          导入
        </button>
      </div>

      {/* 筛选 */}
      <div className="flex items-center gap-1 px-2 py-1.5">
        {chip('all', '全部')}
        {chip('video', '视频')}
        {chip('audio', '音频')}
        <span className="ml-auto text-[10px] [color:var(--color-text-muted)]">
          {tab === 'imported' ? clips.length : assets.length}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {tab === 'imported' && (
          <div className="space-y-1">
            {clips.length === 0 && (
              <div className="mt-6 rounded-xl border border-dashed border-white/70 dark:border-white/12 p-4 text-center text-[10.5px] leading-relaxed [color:var(--color-text-muted)]">
                将文件拖拽至此处添加
                <br />
                或点右上「导入」
              </div>
            )}
            {clips
              .filter((c) => filter === 'all' || c.kind === filter)
              .map((c) => (
                <button
                  key={c.id}
                  onClick={() => onSelect(c.id)}
                  className={`w-full flex items-center gap-2 p-1.5 rounded-lg border text-left transition-colors ${
                    selectedId === c.id ? 'border-brand/60 bg-brand/10' : 'border-white/70 dark:border-white/12 hover:border-brand/40'
                  }`}
                >
                  <span className="w-12 h-8 rounded-md overflow-hidden shrink-0 flex items-center justify-center" style={{ background: 'var(--color-surface-tertiary)' }}>
                    {c.kind === 'audio' ? (
                      <Music className="w-3.5 h-3.5 text-cyan-400/80" strokeWidth={1.7} />
                    ) : (
                      <video src={resolveMediaUrl(c.url)} muted preload="metadata" className="w-full h-full object-cover" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[10.5px] [color:var(--color-text-main)]">{c.name}</span>
                    <span className="block font-mono text-[9.5px] [color:var(--color-text-muted)]">{formatTimecode(clipSpan(c))}</span>
                  </span>
                </button>
              ))}
          </div>
        )}

        {tab === 'library' && (
          <div className="space-y-1">
            {loading && (
              <div className="flex items-center gap-1.5 text-[10.5px] [color:var(--color-text-muted)] p-2">
                <Loader2 className="w-3 h-3 animate-spin" /> 读取素材库…
              </div>
            )}
            {!loading && !assets.filter((a) => matchFilter(a.file_url || '')).length && (
              <div className="mt-6 rounded-xl border border-dashed border-white/70 dark:border-white/12 p-4 text-center text-[10.5px] leading-relaxed [color:var(--color-text-muted)]">
                素材库里还没有可用的视频 / 音频
                <br />
                将文件拖拽至此处添加
              </div>
            )}
            {!loading &&
              assets
                .filter((a) => matchFilter(a.file_url || ''))
                .map((a) => {
                  const url = a.file_url || a.thumb_url;
                  const isAudio = mediaKindFromUrl(url) === 'audio';
                  return (
                    <button
                      key={a.id}
                      onClick={() => onAddUrls([url])}
                      title={`${a.name} · 点击加入时间线`}
                      className="w-full flex items-center gap-2 p-1.5 rounded-lg border border-white/70 dark:border-white/12 hover:border-brand/50 text-left transition-colors"
                    >
                      <span className="w-12 h-8 rounded-md overflow-hidden shrink-0 flex items-center justify-center" style={{ background: 'var(--color-surface-tertiary)' }}>
                        {isAudio ? (
                          <Music className="w-3.5 h-3.5 text-cyan-400/80" strokeWidth={1.7} />
                        ) : (
                          <video src={resolveMediaUrl(url)} muted preload="metadata" className="w-full h-full object-cover" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[10.5px] [color:var(--color-text-main)]">{a.name}</span>
                        <span className="flex items-center gap-1 font-mono text-[9.5px] [color:var(--color-text-muted)]">
                          {isAudio ? <Music className="w-2.5 h-2.5" /> : <VideoIcon className="w-2.5 h-2.5" />}
                          {(url || '').split('.').pop()}
                        </span>
                      </span>
                    </button>
                  );
                })}
          </div>
        )}
      </div>

      {/* 拖拽高亮提示 */}
      {dragging && (
        <div className="mx-2 mb-2 rounded-xl border border-dashed border-brand/60 bg-brand/10 py-3 text-center text-[10.5px] text-brand flex items-center justify-center gap-1.5">
          {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UploadCloud className="w-3.5 h-3.5" strokeWidth={1.8} />}
          {uploading ? '入库中…' : '松手即加入时间线'}
        </div>
      )}

    </div>
  );
};
