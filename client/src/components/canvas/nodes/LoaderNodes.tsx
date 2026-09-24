import React, { useState } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { Image as ImageIcon, Video, Music, Type, Upload, Trash2 } from 'lucide-react';
import { apiService } from '../../../services/api';
import { AutoRatioMedia } from '../../ui/AutoRatioMedia';

import { API_ORIGIN } from '../../../utils/devOrigin';

function getUrl(u?:string){ if(!u) return ''; return u.startsWith('/') ? API_ORIGIN+u : u; }

export const LoadImageNode: React.FC<NodeProps> = ({ data, id })=>{
  const d:any = data;
  const [url, setUrl] = useState(d.image || d.url || '');
  const set = (v:string)=> { setUrl(v); (d.onUpdate as any)?.(id, { image: v, url: v }); };
  const onUpload = async (f:File)=>{
    try{
      const r = await apiService.uploadImageToComfyUI(f);
      if(r.name) set(r.name);
      else if((r as any).url) set((r as any).url);
    }catch(e:any){ alert(e.message); }
  };
  return (
    <div className="w-[260px] bg-surface border border-border rounded-2xl shadow-xl overflow-hidden">
      <div className="px-3 py-2.5 bg-surface border-b border-border flex items-center gap-1.5">
        <div className="w-6 h-6 rounded-lg bg-surface-secondary border border-border flex items-center justify-center"><ImageIcon className="w-3.5 h-3.5 text-violet-500"/></div>
        <span className="text-xs font-bold [color:var(--color-text-main)]">加载图像</span>
        <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full bg-surface-secondary [color:var(--color-text-muted)] border border-border font-mono">image</span>
      </div>
      <Handle type="target" position={Position.Left} id="asset" className="!bg-transparent !w-2 !h-2" style={{visibility:'hidden'}}/>
      <Handle type="source" position={Position.Right} id="image" className="!bg-violet-500 !w-3 !h-3 !border-2 !border-surface" style={{top:'50%'}}/>
      <div className="p-3 space-y-2">
        {url ? (
          <AutoRatioMedia src={getUrl(url)} fallbackAspect="4/3" maxHeight={220} className="rounded-xl border border-border bg-surface-secondary group">
            <button onClick={()=> set('')} className="absolute top-1.5 right-1.5 p-1 rounded-lg bg-red-500/80 text-white hover:bg-red-600 transition-colors shadow-sm"><Trash2 className="w-3 h-3"/></button>
          </AutoRatioMedia>
        ) : (
          <label className="flex flex-col items-center justify-center h-24 rounded-xl border border-dashed border-violet-500/30 bg-violet-500/5 cursor-pointer hover:bg-violet-500/10 transition-colors">
            <Upload className="w-5 h-5 text-violet-500"/><span className="text-xs text-violet-600 dark:text-violet-300 mt-1 font-medium">上传参考图 / 拖素材</span>
            <input type="file" accept="image/*" className="hidden" onChange={e=>{ const f=e.target.files?.[0]; if(f) onUpload(f); }} />
          </label>
        )}
        <div className="flex gap-1" onDragOver={e=> e.preventDefault()} onDrop={e=>{
          e.preventDefault();
          const u = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/uri-list');
          const assetId = e.dataTransfer.getData('application/canvas-assetid');
          if(u) set(u);
          else if(assetId) set(u);
        }}>
          <input value={url} onChange={e=> set(e.target.value)} placeholder="或粘贴 /storage/... 或 http URL" className="flex-1 bg-surface-secondary border border-border rounded-lg px-2.5 py-1.5 text-xs [color:var(--color-text-main)] placeholder:[color:var(--color-text-muted)] font-mono focus:outline-none focus:border-brand"/>
        </div>
        <div className="text-[10px] [color:var(--color-text-muted)] text-center">输出 image → 可连 视频 / 分镜卡 / Comfy</div>
      </div>
    </div>
  );
};

