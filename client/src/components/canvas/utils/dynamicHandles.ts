export type HandleDef = { id: string; label: string; type: 'image' | 'audio' | 'video' | 'text'; required?: boolean };

export function handlesFromSchema(schema: any): HandleDef[] {
  if (!schema?.properties) return [];
  const out: HandleDef[] = [];
  for (const [key, def] of Object.entries<any>(schema.properties)) {
    const xHandle = def['x-handle'] as string | undefined;
    const t = def.type;
    const isArray = t === 'array';
    const itemsFormat = isArray ? (def.items?.format || '') : (def.format || '');
    const desc = (def.description || '').toLowerCase();
    let hType: HandleDef['type'] | null = null;
    if (xHandle) {
      if (['image','images','reference_images'].includes(xHandle)) hType = 'image';
      else if (['audio','audios','reference_audios'].includes(xHandle)) hType = 'audio';
      else if (['video','videos','reference_videos'].includes(xHandle)) hType = 'video';
      else if (xHandle === 'text' || xHandle === 'prompt') hType = 'text';
    }
    if (!hType) {
      if (isArray && itemsFormat === 'uri') {
        if (key.includes('image') || desc.includes('image')) hType = 'image';
        else if (key.includes('audio') || desc.includes('audio')) hType = 'audio';
        else if (key.includes('video') || desc.includes('video')) hType = 'video';
        else hType = 'image';
      } else if (t === 'string' && def.format === 'uri') {
        if (key.includes('image') || desc.includes('image')) hType = 'image';
        else if (key.includes('audio') || desc.includes('audio')) hType = 'audio';
        else if (key.includes('video') || desc.includes('video')) hType = 'video';
      } else if (key.includes('prompt') || desc.includes('prompt')) {
        hType = 'text';
      }
    }
    if (hType) {
      out.push({ id: key, label: def.title || key, type: hType, required: !!def.required });
    }
  }
  return out;
}

export const handleColor: Record<HandleDef['type'], string> = {
  image: '!bg-violet-500 !border-white',
  video: '!bg-orange-500 !border-white',
  audio: '!bg-pink-500 !border-white',
  text: '!bg-sky-500 !border-white',
};
