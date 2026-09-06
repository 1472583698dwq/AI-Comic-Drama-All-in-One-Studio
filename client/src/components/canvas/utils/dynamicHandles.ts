export type HandleDef = { id: string; label: string; type: 'image' | 'audio' | 'video' | 'text'; required?:boolean };

// 类型只认接口声明：x-handle 优先；uri 缺 x-handle 时按属性键粗判媒体类型（后端 enrich 已保证 x-handle 存在）
const coerce = (xHandle: string, key: string, isUri: boolean): HandleDef['type'] | null => {
  const h = (xHandle || '').toLowerCase();
  if (['image','images','reference_images','first_frame','last_frame'].includes(h)) return 'image';
  if (['audio','audios','reference_audios','ref_audio'].includes(h)) return 'audio';
  if (['video','videos','reference_videos'].includes(h)) return 'video';
  if (h === 'text' || h === 'prompt') return 'text';
  if (isUri) {
    const lk = key.toLowerCase();
    if (lk.includes('audio')) return 'audio';
    if (lk.includes('video')) return 'video';
    return 'image';
  }
  return null;
};

export function handlesFromSchema(schema: any): HandleDef[] {
  if (!schema?.properties) return [];
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  const out: HandleDef[] = [];
  for (const [key, def] of Object.entries<any>(schema.properties)) {
    const isArray = def?.type === 'array';
    const isUri = def?.format === 'uri' || (isArray && def?.items?.format === 'uri');
    const t = coerce(String(def?.['x-handle'] || ''), key, isUri);
    if (!t) continue;
    out.push({ id: def['x-slot'] || key, label: def.description || def.title || key, type: t, required: required.includes(key) || !!def.required });
  }
  return out;
}

export const handleColor: Record<HandleDef['type'], string> = {
  image: '!bg-violet-500 !border-surface',
  video: '!bg-orange-500 !border-surface',
  audio: '!bg-pink-500 !border-surface',
  text: '!bg-sky-500 !border-surface',
};