export const LoadImageBatchNode: React.FC<NodeProps> = ({ data, id })=>{
  const d:any = data;
  const [urls, setUrls] = useState<string[]>(d.images || d.image_list || []);
  const sync = (next:string[])=> { setUrls(next); (d.onUpdate as any)?.(id, { images: next, image_list: next }); };
  const addUrl = (u:string)=> { if(!u) return; sync([...urls, u]); };
  const removeAt = (i:number)=> sync(urls.filter((_,idx)=> idx!==i));
  return (
    <div className="w-[300px] bg-surface border border-border rounded-2xl shadow-xl overflow-hidden">
      <div className="px-3 py-2.5 bg-surface border-b border-border flex items-center gap-1.5">
        <div className="w-6 h-6 rounded-lg bg-surface-secondary border border-border flex items-center justify-center"><ImageIcon className="w-3.5 h-3.5 text-violet-500"/></div>
        <span className="text-xs font-bold [color:var(--color-text-main)]">批量加载图像</span>
        <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full bg-surface-secondary [color:var(--color-text-muted)] border border-border font-mono">{urls.length} 张</span>
      </div>
      <Handle type="source" position={Position.Right} id="images" className="!bg-violet-500 !w-3 !h-3 !border-2 !border-surface" />
      <div className="p-3 space-y-2">
        <div className="grid grid-cols-3 gap-1.5 min-h-[80px] items-start">
          {urls.map((u,i)=>(
            <AutoRatioMedia key={i} src={getUrl(u)} fallbackAspect="1/1" className="rounded-lg border border-border bg-surface-secondary group">
              <button onClick={()=> removeAt(i)} className="absolute top-0.5 right-0.5 p-0.5 rounded bg-red-500 text-white opacity-0 group-hover:opacity-100 transition-opacity"><Trash2 className="w-3 h-3"/></button>
            </AutoRatioMedia>
          ))}
          {urls.length===0 && <div className="col-span-3 text-[11px] [color:var(--color-text-muted)] text-center py-6 border border-dashed border-border rounded-xl">拖入素材或上传多张</div>}
        </div>
        <label className="flex items-center justify-center gap-1 py-1.5 rounded-xl bg-surface-secondary border border-border text-xs [color:var(--color-text-main)] font-medium cursor-pointer hover:bg-surface-tertiary transition-colors">
          <Upload className="w-3 h-3 text-brand"/> 批量上传<input type="file" accept="image/*" multiple className="hidden" onChange={async e=>{
            const files = Array.from(e.target.files||[]);
            for(const f of files){
              try{ const r=await apiService.uploadImageToComfyUI(f); if(r.name) addUrl(r.name); }catch{}
            }
          }}/>
        </label>
        <input placeholder="粘贴 URL 回车添加" className="w-full bg-surface-secondary border border-border rounded-lg px-2.5 py-1.5 text-xs [color:var(--color-text-main)] placeholder:[color:var(--color-text-muted)] font-mono focus:outline-none focus:border-brand" onKeyDown={e=>{
          if(e.key==='Enter'){ const v=(e.target as HTMLInputElement).value.trim(); if(v){ addUrl(v); (e.target as HTMLInputElement).value=''; } }
        }}/>
      </div>
    </div>
  );
};

export const LoadVideoNode: React.FC<NodeProps> = ({ data, id })=>{
  const d:any = data;
  const [url,setUrl]=useState(d.video||d.url||'');
  const sync=(v:string)=>{ setUrl(v); (d.onUpdate as any)?.(id,{video:v, url:v}); };
  return (
    <div className="w-[260px] bg-surface border border-border rounded-2xl shadow-xl overflow-hidden">
      <div className="px-3 py-2.5 bg-surface border-b border-border flex items-center gap-1.5">
        <div className="w-6 h-6 rounded-lg bg-surface-secondary border border-border flex items-center justify-center"><Video className="w-3.5 h-3.5 text-orange-500"/></div>
        <span className="text-xs font-bold [color:var(--color-text-main)]">加载视频</span>
      </div>
      <Handle type="source" position={Position.Right} id="video" className="!bg-orange-500 !w-3 !h-3 !border-2 !border-surface"/>
      <div className="p-3 space-y-2">
        {url ? <AutoRatioMedia kind="video" src={getUrl(url)} fallbackAspect="16/9" maxHeight={220} className="rounded-xl bg-surface-secondary border border-border" videoProps={{ controls: true }} /> : <div className="h-20 flex items-center justify-center text-xs [color:var(--color-text-muted)] border border-dashed border-border rounded-xl">暂无视频</div>}
        <input value={url} onChange={e=> sync(e.target.value)} placeholder="/storage/... 或 http" className="w-full bg-surface-secondary border border-border rounded-lg px-2.5 py-1.5 text-xs [color:var(--color-text-main)] placeholder:[color:var(--color-text-muted)] font-mono focus:outline-none focus:border-brand"/>
      </div>
    </div>
  );
};

