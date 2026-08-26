import React, { useEffect, useState } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { Mic, Play, Volume2 } from 'lucide-react';
import { apiService } from '../../../services/api';

const API_ORIGIN = window.location.port === '5173' ? 'http://127.0.0.1:8000' : '';

export const TTSNode: React.FC<NodeProps> = ({ data, id }) => {
  const d:any = data;
  const [text, setText] = useState(d.text || d.dialogue || d.brief || '');
  const [provider, setProvider] = useState(d.provider || 'minimax');
  const [voiceId, setVoiceId] = useState(d.voice_id || 'male-qn-qingse');
  const [emotion, setEmotion] = useState(d.emotion || 'neutral');
  const [voices, setVoices] = useState<any[]>([]);
  const [generating, setGenerating] = useState(false);
  const [audioUrl, setAudioUrl] = useState(d.audio_url || '');
  const [audioEl, setAudioEl] = useState<HTMLAudioElement | null>(null);

  useEffect(()=> {
    apiService.listTtsVoices(provider).then(r=> setVoices(r.voices||[])).catch(()=>{});
  }, [provider]);

  useEffect(()=> {
    // 上游文本自动填充
    const upText = d._upstream?.dialogue || d._upstream?.subtitle_text || d._upstream?.brief;
    if (upText && !text) setText(upText);
  }, [d._upstream]);

  const handleGenerate = async () => {
    if (!text.trim()) { alert('请输入台词'); return; }
    setGenerating(true);
    try {
      const res = await apiService.generateTTS(text, voiceId, emotion, { provider });
      const url = res.audio_url;
      setAudioUrl(url);
      (d.onUpdate as any)?.(id, { audio_url: url, text, voice_id: voiceId, emotion, provider });
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
    <div className="w-[320px] bg-surface border border-accent-pink/30 rounded-2xl shadow-xl overflow-hidden">
      <div className="px-3 py-2 bg-gradient-to-r from-pink-500/20 to-violet-500/20 border-b border-accent-pink/20 flex items-center gap-1.5">
        <Mic className="w-3.5 h-3.5 text-accent-pink"/><span className="text-xs font-bold text-white">TTS 配音</span>
        <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-black/30 text-gray-300">{provider}</span>
      </div>
      <Handle type="target" position={Position.Left} className="!bg-accent-pink !w-2 !h-2"/>
      <Handle type="target" position={Position.Top} id="text" className="!bg-brand !w-2 !h-2" style={{left:'30%'}}/>
      <Handle type="source" position={Position.Right} className="!bg-accent-pink !w-2 !h-2"/>
      <Handle type="source" position={Position.Bottom} id="audio" className="!bg-accent-green !w-2 !h-2"/>
      <div className="p-3 space-y-2">
        <textarea value={text} onChange={e=>{setText(e.target.value); (d.onUpdate as any)?.(id,{text:e.target.value});}} placeholder="输入台词/旁白… (可连入上游文本)" rows={3} className="w-full bg-surface-secondary border border-border rounded-xl p-2 text-xs text-white placeholder-gray-500"/>
        <select value={provider} onChange={e=> setProvider(e.target.value)} className="w-full bg-surface-secondary border border-border rounded-xl px-2 py-1.5 text-xs text-white">
          <option value="minimax">MiniMax</option><option value="elevenlabs">ElevenLabs</option><option value="cosyvoice">CosyVoice</option><option value="gpt_sovits">GPT-SoVITS</option>
        </select>
        <select value={voiceId} onChange={e=>{setVoiceId(e.target.value); (d.onUpdate as any)?.(id,{voice_id:e.target.value});}} className="w-full bg-surface-secondary border border-border rounded-xl px-2 py-1.5 text-xs text-white">
          {voices.length ? voices.map((v:any)=> <option key={v.voice_id||v.id} value={v.voice_id||v.id}>{v.voice_name||v.name||v.voice_id} {v.emotion?'·'+v.emotion:''}</option>) : <option value={voiceId}>{voiceId}</option>}
        </select>
        <select value={emotion} onChange={e=>{setEmotion(e.target.value); (d.onUpdate as any)?.(id,{emotion:e.target.value});}} className="w-full bg-surface-secondary border border-border rounded-xl px-2 py-1.5 text-xs text-white">
          <option value="neutral">平静</option><option value="intense">怒吼爆发</option><option value="sorrow">悲痛</option><option value="excited">兴奋</option><option value="whispering">低语</option><option value="fearful">恐惧</option>
        </select>
        <button onClick={handleGenerate} disabled={generating} className="w-full py-2 rounded-xl bg-gradient-to-r from-accent-pink to-violet-500 text-white text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-40">
          {generating ? <><div className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin"/> 生成中…</> : <><Volume2 className="w-3.5 h-3.5"/> 生成配音</>}
        </button>
        {audioUrl && <button onClick={handlePlay} className="w-full py-1.5 rounded-xl bg-surface-secondary border border-border text-xs text-white flex items-center justify-center gap-1.5"><Play className="w-3 h-3"/>{audioEl ? '暂停' : '试听'} <span className="text-[10px] text-gray-500 truncate max-w-[120px]">{audioUrl.slice(-24)}</span></button>}
      </div>
    </div>
  );
};
