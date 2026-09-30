// -*- coding: utf-8 -*-
/**
 * 统一多模态资源选择器 (Unified Asset & Context Picker Modal)
 * 4 大真实数据源：画布产出资源 + 角色库立绘 + 项目素材库 + 本地上传
 */
import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Search,
  Grid,
  List as ListIcon,
  Check,
  UploadCloud,
  ImageIcon,
  Video,
  Music,
  Users,
  FolderOpen,
  Sparkles,
  UserCheck
} from 'lucide-react';
import { useCanvasStore } from '../../stores/useCanvasStore';
import { useProjectStore } from '../../stores/useProjectStore';
import { apiService } from '../../services/api';
import { useEscapeClose } from '../../hooks/useEscapeClose';
import { AutoRatioMedia } from '../ui/AutoRatioMedia';

import { API_ORIGIN } from '../../utils/devOrigin';
// 相对产物 URL（/storage、/assets）在 dev 下必须回源，否则缩略图 404；存值保持原样，仅展示拼接
const resolveUrl = (u?: string) => (u && u.startsWith('/') ? API_ORIGIN + u : (u || ''));

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (url: string | string[], meta?: any) => void;
  slotKey: string;
  slotLabel: string;
  multiSelect?: boolean;
  acceptType?: 'image' | 'video' | 'audio' | 'all';
}