export const LoadAudioNode: React.FC<NodeProps> = ({ data, id })=>{
  const d:any = data;
  const [url,setUrl]=useState(d.audio||d.url||'');
  const sync=(v:string)=>{ setUrl(v); (d.onUpdate as any)?.(id,{audio:v, url:v}); };
  return (
    <div className="w-[260px] bg-surface border border-border rounded-2xl shadow-xl overflow-hidden">
      <div className="px-3 py-2.5 bg-surface border-b border-border flex items-center gap-1.5">
        <div className="w-6 h-6 rounded-lg bg-surface-secondary border border-border flex items-center justify-center"><Music className="w-3.5 h-3.5 text-pink-500"/></div>
        <span className="text-xs font-bold [color:var(--color-text-main)]">加载音频</span>
      </div>
      <Handle type="source" position={Position.Right} id="audio" className="!bg-pink-500 !w-3 !h-3 !border-2 !border-surface"/>
      <div className="p-3 space-y-2">
        {url ? <audio src={getUrl(url)} controls className="w-full"/> : <div className="h-12 flex items-center justify-center text-xs [color:var(--color-text-muted)] border border-dashed border-border rounded-xl">暂无音频</div>}
        <input value={url} onChange={e=> sync(e.target.value)} placeholder="/storage/... 或 http" className="w-full bg-surface-secondary border border-border rounded-lg px-2.5 py-1.5 text-xs [color:var(--color-text-main)] placeholder:[color:var(--color-text-muted)] font-mono focus:outline-none focus:border-brand"/>
      </div>
    </div>
  );
};

export const TextPromptNode: React.FC<NodeProps> = ({ data, id })=>{
  const d:any = data;
  const [prompt,setPrompt]=useState(d.prompt||d.text||'');
  const sync=(v:string)=>{ setPrompt(v); (d.onUpdate as any)?.(id,{prompt:v, text:v}); };
  return (
    <div className="w-[300px] bg-surface border border-border rounded-2xl shadow-xl overflow-hidden">
      <div className="px-3 py-2.5 bg-surface border-b border-border flex items-center gap-1.5">
        <div className="w-6 h-6 rounded-lg bg-surface-secondary border border-border flex items-center justify-center"><Type className="w-3.5 h-3.5 text-sky-500"/></div>
        <span className="text-xs font-bold [color:var(--color-text-main)]">文本提示词</span>
      </div>
      <Handle type="source" position={Position.Right} id="prompt" className="!bg-sky-500 !w-3 !h-3 !border-2 !border-surface"/>
      <Handle type="source" position={Position.Bottom} id="text" className="!bg-sky-500 !w-3 !h-3 !border-2 !border-surface"/>
      <div className="p-3">
        <textarea value={prompt} onChange={e=> sync(e.target.value)} rows={3} placeholder="输入提示词，可连到 分镜卡/视频/生图 的 prompt 输入" className="w-full bg-surface-secondary border border-border rounded-xl p-2.5 text-xs [color:var(--color-text-main)] placeholder:[color:var(--color-text-muted)] resize-none focus:outline-none focus:border-brand"/>
        <div className="text-[10px] [color:var(--color-text-muted)] mt-1.5">输出 text → 可连任意 prompt 输入</div>
      </div>
    </div>
  );
};
