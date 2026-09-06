const fs = require('fs');
const provider = JSON.parse(fs.readFileSync('D:/ai漫剧/storage/providers/custom/prov_6131876a.json', 'utf-8'));
console.log('input', JSON.stringify(provider.input_schema, null, 2));
console.log('params', JSON.stringify(provider.params_schema, null, 2));

// copy of extractSlotsFromProvider
function extractSlotsFromProvider(provider, nodeKind) {
  if (!provider) {
    if (nodeKind === 'video') {
      return [
        { key: 'first_frame', label: '首帧', type: 'image', required: false, description: '视频起始画面', maxCount: 1, minCount: 0, originalKey: 'first_frame' },
        { key: 'last_frame', label: '尾帧', type: 'image', required: false, description: '视频结束画面', maxCount: 1, minCount: 0, originalKey: 'last_frame' },
        { key: 'reference_images', label: '参考图', type: 'image', required: false, description: '主体/角色参考', maxCount: 4, minCount: 0, originalKey: 'reference_images' },
      ];
    }
    return [];
  }

  const props = provider.input_schema?.properties || {};
  const requiredKeys = Array.isArray(provider.input_schema?.required) ? provider.input_schema.required : [];
  const slots = [];
  const seen = new Set();

  const pushSlot = (key, label, type, desc, srcKey, def) => {
    if (seen.has(key)) return;
    seen.add(key);
    const isRequired = requiredKeys.includes(srcKey);
    let maxCount;
    let minCount;
    if (def) {
      const isArray = def.type === 'array';
      if (isArray) {
        if (typeof def.maxItems === 'number') maxCount = def.maxItems;
        else if (typeof def.items?.maxItems === 'number') maxCount = def.items.maxItems;
        if (typeof def.minItems === 'number') minCount = def.minItems;
        else if (typeof def.items?.minItems === 'number') minCount = def.items.minItems;
        if (maxCount === undefined) {
          if (key === 'reference_images') maxCount = 4;
          else if (key === 'ref_audio') maxCount = 1;
          else if (key === 'reference_video') maxCount = 1;
          else maxCount = 4;
        }
        if (minCount === undefined) minCount = isRequired ? 1 : 0;
      } else {
        maxCount = 1;
        minCount = isRequired ? 1 : 0;
      }
    }
    slots.push({ key, label, type, required: isRequired, description: desc, maxCount, minCount, originalKey: srcKey });
  };

  for (const [key, def] of Object.entries(props)) {
    const d = def;
    const xHandle = (d['x-handle'] || '').toString().toLowerCase();
    const desc = d.description || '';
    const isArray = d.type === 'array';
    const itemsFormat = isArray ? (d.items?.format || '') : '';
    const isUri = d.format === 'uri' || itemsFormat === 'uri';
    console.log('checking', key, 'xHandle', xHandle, 'isUri', isUri, 'isArray', isArray);
    if (!isUri) continue;
    const lowerKey = key.toLowerCase();
    if (key === 'first_frame' || key === 'first_frame_url' || lowerKey === 'first_frame' || xHandle === 'first_frame' || (xHandle === 'image' && lowerKey.includes('first_frame')) || (xHandle === 'image' && lowerKey === 'firstframe')) {
      pushSlot('first_frame', '首帧', 'image', desc || '视频起始画面', key, d);
      continue;
    }
    if (key === 'last_frame' || key === 'last_frame_url' || xHandle === 'last_frame' || (xHandle === 'image' && lowerKey.includes('last_frame'))) {
      pushSlot('last_frame', '尾帧', 'image', desc || '视频结束画面', key, d);
      continue;
    }
    // 音频/视频 必须在通用 reference 之前判断，避免 reference_audios 被误判为图片
    if (xHandle === 'audio' || lowerKey.includes('ref_audio') || lowerKey.includes('reference_audio') || (isUri && lowerKey.includes('audio'))) {
      console.log('  -> audio slot', key);
      pushSlot('ref_audio', '参考音频', 'audio', desc || '音色参考', key, d);
      continue;
    }
    if (xHandle === 'video' || xHandle === 'reference_video' || (isUri && lowerKey.includes('video'))) {
      pushSlot('reference_video', '参考视频', 'video', desc || '动作/视频参考', key, d);
      continue;
    }
    if (key === 'reference_images' || key === 'reference_image' || key === 'reference' || xHandle === 'reference_images' || xHandle === 'reference' || xHandle === 'images' || (isUri && lowerKey.includes('reference') && !lowerKey.includes('audio') && !lowerKey.includes('video'))) {
      const targetKey = lowerKey.includes('reference_images') || xHandle === 'reference_images' || lowerKey === 'reference_images' ? 'reference_images' : (lowerKey === 'reference' ? 'reference' : 'reference_images');
      const label = targetKey === 'reference' ? '参考图' : '参考图';
      pushSlot(targetKey, label, 'image', desc || '角色/主体参考图', key, d);
      continue;
    }
    if (xHandle === 'image' && isUri) {
      if (lowerKey.includes('first')) pushSlot('first_frame', '首帧', 'image', desc || '视频起始画面', key, d);
      else if (lowerKey.includes('last')) pushSlot('last_frame', '尾帧', 'image', desc || '视频结束画面', key, d);
      else pushSlot('reference_images', '参考图', 'image', desc || '参考图', key, d);
    }
  }

  if (slots.length === 0) {
    if (provider.kind === 'video') {
      slots.push(
        { key: 'first_frame', label: '首帧', type: 'image', required: false, maxCount: 1, minCount: 0, originalKey: 'first_frame' },
        { key: 'last_frame', label: '尾帧', type: 'image', required: false, maxCount: 1, minCount: 0, originalKey: 'last_frame' },
        { key: 'reference_images', label: '参考图', type: 'image', required: false, maxCount: 4, minCount: 0, originalKey: 'reference_images' }
      );
    }
  }

  return slots;
}

const slots = extractSlotsFromProvider(provider, 'video');
console.log('slots', JSON.stringify(slots, null, 2));
