import React, { useState, useEffect, useRef } from 'react';
import { 
  Library, 
  Search, 
  Upload, 
  FolderOpen, 
  Check, 
  Users, 
  Mountain, 
  Box, 
  Image as ImageIcon, 
  Sparkles, 
  Layers, 
  X, 
  Plus,
  Filter
} from 'lucide-react';
import { apiService } from '../../services/api';
import { useProjectStore } from '../../stores/useProjectStore';
import { AssetCategory } from '../../types';
import { useEscapeClose } from '../../hooks/useEscapeClose';

interface AssetPickerModalProps {
  isOpen: boolean;
  title?: string;
  defaultCategory?: AssetCategory | 'all';
  onSelect: (asset: { id: string; name: string; url: string; category: string; visual_prompt?: string }) => void;
  onClose: () => void;
}

const CATEGORY_TABS: { key: AssetCategory | 'all'; label: string; icon: any }[] = [
  { key: 'all', label: '全部', icon: Library },
  { key: 'character', label: '人物', icon: Users },
  { key: 'scene', label: '场景', icon: Mountain },
  { key: 'prop', label: '道具', icon: Box },
  { key: 'background', label: '背景', icon: ImageIcon },
  { key: 'effect', label: '特效', icon: Sparkles },
  { key: 'other', label: '其他', icon: Layers },
];

const API_ORIGIN = 'http://127.0.0.1:8000';
const resolveUrl = (u?: string) => {
  if (!u) return '';
  return u.startsWith('/') ? API_ORIGIN + u : u;
};

