import React, { useEffect, useState } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { Mic, Play, Volume2 } from 'lucide-react';
import { apiService } from '../../../services/api';

const API_ORIGIN = window.location.port === '5173' ? 'http://127.0.0.1:8000' : '';

export const TTSNode: React.FC<NodeProps> = ({ data, id }) => {
  const d:any = data;
  const [text, setText] = useState(d.text || d.dialogue || d.brief || '');
  const [provider, setProvider] = useState(d.provider || d.provider_id || 'minimax');
  const [voiceId, setVoiceId] = useState(d.voice_id || 'male-qn-qingse');
  const [emotion, setEmotion] = useState(d.emotion || 'neutral');
  const [voices, setVoices] = useState<any[]>([]);
  const [generating, setGenerating] = useState(false);
  const [audioUrl, setAudioUrl] = useState(d.audio_url || '');
  const [audioEl, setAudioEl] = useState<HTMLAudioElement | null>(null);

  useEffect(()=> {
    const p = (d as any).provider || (d as any).provider_id || (d as any).provider_audio || (d as any).audio_provider;
    if (p && p !== provider) setProvider(p);
  }, [d.provider, d.provider_id, d.provider_audio, d.audio_provider]);

  useEffect(()=> {
    apiService.listTtsVoices(provider).then(r=> setVoices(r.voices||[])).catch(()=>{});
  }, [provider]);

  useEffect(()=> {
    // 上游文本自动填充
    const upText = d._upstream?.dialogue || d._upstream?.subtitle_text || d._upstream?.brief || d._upstream?.text;
    if (upText && !text) setText(upText);
  }, [d._upstream]);

  const handleGenerate = async () => {
    if (!text.trim()) { alert('请输入台词'); return; }
    setGenerating(true);
    try {
      const effProvider = (d as any).provider || (d as any).provider_id || (d as any).provider_audio || provider;
      const res = await apiService.generateTTS(text, voiceId, emotion, { provider: effProvider });
      const url = res.audio_url;
      setAudioUrl(url);
      (d.onUpdate as any)?.(id, { audio_url: url, text, voice_id: voiceId, emotion, provider: effProvider });
    } catch(e:any){ alert(e.message); } finally { setGenerating(false); }
  };

  const handlePlay = () => {
    if (!audioUrl) return;
    if (audioEl) { audioEl.pause(); setAudioEl(null); return; }
    const url = audioUrl.startsWith('/')? API_ORIGIN+audioUrl : audioUrl;
    const a = new Audio(url);
    setAudioEl(a);
    a.onended = ()=> setAudioEl(null);
    a.play().catch(()=>{});
  };

  return (
    <div className="w-[320px] bg-surface border border-border rounded-2xl shadow-xl overflow-hidden">
      <div className="px-3 py-2.5 bg-surface border-b border-border flex items-center gap-1.5">
        <div className="w-6 h-6 rounded-lg bg-surface-secondary border border-border flex items-center justify-center"><Mic className="w-3.5 h-3.5 text-pink-500"/></div>
        <span className="text-xs font-bold [color:var(--color-text-main)]">TTS 配音</span>
        {(d.provider || d.provider_id) && <span className="ml-1 text-[9px] px-1.5 py-0.5 rounded-full bg-brand text-white font-mono truncate max-w-[80px]">{String(d.provider || d.provider_id).slice(0,10)}</span>}
        <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-surface-secondary border border-border [color:var(--color-text-muted)] font-mono">{provider}</span>
      </div>
      <Handle type="target" position={Position.Left} className="!bg-pink-500 !w-3 !h-3 !border-2 !border-surface"/>
      <Handle type="target" position={Position.Top} id="provider" className="!bg-violet-500 !w-3 !h-3 !border-2 !border-surface" style={{left:'15%'}} title="接 Provider-Audio"/>
      <Handle type="target" position={Position.Top} id="text" className="!bg-sky-500 !w-3 !h-3 !border-2 !border-surface" style={{left:'30%'}}/>
      <Handle type="source" position={Position.Right} className="!bg-pink-500 !w-3 !h-3 !border-2 !border-surface"/>
      <Handle type="source" position={Position.Bottom} id="audio" className="!bg-emerald-500 !w-3 !h-3 !border-2 !border-surface"/>
      <div className="p-3 space-y-2">
        <textarea value={text} onChange={e=>{setText(e.target.value); (d.onUpdate as any)?.(id,{text:e.target.value});}} placeholder="输入台词/旁白… (可连入上游文本)" rows={3} className="w-full bg-surface-secondary border border-border rounded-xl p-2.5 text-xs [color:var(--color-text-main)] placeholder:[color:var(--color-text-muted)] focus:outline-none focus:border-brand resize-none"/>
        <div className="space-y-1">
          <select value={provider} onChange={e=> setProvider(e.target.value)} className="w-full bg-surface-secondary border border-border rounded-xl px-2.5 py-1.5 text-xs [color:var(--color-text-main)] focus:outline-none focus:border-brand">
            <option value="minimax">MiniMax</option><option value="elevenlabs">ElevenLabs</option><option value="cosyvoice">CosyVoice</option><option value="gpt_sovits">GPT-SoVITS</option>
            {(d.provider || d.provider_id) && !['minimax','elevenlabs','cosyvoice','gpt_sovits'].includes(String(d.provider || d.provider_id)) && <option value={String(d.provider || d.provider_id)}>{String(d.provider || d.provider_id)} (连线)</option>}
          </select>
          {(d.provider || d.provider_id) && <div className="text-[11px] text-brand bg-brand/10 border border-brand/20 rounded-lg px-2 py-1 font-medium">✓ 已绑定 Provider：{String(d.provider || d.provider_id).slice(0,24)} · 优先使用连线源</div>}
        </div>
        <select value={voiceId} onChange={e=>{setVoiceId(e.target.value); (d.onUpdate as any)?.(id,{voice_id:e.target.value});}} className="w-full bg-surface-secondary border border-border rounded-xl px-2.5 py-1.5 text-xs [color:var(--color-text-main)] focus:outline-none focus:border-brand">
          {voices.length ? voices.map((v:any)=> <option key={v.voice_id||v.id} value={v.voice_id||v.id}>{v.voice_name||v.name||v.voice_id} {v.emotion?'·'+v.emotion:''}</option>) : <option value={voiceId}>{voiceId}</option>}
        </select>
        <select value={emotion} onChange={e=>{setEmotion(e.target.value); (d.onUpdate as any)?.(id,{emotion:e.target.value});}} className="w-full bg-surface-secondary border border-border rounded-xl px-2.5 py-1.5 text-xs [color:var(--color-text-main)] focus:outline-none focus:border-brand">
          <option value="neutral">平静</option><option value="intense">怒吼爆发</option><option value="sorrow">悲痛</option><option value="excited">兴奋</option><option value="whispering">低语</option><option value="fearful">恐惧</option>
        </select>
        <button onClick={handleGenerate} disabled={generating} className="w-full py-2.5 rounded-xl bg-brand hover:bg-brand-light text-white text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-40 shadow-sm transition-colors">
          {generating ? <><div className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin"/> 生成中…</> : <><Volume2 className="w-3.5 h-3.5"/> 生成配音</>}
        </button>
        {audioUrl && <button onClick={handlePlay} className="w-full py-2 rounded-xl bg-surface-secondary border border-border text-xs [color:var(--color-text-main)] flex items-center justify-center gap-1.5 hover:bg-surface-tertiary transition-colors"><Play className="w-3 h-3"/>{audioEl ? '暂停' : '试听'} <span className="text-[10px] [color:var(--color-text-muted)] truncate max-w-[120px]">{audioUrl.slice(-24)}</span></button>}
      </div>
    </div>
  );
};
