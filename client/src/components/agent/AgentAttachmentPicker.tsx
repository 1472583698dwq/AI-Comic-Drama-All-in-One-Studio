/**
 * Agent 输入框的多模态附件选择器（轻量弹层，不占全局弹窗）。
 *
 * 三个来源：
 *   · 上传本地文件（图片/视频/音频，走 /agent/upload 存 storage/agent_uploads，不进素材库）
 *   · 画布产物（当前画布节点已生成的图/视频/音频，来自 useCanvasStore.canvasAssets）
 *   · 素材库（listAssets 前 60 条，图/视频/音频均可）
 *
 * 选中的每一项立即回传给调用方（可连续添加多个）；已添加项显示勾选态。
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  Upload, Image as ImageIcon, Film, Music, LayoutGrid, FolderOpen, Check, Loader2,
} from 'lucide-react';
import { apiService } from '../../services/api';
import { useCanvasStore } from '../../stores/useCanvasStore';
import { useProjectStore } from '../../stores/useProjectStore';
import { API_ORIGIN } from '../../utils/devOrigin';
import type { AgentAttachment } from './agentTypes';

const resolveUrl = (u?: string) => {
  if (!u) return '';
  return u.startsWith('/') ? API_ORIGIN + u : u;
};

const IMG_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|avif)(\?|#|$)/i;
const VIDEO_EXT_RE = /\.(mp4|mov|webm|mkv|avi|m4v)(\?|#|$)/i;
const AUDIO_EXT_RE = /\.(mp3|wav|m4a|aac|flac|ogg|opus|wma)(\?|#|$)/i;

export function kindOfUrl(url?: string): AgentAttachment['kind'] {
  if (!url) return 'image';
  if (VIDEO_EXT_RE.test(url)) return 'video';
  if (AUDIO_EXT_RE.test(url)) return 'audio';
  if (IMG_EXT_RE.test(url)) return 'image';
  return 'image';
}

const KIND_ICON: Record<string, any> = { image: ImageIcon, video: Film, audio: Music };

export interface AgentAttachmentPickerProps {
  /** 已选中的附件 ref 集合（用于勾选态） */
  selectedRefs: string[];
  onPick: (list: AgentAttachment[]) => void;
  onClose: () => void;
}

type Tab = 'upload' | 'canvas' | 'library';

