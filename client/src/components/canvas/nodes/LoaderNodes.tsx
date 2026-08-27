import React, { useState } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { Image as ImageIcon, Video, Music, Type, Upload, Trash2 } from 'lucide-react';
import { apiService } from '../../../services/api';

const API_ORIGIN = window.location.port === '5173' ? 'http://127.0.0.1:8000' : '';

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
    <div className="w-[260px] bg-[#1A1A22] border-2 border-violet-500/30 rounded-2xl shadow-xl overflow-hidden">
      <div className="px-3 py-2 bg-zinc-900 border-b border-zinc-800 flex items-center gap-1.5">
        <ImageIcon className="w-3.5 h-3.5 text-violet-400"/><span className="text-xs font-bold text-white">加载图像</span>
        <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30">image</span>
      </div>
      <Handle type="target" position={Position.Left} id="asset" className="!bg-zinc-500 !w-2 !h-2" style={{visibility:'hidden'}}/>
      <Handle type="source" position={Position.Right} id="image" className="!bg-violet-500 !w-3 !h-3 !border-2 !border-white" style={{top:'50%'}}/>
      <div className="p-3 space-y-2">
        {url ? (
          <div className="relative group">
            <img src={getUrl(url)} alt="" className="w-full h-32 object-cover rounded-xl border border-[#2A2A32]"/>
            <button onClick={()=> set('')} className="absolute top-1 right-1 p-1 rounded bg-red-500/80 text-white"><Trash2 className="w-3 h-3"/></button>
          </div>
        ) : (
          <label className="flex flex-col items-center justify-center h-24 rounded-xl border-2 border-dashed border-violet-500/30 bg-violet-500/5 cursor-pointer hover:bg-violet-500/10">
            <Upload className="w-5 h-5 text-violet-400"/><span className="text-xs text-violet-300 mt-1">上传参考图 / 拖素材</span>
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
          <input value={url} onChange={e=> set(e.target.value)} placeholder="或粘贴 /storage/... 或 http URL" className="flex-1 bg-[#24242F] border border-[#2A2A32] rounded-lg px-2 py-1.5 text-xs text-white placeholder-gray-500 font-mono"/>
        </div>
        <div className="text-[10px] text-gray-500 text-center">输出 image → 可连 视频.reference_images / 分镜卡.reference / Comfy</div>
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
    <div className="w-[300px] bg-[#1A1A22] border-2 border-violet-500/30 rounded-2xl shadow-xl overflow-hidden">
      <div className="px-3 py-2 bg-zinc-900 border-b border-zinc-800 flex items-center gap-1.5">
        <ImageIcon className="w-3.5 h-3.5 text-violet-400"/><span className="text-xs font-bold text-white">批量加载图像</span>
        <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30">{urls.length} 张</span>
      </div>
      <Handle type="source" position={Position.Right} id="images" className="!bg-violet-500 !w-3 !h-3 !border-2 !border-white" />
      <div className="p-3 space-y-2">
        <div className="grid grid-cols-3 gap-1.5 min-h-[80px]">
          {urls.map((u,i)=>(
            <div key={i} className="relative group aspect-square rounded-lg overflow-hidden border border-[#2A2A32] bg-black/40">
              <img src={getUrl(u)} alt="" className="w-full h-full object-cover"/>
              <button onClick={()=> removeAt(i)} className="absolute top-0.5 right-0.5 p-0.5 rounded bg-red-500 text-white opacity-0 group-hover:opacity-100"><Trash2 className="w-3 h-3"/></button>
            </div>
          ))}
          {urls.length===0 && <div className="col-span-3 text-[11px] text-gray-500 text-center py-6 border-2 border-dashed border-[#2A2A32] rounded-xl">拖入素材或上传多张</div>}
        </div>
        <label className="flex items-center justify-center gap-1 py-1.5 rounded-xl bg-[#24242F] border border-[#2A2A32] text-xs text-white cursor-pointer hover:border-violet-500/30">
          <Upload className="w-3 h-3"/> 批量上传<input type="file" accept="image/*" multiple className="hidden" onChange={async e=>{
            const files = Array.from(e.target.files||[]);
            for(const f of files){
              try{ const r=await apiService.uploadImageToComfyUI(f); if(r.name) addUrl(r.name); }catch{}
            }
          }}/>
        </label>
        <input placeholder="粘贴 URL 回车添加" className="w-full bg-[#24242F] border border-[#2A2A32] rounded-lg px-2 py-1 text-xs text-white font-mono" onKeyDown={e=>{
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
    <div className="w-[260px] bg-[#1A1A22] border-2 border-orange-500/30 rounded-2xl shadow-xl overflow-hidden">
      <div className="px-3 py-2 bg-zinc-900 border-b border-zinc-800 flex items-center gap-1.5"><Video className="w-3.5 h-3.5 text-orange-400"/><span className="text-xs font-bold text-white">加载视频</span></div>
      <Handle type="source" position={Position.Right} id="video" className="!bg-orange-500 !w-3 !h-3 !border-2 !border-white"/>
      <div className="p-3 space-y-2">
        {url ? <video src={getUrl(url)} controls className="w-full h-28 rounded-xl bg-black object-cover"/> : <div className="h-20 flex items-center justify-center text-xs text-gray-500 border-2 border-dashed border-[#2A2A32] rounded-xl">暂无视频</div>}
        <input value={url} onChange={e=> sync(e.target.value)} placeholder="/storage/... 或 http" className="w-full bg-[#24242F] border border-[#2A2A32] rounded-lg px-2 py-1.5 text-xs text-white font-mono"/>
      </div>
    </div>
  );
};

export const LoadAudioNode: React.FC<NodeProps> = ({ data, id })=>{
  const d:any = data;
  const [url,setUrl]=useState(d.audio||d.url||'');
  const sync=(v:string)=>{ setUrl(v); (d.onUpdate as any)?.(id,{audio:v, url:v}); };
  return (
    <div className="w-[260px] bg-[#1A1A22] border-2 border-pink-500/30 rounded-2xl shadow-xl overflow-hidden">
      <div className="px-3 py-2 bg-zinc-900 border-b border-zinc-800 flex items-center gap-1.5"><Music className="w-3.5 h-3.5 text-pink-400"/><span className="text-xs font-bold text-white">加载音频</span></div>
      <Handle type="source" position={Position.Right} id="audio" className="!bg-pink-500 !w-3 !h-3 !border-2 !border-white"/>
      <div className="p-3 space-y-2">
        {url ? <audio src={getUrl(url)} controls className="w-full"/> : <div className="h-12 flex items-center justify-center text-xs text-gray-500 border-2 border-dashed border-[#2A2A32] rounded-xl">暂无音频</div>}
        <input value={url} onChange={e=> sync(e.target.value)} placeholder="/storage/... 或 http" className="w-full bg-[#24242F] border border-[#2A2A32] rounded-lg px-2 py-1.5 text-xs text-white font-mono"/>
      </div>
    </div>
  );
};

export const TextPromptNode: React.FC<NodeProps> = ({ data, id })=>{
  const d:any = data;
  const [prompt,setPrompt]=useState(d.prompt||d.text||'');
  const sync=(v:string)=>{ setPrompt(v); (d.onUpdate as any)?.(id,{prompt:v, text:v}); };
  return (
    <div className="w-[300px] bg-[#1A1A22] border-2 border-sky-500/30 rounded-2xl shadow-xl overflow-hidden">
      <div className="px-3 py-2 bg-zinc-900 border-b border-zinc-800 flex items-center gap-1.5"><Type className="w-3.5 h-3.5 text-sky-400"/><span className="text-xs font-bold text-white">文本提示词</span></div>
      <Handle type="source" position={Position.Right} id="prompt" className="!bg-sky-500 !w-3 !h-3 !border-2 !border-white"/>
      <Handle type="source" position={Position.Bottom} id="text" className="!bg-sky-500 !w-3 !h-3 !border-2 !border-white"/>
      <div className="p-3">
        <textarea value={prompt} onChange={e=> sync(e.target.value)} rows={3} placeholder="输入提示词，可连到 分镜卡/视频/生图 的 prompt 输入" className="w-full bg-[#24242F] border border-[#2A2A32] rounded-xl p-2 text-xs text-white placeholder-gray-500 resize-none focus:outline-none focus:border-sky-500"/>
        <div className="text-[10px] text-gray-500 mt-1">输出 text → 可连任意 prompt 输入</div>
      </div>
    </div>
  );
};
