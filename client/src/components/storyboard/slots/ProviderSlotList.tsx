import React from 'react';
import { Upload, UserCheck, FolderOpen } from 'lucide-react';

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
  onUpload: (keys: string[], f: File, multi: boolean) => void;
  onPickFromLibrary: (slot: any, keys: string[], multi: boolean) => void;
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
        return (
          <div key={slot.key} className="space-y-1 bg-surface-secondary border border-border/80 rounded-lg p-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-gray-300 font-medium">{slot.label}{slot.required && <span className="text-red-400"> *</span>}</span>
              <span className="text-[9px] text-gray-500 font-mono" title={slot.description || ''}>{slot.originalKey || slot.key}</span>
            </div>
            {urls.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                {urls.map((u) => (
                  slot.type === 'audio'
                    ? <span key={u} className="px-2 py-1 rounded bg-surface-secondary text-[10px] font-mono text-pink-300 max-w-[150px] truncate">🎵 {u.split(/[\\/]/).pop()}</span>
                    : <img key={u} src={resolveUrl(u)} alt="" className="w-16 h-16 rounded-lg object-cover border border-border" />
                ))}
                <button type="button" onClick={() => onWrite(writeKeys, isMulti ? [] : '')} className="px-2 py-1 rounded bg-red-500/20 text-red-400 text-[11px] hover:bg-red-500/30">清除</button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-1.5">
                {slot.type === 'image' && onInjectCharacter && (
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
                  <span>{uploadingKey === slot.key ? '上传中...' : `📁 上传${typeWord}`}</span>
                  <input
                    type="file"
                    accept={slot.type === 'image' ? 'image/*' : slot.type === 'audio' ? 'audio/*' : 'video/*'}
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) onUpload(writeKeys, f, isMulti);
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
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
