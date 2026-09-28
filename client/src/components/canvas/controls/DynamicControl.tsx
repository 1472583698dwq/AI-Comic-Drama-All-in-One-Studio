import React from 'react';
import { Upload, Image as ImageIcon } from 'lucide-react';
import { AiPolishButton } from '../../ui/AiPolishButton';
import { promptAsync } from '../../../stores/useDialogStore';

export type ControlSpec = {
  id: string;
  node_id?: string;
  param_name: string;
  label: string;
  alias?: string;
  type: 'text' | 'number' | 'combo' | 'image' | 'audio' | 'video' | 'boolean';
  component?: string;
  required?: boolean;
  default_value?: any;
  description?: string;
  options?: string[]; // for combo
  min?: number;
  max?: number;
  step?: number;
  // v1 标准扩展：分组、人机分工与语义角色（全部来自接口 schema 的 x-*，前端零参数名硬编码）
  category?: string; // layout/motion/quality/audio/advanced
  visibility?: 'basic' | 'advanced' | 'hidden';
  agent?: 'auto' | 'suggest' | 'manual';
  priority?: number;
  role?: string; // x-role: prompt / prompt_aux / dialogue ...
};

const agentBadge: Record<string, {label:string, cls:string, title:string}> = {
  auto: { label: 'Agent可填', cls: 'bg-violet-500/15 text-violet-300 border-violet-500/30', title: 'Agent 可自动代填（项目/上游推断），你改后不再覆盖' },
  suggest: { label: '建议', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30', title: 'Agent 仅在你未填时建议值，可手调' },
  manual: { label: '手填', cls: 'bg-white/10 text-white/50 border-white/15', title: '仅手填，Agent 不代填（seed/锁定项）' },
};

export const DynamicControl: React.FC<{
  spec: ControlSpec;
  value: any;
  onChange: (v:any)=>void;
  onAliasChange?: (alias:string)=>void;
  compact?: boolean;
}> = ({ spec, value, onChange, onAliasChange, compact }) => {
  const label = spec.alias || spec.label || spec.param_name;
  const desc = spec.description || '';
  const isMedia = spec.type==='image' || spec.type==='audio' || spec.type==='video';
  const isImage = spec.type==='image';
  const isAudio = spec.type==='audio';
  const isVideo = spec.type==='video';
  const isCombo = spec.type==='combo' || (spec.options && spec.options.length>0);
  // 下拉选项并入当前值，避免已保存的值不在枚举中时显示为空
  const rawOptions = (spec.options||[]).map(o=>String(o));
  const strVal = value==null||value==='' ? '' : String(value);
  const comboOptions = strVal && !rawOptions.includes(strVal) ? [strVal, ...rawOptions] : rawOptions;
  const isNumber = spec.type==='number';
  const isBool = spec.type==='boolean';

  const ag = spec.agent ? agentBadge[spec.agent] : null;
  return (
    <div className={`space-y-1.5 ${compact ? 'space-y-1' : ''}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium [color:var(--color-text-main)] truncate flex items-center gap-1.5" title={desc}>
          <span className="truncate">{label} <span className="[color:var(--color-text-muted)] font-normal">· {spec.param_name}</span> {spec.required && <span className="text-red-500">*</span>}</span>
          {ag && <span className={`shrink-0 text-[9px] px-1 py-0.5 rounded border font-medium ${ag.cls}`} title={ag.title}>{ag.label}</span>}
        </span>
        {onAliasChange && <button onClick={async ()=>{
          const nv = await promptAsync({
            title: '修改别名 / 显示名',
            message: `当前参数名：${spec.param_name}`,
            defaultValue: label,
            placeholder: '输入显示名'
          });
          if(nv && nv!==label) onAliasChange(nv);
        }} className="text-[10px] text-brand hover:underline shrink-0 font-medium">✎ 别名</button>}
      </div>
      {desc && <div className="text-[10px] [color:var(--color-text-muted)] leading-tight line-clamp-2">{desc}</div>}
      {isMedia ? (
        <label className="flex items-center gap-2 p-2 rounded-xl border border-dashed border-border bg-surface-secondary hover:bg-surface-tertiary hover:border-brand/40 cursor-pointer transition-colors">
          <div className="w-8 h-8 rounded bg-surface border border-border flex items-center justify-center shrink-0 overflow-hidden">
            {value ? (
              isImage ? <img src={value} alt="" className="w-full h-full object-cover"/> :
              isAudio ? <span className="text-[10px] font-mono truncate px-1 [color:var(--color-text-main)]">{String(value).slice(0,12)}…</span> :
              <span className="text-[10px]">🎬</span>
            ) : (
              isImage ? <ImageIcon className="w-4 h-4 [color:var(--color-text-muted)]"/> :
              isAudio ? <span className="text-xs">🎵</span> :
              <span className="text-xs">🎬</span>
            )}
          </div>
          <span className="text-xs [color:var(--color-text-secondary)] truncate flex-1">{value ? `已选择${isAudio?'音频':isVideo?'视频':'图片'} · 点击更换` : `点击上传${isAudio?'音频':isVideo?'视频':'图片'} / 拖拽素材 · 弹出文件系统`}</span>
          <input type="file" accept={isImage ? "image/*" : isAudio ? "audio/*" : "video/*"} className="hidden" onChange={e=>{
            const f=e.target.files?.[0]; if(!f) return;
            // 弹出文件系统后读取为 DataURL，自动映射到对应句柄（image/audio/video）
            const reader=new FileReader(); reader.onload=()=> onChange(reader.result as string); reader.readAsDataURL(f);
          }} />
        </label>
      ) : isCombo && comboOptions.length>0 ? (
        <select value={strVal || String(spec.default_value ?? '')} onChange={e=>{
          const v=e.target.value;
          // 保留数字类型
          if(spec.type==='number'){
            const num = Number(v);
            onChange(isNaN(num)?v:num);
          } else {
            onChange(v);
          }
        }} className="w-full bg-surface-secondary border border-border rounded-xl px-2.5 py-1.5 text-sm [color:var(--color-text-main)] focus:outline-none focus:border-brand">
          <option value="">{spec.required?'请选择':'自动'}</option>
          {comboOptions.map(o=> <option key={o} value={o}>{o}</option>)}
        </select>
      ) : isCombo ? (
        // combo 无可选选项（如 ComfyUI 离线拿不到枚举）时退化为可编辑文本，避免空下拉无法输入
        <input type="text" value={value ?? ''} onChange={e=> onChange(e.target.value)} placeholder={spec.description||''} className="w-full bg-surface-secondary border border-border rounded-xl px-2.5 py-1.5 text-sm [color:var(--color-text-main)] placeholder:[color:var(--color-text-muted)] focus:outline-none focus:border-brand"/>
      ) : isNumber ? (
        <div className="flex items-center gap-2">
          <input type="range" min={spec.min??0} max={spec.max??100} step={spec.step??1} value={value ?? spec.default_value ?? 0} onChange={e=> onChange(Number(e.target.value))} className="flex-1 accent-brand"/>
          <input type="number" value={value ?? spec.default_value ?? ''} onChange={e=> onChange(e.target.value===''? '' : Number(e.target.value))} className="w-20 bg-surface-secondary border border-border rounded-lg px-2 py-1 text-sm [color:var(--color-text-main)] focus:outline-none focus:border-brand"/>
        </div>
      ) : isBool ? (
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={!!value} onChange={e=> onChange(e.target.checked)} className="rounded accent-brand"/>
          <span className="text-xs [color:var(--color-text-main)]">{value ? '是' : '否'}</span>
        </label>
      ) : (
        <div className="space-y-1.5">
          {(spec.role === 'prompt' || spec.role === 'prompt_aux' || spec.role === 'dialogue') && (
            <div className="flex justify-end">
              <AiPolishButton value={String(value ?? '')} onPolish={(v: any) => onChange(v)} contextType={spec.role === 'dialogue' ? 'dialogue' : 'prompt'} size="xs" />
            </div>
          )}
          <textarea value={value ?? ''} onChange={e=> onChange(e.target.value)} placeholder={spec.description||''} rows={spec.role === 'prompt' || spec.role === 'dialogue' ? 2 : 1} className="w-full bg-surface-secondary border border-border rounded-xl p-2 text-sm [color:var(--color-text-main)] placeholder:[color:var(--color-text-muted)] focus:outline-none focus:border-brand resize-none"/>
        </div>
      )}
    </div>
  );
};

export const CATEGORY_LABEL: Record<string, string> = {
  layout: '版式',
  motion: '运动/时长',
  quality: '画质/采样',
  audio: '声音',
  advanced: '高级',
};

export function groupSpecs(specs: ControlSpec[]) {
  const visOrder = { basic: 0, advanced: 1, hidden: 2 } as const;
  const sorted = [...specs].sort((a,b)=>{
    const va = visOrder[(a.visibility||'advanced') as keyof typeof visOrder] ?? 1;
    const vb = visOrder[(b.visibility||'advanced') as keyof typeof visOrder] ?? 1;
    if (va !== vb) return va - vb;
    const pa = a.priority ?? 50, pb = b.priority ?? 50;
    if (pa !== pb) return pa - pb;
    return a.param_name.localeCompare(b.param_name);
  });
  const basic = sorted.filter(s=> (s.visibility||'advanced')==='basic' && s.visibility!=='hidden');
  const advanced = sorted.filter(s=> (s.visibility||'advanced')==='advanced');
  const hidden = sorted.filter(s=> s.visibility==='hidden');
  return { basic, advanced, hidden, sorted };
}