export const AgentAttachmentPicker: React.FC<AgentAttachmentPickerProps> = ({ selectedRefs, onPick, onClose }) => {
  const [tab, setTab] = useState<Tab>('upload');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [assets, setAssets] = useState<any[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const canvasAssets = useCanvasStore((s) => s.canvasAssets);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  useEffect(() => {
    if (tab !== 'library' || assets.length > 0) return;
    setAssetsLoading(true);
    const pid = useProjectStore.getState().project?.id || undefined;
    apiService.listAssets({ project_id: pid, page: 1, limit: 60 })
      .then((res) => setAssets(res?.assets || []))
      .catch(() => setAssets([]))
      .finally(() => setAssetsLoading(false));
  }, [tab, assets.length]);

  const doUpload = async (files: FileList | File[]) => {
    const list = Array.from(files || []);
    if (!list.length) return;
    setUploading(true);
    setUploadError('');
    const picked: AgentAttachment[] = [];
    const errors: string[] = [];
    for (const f of list.slice(0, 8)) {
      try {
        const meta = await apiService.uploadAgentAttachment(f);
        if (meta?.ref) {
          picked.push({
            id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            kind: (meta.kind as AgentAttachment['kind']) || kindOfUrl(f.name),
            name: meta.name || f.name,
            ref: meta.ref,
            size: meta.size || f.size,
            mime: meta.mime || f.type,
            source: 'upload',
          });
        }
      } catch (e: any) {
        errors.push(`${f.name}: ${e?.message || '上传失败'}`);
      }
    }
    setUploading(false);
    if (picked.length) onPick(picked);
    if (errors.length) setUploadError(errors.slice(0, 2).join('；'));
  };

  const addFromUrl = (url: string, name: string, kind?: AgentAttachment['kind'], source: AgentAttachment['source'] = 'canvas', extra?: Record<string, string>) => {
    if (!url) return;
    onPick([{
      id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      kind: kind || kindOfUrl(url),
      name: name || String(url).split('/').pop() || '附件',
      ref: url,
      source,
      meta: extra,
    }]);
  };

  const row = (key: string, url: string, name: string, kind: AgentAttachment['kind'], source: AgentAttachment['source'], extra?: Record<string, string>) => {
    const Icon = KIND_ICON[kind] || ImageIcon;
    const picked = selectedRefs.includes(url);
    return (
      <button
        key={key}
        type="button"
        onClick={() => !picked && addFromUrl(url, name, kind, source, extra)}
        title={picked ? '已添加' : '添加到会话'}
        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${
          picked ? 'bg-emerald-500/10 border border-emerald-500/30' : 'hover:bg-white/65 dark:bg-white/[.09] border border-transparent'
        }`}
      >
        <span className="w-9 h-9 rounded-md overflow-hidden bg-white/60 dark:bg-white/[.05] border border-white/70 dark:border-white/12 shrink-0 flex items-center justify-center">
          {kind === 'image'
            ? <img src={resolveUrl(url)} alt="" className="w-full h-full object-cover" loading="lazy" />
            : <Icon className="w-4 h-4 [color:var(--color-text-muted)]" />}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-[11px] [color:var(--color-text-main)] truncate">{name}</span>
          <span className="block text-[9px] [color:var(--color-text-muted)] truncate">{url}</span>
        </span>
        {picked ? <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" /> : null}
      </button>
    );
  };

  return (
    <div
      ref={rootRef}
      className="absolute bottom-full mb-1.5 left-0 z-50 w-[320px] max-h-[340px] flex flex-col bg-surface border border-border rounded-2xl overflow-hidden animate-fade-in"
    >
      {/* 来源切换 */}
      <div className="flex items-center gap-1 p-1.5 border-b border-border bg-surface-secondary shrink-0">
        {([
          { id: 'upload', label: '上传', icon: Upload },
          { id: 'canvas', label: '画布', icon: LayoutGrid },
          { id: 'library', label: '素材库', icon: FolderOpen },
        ] as Array<{ id: Tab; label: string; icon: any }>).map((t) => {
          const Icon = t.icon;
          const on = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`flex-1 h-7 rounded-lg text-[10.5px] font-semibold inline-flex items-center justify-center gap-1 transition-colors ${
                on ? 'bg-brand/15 text-brand' : '[color:var(--color-text-muted)] hover:[color:var(--color-text-main)] hover:bg-surface-hover'
              }`}
            >
              <Icon className="w-3 h-3" />{t.label}
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar p-1.5">
        {tab === 'upload' && (
          <div className="p-2 space-y-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,video/*,audio/*"
              className="hidden"
              onChange={(e) => { void doUpload(e.target.files || []); if (fileInputRef.current) fileInputRef.current.value = ''; }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="w-full h-20 rounded-xl border border-dashed border-white/70 dark:border-white/12 hover:border-brand/50 hover:bg-brand/5 flex flex-col items-center justify-center gap-1.5 text-[11px] [color:var(--color-text-muted)] transition-colors disabled:opacity-50"
            >
              {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              <span>{uploading ? '正在上传…' : '选择本地图片 / 视频 / 音频（≤8MB）'}</span>
            </button>
            <p className="text-[10px] leading-relaxed [color:var(--color-text-muted)]">
              也可以直接 Ctrl+V 粘贴截图/文件到输入框。附件仅存本机 storage/agent_uploads，不进入素材库。
            </p>
            {uploadError && <p className="text-[10px] text-red-300">{uploadError}</p>}
          </div>
        )}

        {tab === 'canvas' && (
          canvasAssets.length === 0
            ? <p className="px-2 py-6 text-center text-[11px] [color:var(--color-text-muted)]">当前画布还没有生成产物（图/视频/音频）</p>
            : canvasAssets.map((a) => row(
                `cv_${a.id}`,
                a.url,
                `${a.name || '画布产物'} · ${a.sourceNodeType}#${a.sourceNodeId.slice(-4)}`,
                a.type,
                'canvas',
                { node_id: a.sourceNodeId },
              ))
        )}

        {tab === 'library' && (
          assetsLoading
            ? <p className="px-2 py-6 text-center text-[11px] [color:var(--color-text-muted)]">正在检索素材库…</p>
            : assets.length === 0
              ? <p className="px-2 py-6 text-center text-[11px] [color:var(--color-text-muted)]">素材库暂无可用素材</p>
              : assets.map((asset) => {
                  const url = asset.file_url || asset.thumb_url || asset.image_url;
                  if (!url) return null;
                  return row(
                    `lib_${asset.id}`,
                    url,
                    asset.name || asset.id,
                    kindOfUrl(url),
                    'asset',
                    { asset_id: asset.id },
                  );
                })
        )}
      </div>
    </div>
  );
};