export const AssetPickerModal: React.FC<AssetPickerModalProps> = ({
  isOpen,
  title = '从素材库选择素材',
  defaultCategory = 'all',
  onSelect,
  onClose,
}) => {
  const { project } = useProjectStore();
  const [selectedCat, setSelectedCat] = useState<AssetCategory | 'all'>(defaultCategory);
  const [searchQuery, setSearchQuery] = useState('');
  const [scope, setScope] = useState<'all' | 'project' | 'global'>('all');
  const [assets, setAssets] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      loadAssets();
    }
  }, [isOpen, selectedCat, scope, searchQuery]);

  const loadAssets = async () => {
    setIsLoading(true);
    try {
      const pid = scope === 'global' ? undefined : (project?.id || (useProjectStore.getState() as any).activeProjectId || undefined);
      const res = await apiService.listAssets({
        project_id: pid,
        category: selectedCat === 'all' ? undefined : selectedCat,
        q: searchQuery || undefined,
        scope: scope === 'all' ? undefined : scope,
        page: 1,
        limit: 80,
      });
      setAssets(res?.assets || []);
    } catch (e) {
      console.error('Failed to load assets', e);
    } finally {
      setIsLoading(false);
    }
  };

  const handleQuickUploadToLibrary = async (file: File) => {
    setIsUploading(true);
    try {
      const pid = project?.id || (useProjectStore.getState() as any).activeProjectId || undefined;
      const cat = selectedCat === 'all' ? 'character' : selectedCat;
      const fd = new FormData();
      const baseName = file.name.replace(/\.[^.]+$/, '') || '新素材';
      fd.append('name', baseName);
      fd.append('category', cat);
      fd.append('scope', pid ? 'project' : 'global');
      if (pid) fd.append('project_id', pid);
      fd.append('file', file);
      
      const created = await apiService.createAsset(fd);
      const imgUrl = created.file_url || created.thumb_url || created.image_url;
      
      // Auto select the newly uploaded asset
      if (imgUrl) {
        onSelect({
          id: created.id,
          name: created.name || baseName,
          url: imgUrl,
          category: created.category || cat,
          visual_prompt: created.visual_prompt,
        });
        onClose();
      }
    } catch (e: any) {
      alert(`上传到素材库失败: ${e.message || e}`);
    } finally {
      setIsUploading(false);
    }
  };

  useEscapeClose(isOpen, onClose);
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-4">
      <div className="bg-surface border border-border rounded-2xl w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden shadow-2xl animate-fade-in">
        {/* Header */}
        <div className="p-4 border-b border-border flex items-center justify-between bg-surface-secondary/60 shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-brand/10 border border-brand/20 flex items-center justify-center">
              <Library className="w-4 h-4 text-brand" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">{title}</h3>
              <p className="text-[11px] text-gray-400">从统一素材中心即点即用，或上传新素材并归档</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="px-3 py-1.5 rounded-xl bg-brand hover:bg-brand-light text-white text-xs font-bold flex items-center gap-1.5 shadow-md transition-all disabled:opacity-50"
              title="将本地文件上传并保存到素材库"
            >
              <Upload className={`w-3.5 h-3.5 ${isUploading ? 'animate-bounce' : ''}`} />
              <span>{isUploading ? '正在保存到素材库...' : '+ 上传素材入库'}</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={e => e.target.files?.[0] && handleQuickUploadToLibrary(e.target.files[0])}
            />

            <button
              onClick={onClose}
              className="w-8 h-8 rounded-full bg-surface-secondary hover:bg-surface-tertiary flex items-center justify-center text-gray-400 hover:text-white transition-all text-sm ml-1"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Filter Toolbar */}
        <div className="p-3 border-b border-border bg-surface-secondary/30 flex flex-wrap items-center justify-between gap-3 shrink-0">
          {/* Category Tabs */}
          <div className="flex items-center gap-1 overflow-x-auto custom-scrollbar pb-0.5">
            {CATEGORY_TABS.map((t) => {
              const Icon = t.icon;
              const isSelected = selectedCat === t.key;
              return (
                <button
                  key={t.key}
                  onClick={() => setSelectedCat(t.key)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition-all ${
                    isSelected
                      ? 'bg-brand text-white shadow-sm'
                      : 'bg-surface-secondary border border-border text-gray-400 hover:text-white hover:border-brand/40'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{t.label}</span>
                </button>
              );
            })}
          </div>

          {/* Search & Scope Filter */}
          <div className="flex items-center gap-2">
            <select
              value={scope}
              onChange={e => setScope(e.target.value as any)}
              className="bg-surface-secondary border border-border rounded-xl px-2.5 py-1 text-xs text-gray-300 focus:outline-none"
            >
              <option value="all">全部范围</option>
              <option value="project">仅当前项目</option>
              <option value="global">全局素材库</option>
            </select>

            <div className="relative">
              <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="搜索素材名 / 标签..."
                className="w-44 bg-surface-secondary border border-border rounded-xl pl-8 pr-3 py-1 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand"
              />
            </div>
          </div>
        </div>

        {/* Asset Cards Grid */}
        <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
          {isLoading ? (
            <div className="py-20 flex flex-col items-center justify-center text-gray-500 text-xs space-y-2">
              <div className="w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
              <span>正在检索素材库...</span>
            </div>
          ) : assets.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3.5">
              {assets.map((asset) => {
                const img = asset.file_url || asset.thumb_url || asset.image_url;
                if (!img) return null;
                const catLabel = CATEGORY_TABS.find(c => c.key === asset.category)?.label || '素材';

                return (
                  <div
                    key={asset.id}
                    onClick={() => {
                      onSelect({
                        id: asset.id,
                        name: asset.name,
                        url: img,
                        category: asset.category,
                        visual_prompt: asset.visual_prompt,
                      });
                      onClose();
                    }}
                    className="group rounded-2xl overflow-hidden border border-border bg-surface-secondary/70 cursor-pointer hover:border-brand hover:ring-2 hover:ring-brand/40 transition-all flex flex-col relative shadow-sm"
                  >
                    <div className="aspect-[3/4] bg-surface-secondary overflow-hidden relative">
                      <img
                        src={resolveUrl(img)}
                        alt={asset.name}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                      />
                      <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-surface/85 text-[9px] text-gray-200 border border-white/10 font-mono">
                        {catLabel}
                      </span>
                      {asset.scope === 'global' && (
                        <span className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded bg-brand/80 text-[8px] text-white font-bold">
                          全局
                        </span>
                      )}

                      <div className="absolute inset-0 bg-brand/20 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <span className="px-3 py-1 rounded-full bg-brand text-white text-xs font-bold shadow-lg flex items-center gap-1">
                          <Check className="w-3 h-3" /> 点击选用
                        </span>
                      </div>
                    </div>

                    <div className="p-2">
                      <p className="text-xs font-bold text-white truncate">{asset.name}</p>
                      {asset.visual_prompt ? (
                        <p className="text-[10px] text-gray-400 truncate mt-0.5">{asset.visual_prompt}</p>
                      ) : (
                        <p className="text-[10px] text-gray-500 truncate mt-0.5">已收录于素材库</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="py-20 flex flex-col items-center justify-center text-gray-500 text-xs space-y-3">
              <FolderOpen className="w-12 h-12 text-gray-600 stroke-[1.2]" />
              <span className="text-sm font-semibold text-gray-400">素材库中暂无匹配的素材</span>
              <p className="text-[11px] text-gray-500 max-w-sm text-center">
                您可以直接点击右上角【+ 上传素材入库】将本地图片归档到素材库，或前往「素材」频道生成新资产。
              </p>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-4 py-2 rounded-xl bg-brand text-white text-xs font-bold shadow-md hover:bg-brand-light"
              >
                + 立即上传并选用
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
