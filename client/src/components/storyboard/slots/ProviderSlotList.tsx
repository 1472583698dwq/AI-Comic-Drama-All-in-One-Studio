import React from 'react';
import { Upload, UserCheck, FolderOpen, X } from 'lucide-react';
import { AutoRatioMedia } from '../../ui/AutoRatioMedia';

/**
 * 生成源插槽挂载区：完全按该源 input_schema 声明的媒体槽位逐条渲染（首帧/尾帧/参考图/参考音频…），
 * 源未声明即不显示，不再有任何按 kind 写死的输入块。
 * （自 ShotInspector 原样搬移，零改动）
 */
export const ProviderSlotList: React.FC<{
  slots: any[];
  values: Record<string, any>;
  uploadingKey: string | null;
  onWrite: (keys: string[], v: any) => void;
  onUpload: (keys: string[], files: File | File[], multi: boolean, maxCount?: number) => void;
  onPickFromLibrary: (slot: any, keys: string[], multi: boolean, replaceIndex?: number) => void;
  onInjectCharacter?: (keys: string[], multi: boolean) => void;
  resolveUrl: (u?: string | null) => string;
}> = ({ slots, values, uploadingKey, onWrite, onUpload, onPickFromLibrary, onInjectCharacter, resolveUrl }) => {
  if (!slots.length) return null;
  return (
    <div className="space-y-1.5">
      {slots.map((slot: any) => {
        const writeKeys = Array.from(new Set([slot.key, slot.originalKey].filter(Boolean) as string[]));
        const raw = values[slot.key] ?? (slot.originalKey ? values[slot.originalKey] : undefined);
        const urls: string[] = Array.isArray(raw) ? raw.filter(Boolean).map(String) : (raw ? [String(raw)] : []);
        const isMulti = !!slot.multi || (slot.maxCount ?? 1) > 1;
        const typeWord = slot.type === 'audio' ? '音频' : slot.type === 'video' ? '视频' : '图片';
        const maxCount = isMulti ? Math.max(1, Number(slot.maxCount) || 8) : 1;
        const canAdd = urls.length < maxCount;
        return (
          <div key={slot.key} className="space-y-1 bg-surface-secondary border border-border/80 rounded-lg p-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-gray-300 font-medium">{slot.label}{slot.required && <span className="text-red-400"> *</span>}</span>
              <span className="text-[9px] text-gray-500 font-mono" title={slot.description || ''}>{slot.originalKey || slot.key}</span>
            </div>

            {urls.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                {urls.map((u, idx) => (
                  <div key={`${u}:${idx}`} className="group/media relative">
                    <button
                      type="button"
                      onClick={() => onPickFromLibrary(slot, writeKeys, isMulti, idx)}
                      title="点击替换这一项"
                      className="block cursor-pointer overflow-hidden rounded-lg border border-border text-left transition-colors hover:border-brand/60 focus:outline-none focus:border-brand"
                    >
                      {slot.type === 'audio' ? (
                        <span className="block max-w-[150px] truncate rounded-lg bg-surface-secondary px-2 py-1 font-mono text-[10px] text-pink-300">
                          🎵 {u.split(/[\\/]/).pop()}
                        </span>
                      ) : (
                        <AutoRatioMedia src={resolveUrl(u)} fallbackAspect="1/1" maxHeight={64} />
                      )}
                      <span className="pointer-events-none absolute inset-0 hidden items-center justify-center rounded-lg bg-black/55 text-[10px] font-semibold text-white group-hover/media:flex">
                        点击替换
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onWrite(writeKeys, isMulti ? urls.filter((_, i) => i !== idx) : '');
                      }}
                      title="删除这一项"
                      aria-label={`删除第 ${idx + 1} 项`}
                      className="absolute -right-1.5 -top-1.5 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-white shadow-md transition-transform hover:scale-110"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => onWrite(writeKeys, isMulti ? [] : '')}
                  className="px-2 py-1 rounded bg-red-500/20 text-red-400 text-[11px] hover:bg-red-500/30"
                >
                  清空全部
                </button>
              </div>
            )}

            {canAdd ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {urls.length === 0 && slot.type === 'image' && onInjectCharacter && (
                  <button
                    type="button"
                    onClick={() => onInjectCharacter(writeKeys, isMulti)}
                    className="px-2 py-1 rounded bg-brand/20 hover:bg-brand/30 border border-brand/40 text-[11px] text-brand-light font-medium flex items-center gap-1 transition"
                    title="一键注入该分镜出场角色的立绘或三视图"
                  >
                    <UserCheck className="w-3 h-3" />
                    <span>🎭 注入当前角色</span>
                  </button>
                )}
                <label className="px-2 py-1 rounded bg-surface-tertiary hover:bg-surface-tertiary/80 border border-border text-[11px] text-gray-300 cursor-pointer flex items-center gap-1 transition">
                  <Upload className="w-3 h-3" />
                  <span>{uploadingKey === slot.key ? '上传中...' : `📁 ${urls.length ? '继续添加' : '上传'}${typeWord}`}</span>
                  <input
                    type="file"
                    multiple={isMulti}
                    accept={slot.type === 'image' ? 'image/*' : slot.type === 'audio' ? 'audio/*' : 'video/*'}
                    className="hidden"
                    onChange={(e) => {
                      const files = Array.from(e.target.files || []);
                      e.currentTarget.value = '';
                      if (!files.length) return;
                      const remaining = Math.max(1, maxCount - urls.length);
                      onUpload(writeKeys, isMulti ? files.slice(0, remaining) : files[0], isMulti, slot.maxCount);
                    }}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => onPickFromLibrary(slot, writeKeys, isMulti)}
                  className="px-2 py-1 rounded bg-surface-tertiary hover:bg-brand/20 border border-border text-[11px] text-gray-300 hover:text-brand-light flex items-center gap-1"
                >
                  <FolderOpen className="w-3 h-3" />
                  <span>素材库</span>
                </button>
                {isMulti && (
                  <span className="ml-auto font-mono text-[10px] text-gray-500">{urls.length}/{maxCount}</span>
                )}
              </div>
            ) : (
              <div className="text-[10px] text-gray-500">
                {isMulti ? `已达上限 ${maxCount} 项` : '已添加 1 项'}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
