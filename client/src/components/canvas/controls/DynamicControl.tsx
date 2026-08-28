import React from 'react';
import { Upload, Image as ImageIcon } from 'lucide-react';

export type ControlSpec = {
  id: string;
  node_id?: string;
  param_name: string;
  label: string;
  alias?: string;
  type: 'text' | 'number' | 'combo' | 'image' | 'audio' | 'boolean';
  component?: string;
  required?: boolean;
  default_value?: any;
  description?: string;
  options?: string[]; // for combo
  min?: number;
  max?: number;
  step?: number;
};

export const DynamicControl: React.FC<{
  spec: ControlSpec;
  value: any;
  onChange: (v:any)=>void;
  onAliasChange?: (alias:string)=>void;
}> = ({ spec, value, onChange, onAliasChange }) => {
  const label = spec.alias || spec.label || spec.param_name;
  const desc = spec.description || '';
  const isImage = spec.type==='image';
  const isCombo = spec.type==='combo' || (spec.options && spec.options.length>0);
  const isNumber = spec.type==='number';
  const isBool = spec.type==='boolean';

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-zinc-700 truncate" title={desc}>{label} <span className="text-zinc-400 font-normal">· {spec.param_name}</span> {spec.required && <span className="text-red-500">*</span>}</span>
        {onAliasChange && <button onClick={()=>{
          const nv = prompt('重命名/注释（显示名）', label);
          if(nv && nv!==label) onAliasChange(nv);
        }} className="text-[10px] text-violet-600 hover:underline shrink-0">✎ 别名</button>}
      </div>
      {desc && <div className="text-[10px] text-zinc-500 leading-tight line-clamp-2">{desc}</div>}
      {isImage ? (
        <label className="flex items-center gap-2 p-2 rounded-xl border border-dashed border-zinc-300 bg-zinc-50 hover:bg-white hover:border-violet-300 cursor-pointer">
          <div className="w-8 h-8 rounded bg-white border border-zinc-200 flex items-center justify-center shrink-0 overflow-hidden">
            {value ? <img src={value} alt="" className="w-full h-full object-cover"/> : <ImageIcon className="w-4 h-4 text-zinc-400"/>}
          </div>
          <span className="text-xs text-zinc-600 truncate flex-1">{value ? '已选择 · 点击更换' : '点击上传 / 拖拽素材'}</span>
          <input type="file" accept="image/*,audio/*" className="hidden" onChange={e=>{
            const f=e.target.files?.[0]; if(!f) return;
            const reader=new FileReader(); reader.onload=()=> onChange(reader.result as string); reader.readAsDataURL(f);
          }} />
        </label>
      ) : isCombo ? (
        <select value={value ?? spec.default_value ?? ''} onChange={e=>{
          const v=e.target.value;
          // 保留数字类型
          if(spec.type==='number'){
            const num = Number(v);
            onChange(isNaN(num)?v:num);
          } else {
            onChange(v);
          }
        }} className="w-full bg-white border border-zinc-200 rounded-xl px-2.5 py-1.5 text-sm text-zinc-900">
          <option value="">{spec.required?'请选择':'自动'}</option>
          {(spec.options||[]).map(o=> <option key={o} value={o}>{o}</option>)}
        </select>
      ) : isNumber ? (
        <div className="flex items-center gap-2">
          <input type="range" min={spec.min??0} max={spec.max??100} step={spec.step??1} value={value ?? spec.default_value ?? 0} onChange={e=> onChange(Number(e.target.value))} className="flex-1 accent-violet-600"/>
          <input type="number" value={value ?? spec.default_value ?? ''} onChange={e=> onChange(e.target.value===''? '' : Number(e.target.value))} className="w-20 bg-white border border-zinc-200 rounded-lg px-2 py-1 text-sm text-zinc-900"/>
        </div>
      ) : isBool ? (
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={!!value} onChange={e=> onChange(e.target.checked)} className="rounded"/>
          <span className="text-xs text-zinc-700">{value ? '是' : '否'}</span>
        </label>
      ) : (
        <textarea value={value ?? ''} onChange={e=> onChange(e.target.value)} placeholder={spec.description||''} rows={spec.param_name==='prompt' || spec.param_name==='text' ? 2 : 1} className="w-full bg-white border border-zinc-200 rounded-xl p-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-violet-400 resize-none"/>
      )}
    </div>
  );
};