export const CanvasResourcePickerModal: React.FC<Props> = ({
  isOpen,
  onClose,
  onSelect,
  slotKey,
  slotLabel,
  multiSelect = false,
  acceptType = 'all',
}) => {
  const [activeTab, setActiveTab] = useState<'canvas' | 'characters' | 'assets' | 'upload'>('canvas');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedUrls, setSelectedUrls] = useState<string[]>([]);
  /** 选中项 → 元数据（visual_prompt/voice_id），确认时回传给 NodeAgentBar/Console 自动填 prompt */
  const [metaMap, setMetaMap] = useState<Record<string, any>>({});
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [uploading, setUploading] = useState(false);

  // 1. 画布资源
  const canvasAssets = useCanvasStore((s) => s.canvasAssets);

  // 2. 角色库
  const project = useProjectStore((s) => s.project);
  const characters = project?.characters || [];

  // 3. 项目素材库：打开即直拉（不依赖素材库面板的 store 缓存，否则没进过面板就永远是空的）
  const [libAssets, setLibAssets] = useState<any[]>([]);
  const [libLoading, setLibLoading] = useState(false);
  useEffect(() => {
    if (!isOpen) return;
    // 切槽位/重开时清掉上次的勾选与搜索，避免串槽
    setSelectedUrls([]);
    setMetaMap({});
    setSearchQuery('');
    let cancelled = false;
    (async () => {
      setLibLoading(true);
      try {
        let pid: string | undefined;
        try {
          const pls = await import('../../stores/useProjectListStore');
          pid = pls.useProjectListStore.getState().activeProjectId || undefined;
        } catch {}
        if (!pid) {
          try { pid = useProjectStore.getState().activeProjectId || undefined; } catch {}
        }
        const r: any = await apiService.listAssets({ project_id: pid, include_shared: true, limit: 100 } as any);
        if (!cancelled) setLibAssets(r?.assets || []);
      } catch {
        if (!cancelled) setLibAssets([]);
      } finally {
        if (!cancelled) setLibLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, slotKey]);
  const allProjectAssets = libAssets;

  useEscapeClose(isOpen, onClose);
  if (!isOpen) return null;

  // 过滤画布资源
  const filteredCanvasAssets = canvasAssets.filter((a) => {
    if (acceptType !== 'all' && a.type !== acceptType) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (a.name || '').toLowerCase().includes(q) || (a.sourceNodeType || '').toLowerCase().includes(q);
    }
    return true;
  });

  // 过滤角色库
  const filteredCharacters = characters.filter((c) => {
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (c.name || '').toLowerCase().includes(q) || (c.visual_prompt || '').toLowerCase().includes(q);
    }
    return true;
  });

  // 过滤素材库 - 资产 category 与槽位类型解耦：image 槽接受 character/scene/prop 等所有带图资产
  const filteredProjectAssets = allProjectAssets.filter((a: any) => {
    if (acceptType !== 'all') {
      if (acceptType === 'image') {
        // 图像类资产：category 为 character/scene/prop/background/effect 或 type image，或有图片 URL
        const isImageAsset =
          ['character', 'scene', 'prop', 'background', 'effect', 'ui', 'image', 'other'].includes(a.category) ||
          a.type === 'image' ||
          !!a.file_url ||
          !!a.thumb_url;
        // 排除纯音频/视频资产
        if (a.category === 'audio' || a.type === 'audio' || a.category === 'video' || a.type === 'video') return false;
        if (!isImageAsset) return false;
      } else if (acceptType === 'audio') {
        if (a.category !== 'audio' && a.type !== 'audio') return false;
      } else if (acceptType === 'video') {
        if (a.category !== 'video' && a.type !== 'video') return false;
      } else {
        if (a.category !== acceptType && a.type !== acceptType) return false;
      }
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (a.name || '').toLowerCase().includes(q) || (a.tags || []).some((t: string) => t.toLowerCase().includes(q));
    }
    return true;
  });

  const handleToggleSelect = (url: string, meta?: any) => {
    if (!url) return;
    const isSel = selectedUrls.includes(url);
    let next: string[];
    if (multiSelect) next = isSel ? selectedUrls.filter((u) => u !== url) : [...selectedUrls, url];
    else next = isSel ? [] : [url];
    setSelectedUrls(next);
    // 记住每个选中项的元数据（visual_prompt/voice_id），确认时回传给节点自动填 prompt
    setMetaMap((prev) => {
      const m: Record<string, any> = { ...prev };
      if (meta) m[url] = meta;
      for (const k of Object.keys(m)) if (!next.includes(k)) delete m[k];
      return m;
    });
  };

  const metaOf = (urls: string[]) => urls.map((u) => metaMap[u]).find((m) => m && (m.visual_prompt || m.voice_id)) || undefined;

  const handleConfirmMulti = () => {
    if (selectedUrls.length > 0) {
      onSelect(selectedUrls, metaOf(selectedUrls));
      onClose();
    }
  };

  // 上传走资产库通道成功后刷新本弹窗列表，下次打开即见
  const refreshLib = async () => {
    try {
      let pid: string | undefined;
      try {
        const pls = await import('../../stores/useProjectListStore');
        pid = pls.useProjectListStore.getState().activeProjectId || undefined;
      } catch {}
      const r: any = await apiService.listAssets({ project_id: pid, include_shared: true, limit: 100 } as any);
      setLibAssets(r?.assets || []);
    } catch {}
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const urls: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const isImage = file.type.startsWith('image/');
        const isAudio = file.type.startsWith('audio/');
        const isVideo = file.type.startsWith('video/');
        try {
          // 根据文件类型选择上传通道：图片走 ComfyUI，音视频走通用资产上传后取 file_url
          if (isImage) {
            const res = await apiService.uploadImageToComfyUI(file);
            if (res?.name) {
              const name = res.name;
              urls.push(name.startsWith('http') || name.startsWith('/') ? name : `/storage/images/${name}`);
              continue;
            }
          }
          // 音视频或图片降级：尝试走资产库上传
          const fd = new FormData();
          fd.append('file', file);
          fd.append('name', file.name.replace(/\.[^/.]+$/, ''));
          fd.append('category', isAudio ? 'audio' : isVideo ? 'video' : 'character');
          try {
            const assetRes: any = await apiService.createAsset(fd);
            const u = assetRes?.asset?.file_url || assetRes?.file_url || assetRes?.url;
            if (u) {
              urls.push(u);
              refreshLib();
              continue;
            }
          } catch {}
          // 最终降级：本地对象 URL（临时预览，刷新后丢失）
          urls.push(URL.createObjectURL(file));
        } catch {
          urls.push(URL.createObjectURL(file));
        }
      }
      if (urls.length > 0) {
        if (multiSelect) {
          onSelect(urls);
        } else {
          onSelect(urls[0]);
        }
        onClose();
      }
    } catch (err: any) {
      alert(`上传失败: ${err.message}`);
    } finally {
      setUploading(false);
      // 重置 input 以便同一文件可重复选择
      e.target.value = '';
    }
  };

  return createPortal(
    // Portal 到 body：操作台/底部栏外壳带 translate 变换，fixed 会被它当成包含块并遭 overflow 裁剪
    // （表现为选择器被塞进底栏、画布内容出现在插槽组件下面）；z-[70] 保证盖在参数弹窗(z-[60])之上。
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in duration-200" onClick={onClose}>
      <div className="w-full max-w-4xl max-h-[85vh] bg-surface border border-white/10 rounded-2xl shadow-2xl flex flex-col overflow-hidden text-white" onClick={(e) => e.stopPropagation()}>
        {/* 顶部标题栏 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 bg-white/[0.02]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-violet-600/20 border border-violet-500/30 flex items-center justify-center text-violet-400">
              <FolderOpen className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white/95">加载资源 / 上下文</h3>
                <span className="text-xs px-2 py-0.5 rounded-full bg-violet-500/20 text-violet-300 font-mono border border-violet-500/30">
                  槽位: {slotLabel || slotKey}
                </span>
              </div>
              <p className="text-xs text-white/50">支持从画布生成产物、项目角色库、素材库中一键加载到当前节点</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab 切换与搜索栏 */}
        <div className="px-6 py-3 border-b border-white/10 bg-white/[0.01] flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-1 bg-surface-secondary p-1 rounded-xl border border-white/10">
            <button
              onClick={() => setActiveTab('canvas')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all ${
                activeTab === 'canvas'
                  ? 'bg-violet-600 text-white shadow-lg shadow-violet-600/30'
                  : 'text-white/60 hover:text-white hover:bg-white/5'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              画布上的资源 ({canvasAssets.length})
            </button>
            <button
              onClick={() => setActiveTab('characters')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all ${
                activeTab === 'characters'
                  ? 'bg-violet-600 text-white shadow-lg shadow-violet-600/30'
                  : 'text-white/60 hover:text-white hover:bg-white/5'
              }`}
            >
              <Users className="w-3.5 h-3.5" />
              角色库 ({characters.length})
            </button>
            <button
              onClick={() => setActiveTab('assets')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all ${
                activeTab === 'assets'
                  ? 'bg-violet-600 text-white shadow-lg shadow-violet-600/30'
                  : 'text-white/60 hover:text-white hover:bg-white/5'
              }`}
            >
              <FolderOpen className="w-3.5 h-3.5" />
              场景/素材库 ({allProjectAssets.length})
            </button>
            <button
              onClick={() => setActiveTab('upload')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all ${
                activeTab === 'upload'
                  ? 'bg-violet-600 text-white shadow-lg shadow-violet-600/30'
                  : 'text-white/60 hover:text-white hover:bg-white/5'
              }`}
            >
              <UploadCloud className="w-3.5 h-3.5" />
              本地上传
            </button>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-white/40" />
              <input
                type="text"
                placeholder="搜索资源..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-44 bg-surface-secondary border border-white/10 rounded-xl pl-9 pr-3 py-1.5 text-xs text-white placeholder-white/40 focus:outline-none focus:border-violet-500 transition-colors"
              />
            </div>
            <div className="flex items-center bg-surface-secondary border border-white/10 rounded-lg p-0.5">
              <button
                onClick={() => setViewMode('grid')}
                className={`p-1.5 rounded ${viewMode === 'grid' ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white'}`}
              >
                <Grid className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setViewMode('list')}
                className={`p-1.5 rounded ${viewMode === 'list' ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white'}`}
              >
                <ListIcon className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* 内容展示区 */}
        <div className="flex-1 overflow-y-auto p-6 min-h-0">
          {/* Tab 1: 画布上的资源 */}
          {activeTab === 'canvas' && (
            <>
              {filteredCanvasAssets.length === 0 ? (
                <div className="h-64 flex flex-col items-center justify-center text-white/40 text-center gap-2">
                  <ImageIcon className="w-10 h-10 stroke-[1.5]" />
                  <p className="text-sm">当前画布暂无已生成的资源</p>
                  <p className="text-xs text-white/30">在画布中运行生图或视频节点后，产物将自动汇聚在此</p>
                </div>
              ) : (
                <div
                  className={
                    viewMode === 'grid'
                      ? 'grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3 items-start'
                      : 'flex flex-col gap-2'
                  }
                >
                  {filteredCanvasAssets.map((asset) => {
                    const isSelected = selectedUrls.includes(asset.url);
                    return (
                      <div
                        key={asset.id}
                        onClick={() => handleToggleSelect(asset.url, asset)}
                        className={`group relative rounded-xl border overflow-hidden cursor-pointer transition-all ${
                          isSelected
                            ? 'border-violet-500 ring-2 ring-violet-500/50 bg-violet-950/20'
                            : 'border-white/10 hover:border-white/30 bg-white/[0.02]'
                        }`}
                      >
                        <AutoRatioMedia
                          src={resolveUrl(asset.url)}
                          kind={asset.type === 'video' ? 'video' : 'image'}
                          alt={asset.name}
                          fallbackAspect="9/16"
                          className="w-full bg-surface-secondary"
                          mediaClassName="group-hover:scale-105 transition-transform duration-300"
                          videoProps={{ muted: true }}
                        >
                          <div className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-surface/85 backdrop-blur-md text-[10px] font-mono text-white/80 border border-white/10">
                            {asset.sourceNodeType}
                          </div>
                          {isSelected && (
                            <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-violet-600 flex items-center justify-center text-white shadow-lg">
                              <Check className="w-3.5 h-3.5" />
                            </div>
                          )}
                        </AutoRatioMedia>
                        <div className="p-2 bg-surface-secondary border-t border-white/5">
                          <div className="text-xs font-medium text-white/90 truncate">{asset.name}</div>
                          <div className="text-[10px] text-white/40 truncate">{asset.url.split('/').pop()}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {/* Tab 2: 角色库 */}
          {activeTab === 'characters' && (
            <>
              {filteredCharacters.length === 0 ? (
                <div className="h-64 flex flex-col items-center justify-center text-white/40 text-center gap-2">
                  <Users className="w-10 h-10 stroke-[1.5]" />
                  <p className="text-sm">项目角色库为空</p>
                  <p className="text-xs text-white/30">可在角色工作台创建角色并上传三视图与设定立绘</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4 items-start">
                  {filteredCharacters.map((char: any) => {
                    const _ctv = (char.three_views || {}) as Record<string, string>;
                    const avatar = char.avatar_url || char.avatar || _ctv.front || _ctv.three_quarter || _ctv.side || (char.reference_images && char.reference_images[0]) || '';
                    const isSelected = selectedUrls.includes(avatar);
                    return (
                      <div
                        key={char.id}
                        onClick={() => handleToggleSelect(avatar, char)}
                        className={`group relative rounded-2xl border p-3 flex flex-col gap-3 cursor-pointer transition-all ${
                          isSelected
                            ? 'border-violet-500 ring-2 ring-violet-500/50 bg-violet-950/20'
                            : 'border-white/10 hover:border-white/30 bg-white/[0.02]'
                        }`}
                      >
                        {avatar ? (
                          <AutoRatioMedia
                            src={resolveUrl(avatar)}
                            alt={char.name}
                            fallbackAspect="1/1"
                            className="w-full rounded-xl bg-surface-secondary border border-white/10"
                            mediaClassName="group-hover:scale-105 transition-transform"
                          >
                            {isSelected && (
                              <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-violet-600 flex items-center justify-center text-white shadow-lg">
                                <Check className="w-3.5 h-3.5" />
                              </div>
                            )}
                          </AutoRatioMedia>
                        ) : (
                          <div className="aspect-square w-full rounded-xl bg-surface-secondary overflow-hidden relative border border-white/10 flex items-center justify-center">
                            <UserCheck className="w-10 h-10 text-white/20" />
                          </div>
                        )}
                        <div>
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-bold text-white/95 truncate">{char.name}</span>
                            {char.voice_id && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded bg-pink-500/20 text-pink-300 font-mono border border-pink-500/30">
                                配音
                              </span>
                            )}
                          </div>
                          {char.visual_prompt && (
                            <p className="text-[10px] text-white/50 line-clamp-2 mt-1">{char.visual_prompt}</p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {/* Tab 3: 场景与素材库 */}
          {activeTab === 'assets' && (
            <>
              {libLoading ? (
                <div className="h-64 flex flex-col items-center justify-center text-white/40 text-center gap-2">
                  <div className="w-8 h-8 border-2 border-violet-400 border-t-transparent rounded-full animate-spin" />
                  <p className="text-sm">正在加载素材库…</p>
                </div>
              ) : filteredProjectAssets.length === 0 ? (
                <div className="h-64 flex flex-col items-center justify-center text-white/40 text-center gap-2">
                  <FolderOpen className="w-10 h-10 stroke-[1.5]" />
                  <p className="text-sm">素材库暂无资产</p>
                  <p className="text-xs text-white/30">可在素材库面板中添加场景概念图与道具参考</p>
                </div>
              ) : (
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3 items-start">
                  {filteredProjectAssets.map((asset: any) => {
                    const u = asset.file_url || asset.url || asset.thumb_url || '';
                    const isSelected = selectedUrls.includes(u);
                    return (
                      <div
                        key={asset.id}
                        onClick={() => handleToggleSelect(u, asset)}
                        className={`group relative rounded-xl border overflow-hidden cursor-pointer transition-all ${
                          isSelected
                            ? 'border-violet-500 ring-2 ring-violet-500/50 bg-violet-950/20'
                            : 'border-white/10 hover:border-white/30 bg-white/[0.02]'
                        }`}
                      >
                        {asset.category === 'video' || asset.type === 'video' ? (
                          u ? (
                            <AutoRatioMedia
                              src={resolveUrl(u)}
                              kind="video"
                              alt={asset.name}
                              fallbackAspect="16/9"
                              className="w-full bg-surface-secondary"
                              mediaClassName="group-hover:scale-105 transition-transform"
                              videoProps={{ muted: true }}
                            >
                              {isSelected && (
                                <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-violet-600 flex items-center justify-center text-white shadow-lg">
                                  <Check className="w-3.5 h-3.5" />
                                </div>
                              )}
                            </AutoRatioMedia>
                          ) : (
                            <div className="aspect-[4/3] w-full bg-surface-secondary relative overflow-hidden flex items-center justify-center"><Video className="w-8 h-8 text-orange-400" /></div>
                          )
                        ) : asset.category === 'audio' || asset.type === 'audio' ? (
                          <div className="aspect-[4/3] w-full bg-surface-secondary relative overflow-hidden flex items-center justify-center"><Music className="w-8 h-8 text-pink-400" /></div>
                        ) : u ? (
                          <AutoRatioMedia
                            src={resolveUrl(u)}
                            alt={asset.name}
                            fallbackAspect="4/3"
                            className="w-full bg-surface-secondary"
                            mediaClassName="group-hover:scale-105 transition-transform"
                          >
                            {isSelected && (
                              <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-violet-600 flex items-center justify-center text-white shadow-lg">
                                <Check className="w-3.5 h-3.5" />
                              </div>
                            )}
                          </AutoRatioMedia>
                        ) : (
                          <div className="aspect-[4/3] w-full bg-surface-secondary relative overflow-hidden flex items-center justify-center"><ImageIcon className="w-8 h-8 text-white/30" /></div>
                        )}
                        <div className="p-2 bg-surface-secondary border-t border-white/5">
                          <div className="text-xs font-medium text-white/90 truncate">{asset.name || '未命名资产'}</div>
                          <div className="text-[10px] text-white/40 truncate">{asset.category || asset.type || 'asset'}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {/* Tab 4: 本地上传 */}
          {activeTab === 'upload' && (
            <div className="h-64 flex flex-col items-center justify-center border-2 border-dashed border-white/15 rounded-2xl p-6 text-center hover:border-violet-500/50 transition-colors bg-white/[0.01]">
              <UploadCloud className="w-12 h-12 text-violet-400 mb-3 animate-bounce" />
              <p className="text-sm font-bold text-white mb-1">
                {uploading ? '上传中...' : '拖拽文件到此处，或点击浏览'}
              </p>
              <p className="text-xs text-white/40 mb-4">支持 JPG, PNG, WebP, MP4, MP3 等格式</p>
              <label className="px-5 py-2 rounded-xl bg-violet-600 text-white text-xs font-bold hover:bg-violet-500 cursor-pointer shadow-lg shadow-violet-600/30 transition-all">
                选择本地文件
                <input
                  type="file"
                  multiple={multiSelect}
                  accept={acceptType === 'video' ? 'video/*' : acceptType === 'audio' ? 'audio/*' : acceptType === 'image' ? 'image/*' : '*/*'}
                  onChange={handleFileUpload}
                  className="hidden"
                  disabled={uploading}
                />
              </label>
            </div>
          )}
        </div>

        {/* 底部确认栏 - 始终显示，修复无法确定/退出 */}
        <div className="px-6 py-3 border-t border-white/10 bg-surface flex items-center justify-between shrink-0">
          <span className="text-xs text-white/60">
            {selectedUrls.length === 0 ? (
              <span>未选择 {multiSelect ? '· 可多选' : ''}</span>
            ) : multiSelect ? (
              <>已选 <strong className="text-violet-400 font-mono">{selectedUrls.length}</strong> 项</>
            ) : (
              <>已选 <strong className="text-violet-400 font-mono">1</strong> 项</>
            )}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-1.5 rounded-xl border border-white/10 text-xs font-semibold text-white/70 hover:text-white hover:bg-white/5 transition-colors"
            >
              取消
            </button>
            <button
              onClick={() => {
                if (multiSelect) handleConfirmMulti();
                else if (selectedUrls.length > 0) {
                  onSelect(selectedUrls[0], metaMap[selectedUrls[0]]);
                  onClose();
                }
              }}
              disabled={selectedUrls.length === 0}
              className="px-5 py-1.5 rounded-xl bg-violet-600 text-white text-xs font-bold hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-lg shadow-violet-600/30"
            >
              确认{multiSelect && selectedUrls.length > 0 ? ` (${selectedUrls.length})` : ''}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
