// -*- coding: utf-8 -*-
/**
 * AI 润色的公共逻辑 —— 两个入口共用，避免各写一套：
 *   · `AiPolishButton`    字段级入口（显式按钮 + 全功能弹窗，整段替换）
 *   · `SelectionPolish`   选区级入口（选中文字才出现，只替换选区）
 *
 * 这里只放两边**确实相同**的东西：技能清单加载/排序、上下文类型猜法、
 * 后端返回结果提取、受控输入框的写回。各自特有的交互（弹窗/浮标、应用策略）
 * 留在各自组件里。
 */
import { apiService } from '../../services/api';

export type PolishContextType = 'prompt' | 'dialogue' | 'general';

export interface PolishSkill {
  name: string;
  description?: string;
  category?: string;
  author?: string;
  version?: string;
  tools?: string[];
  [k: string]: any;
}

/** 后端拉不到技能时的兜底清单（与内置 SKILL.md 名称一致） */
export const POLISH_FALLBACK_SKILLS: PolishSkill[] = [
  { name: 'prompt-master-optimizer', description: '万能优化' },
  { name: 'prompt-cinematic-boost', description: '电影感' },
  { name: 'prompt-detail-enhancer', description: '细节增强' },
  { name: 'prompt-anime-optimizer', description: '二次元' },
  { name: 'dialogue-emotion-polish', description: '台词情绪' },
];

/** 拉取可用于润色的技能；失败返回兜底清单（不抛错，润色入口不该因列表失败而消失）。 */
export async function loadPolishSkills(): Promise<PolishSkill[]> {
  try {
    const list = await apiService.listSkills();
    const all: PolishSkill[] = Array.isArray(list) ? list : (list as any)?.skills || [];
    if (!all.length) return POLISH_FALLBACK_SKILLS;
    // 优先展示提示词优化类；没有该分类时退回全量（用户可能自建了技能）
    const polish = all.filter((s) => s.category === 'prompt_optimization');
    return polish.length ? polish : all;
  } catch {
    return POLISH_FALLBACK_SKILLS;
  }
}

/** 由输入框的 placeholder + 当前值猜上下文类型（决定推荐哪个技能）。 */
export function guessContextType(el: HTMLTextAreaElement | HTMLInputElement | null): PolishContextType {
  if (!el) return 'general';
  const text = `${el.placeholder || ''} ${el.value || ''}`.toLowerCase();
  if (text.includes('台词') || text.includes('对白') || text.includes('dialogue') || text.includes('配音')) return 'dialogue';
  if (text.includes('画面') || text.includes('提示词') || text.includes('prompt') || text.includes('镜头') || text.includes('机位')) return 'prompt';
  return 'general';
}

/** 按上下文类型把最合适的技能排到前面（不改原数组）。 */
export function sortPolishSkills(skills: PolishSkill[], contextType: PolishContextType): PolishSkill[] {
  const order: Record<string, number> = {};
  if (contextType === 'prompt') {
    order['prompt-master-optimizer'] = 0;
    order['prompt-cinematic-boost'] = 1;
    order['prompt-detail-enhancer'] = 2;
    order['prompt-anime-optimizer'] = 3;
  } else if (contextType === 'dialogue') {
    order['dialogue-emotion-polish'] = 0;
    order['prompt-master-optimizer'] = 1;
  }
  return [...skills].sort((a, b) => (order[a.name] ?? 99) - (order[b.name] ?? 99));
}

/**
 * 从 `/skills/execute` 的返回里取出润色文本。
 * 各技能返回形态不一（modified_data.polished_prompt / polished_text / result_message，
 * 有时整体是一段 JSON 字符串），这里统一收口。
 */
export function extractPolishResult(res: any): { text: string; suggestedEmotion: string } {
  let text: string =
    res?.modified_data?.polished_prompt ||
    res?.modified_data?.polished_text ||
    res?.result_message ||
    '';
  let suggestedEmotion: string = res?.modified_data?.suggested_emotion || '';

  text = String(text || '').trim();

  // 结果被 JSON 包裹（部分技能会把结构体当文本返回）
  if (text.startsWith('{') && text.includes('polished_text')) {
    try {
      const j = JSON.parse(text);
      text = String(j.polished_text || j.polished_prompt || text).trim();
      if (!suggestedEmotion && j.suggested_emotion) suggestedEmotion = j.suggested_emotion;
    } catch { /* 非合法 JSON，保持原样 */ }
  }
  return { text, suggestedEmotion };
}

/**
 * 以「原生 setter + 派发事件」的方式写入受控输入框的值。
 * React 的受控组件靠 setter 劫持追踪变化，直接 `el.value = x` 不会触发 onChange。
 */
export function setNativeValue(el: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  const proto = el.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else (el as any).value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * 只替换 `[start, end)` 这一段，其余原样保留（选区级润色的关键：不能整段覆盖）。
 * 返回替换后的全文与新的光标位置，便于调用方恢复选区。
 */
export function replaceRange(
  el: HTMLTextAreaElement | HTMLInputElement,
  start: number,
  end: number,
  text: string,
): { value: string; caret: number } {
  const cur = el.value || '';
  const s = Math.max(0, Math.min(start, cur.length));
  const e = Math.max(s, Math.min(end, cur.length));
  const next = cur.slice(0, s) + text + cur.slice(e);
  setNativeValue(el, next);
  return { value: next, caret: s + text.length };
}

/** 调用技能做润色（第三条 `userPrompt` 传原文，与既有两条链路口径一致）。 */
export async function runPolish(
  skillName: string,
  original: string,
  contextType: PolishContextType,
): Promise<{ text: string; suggestedEmotion: string }> {
  const context: Record<string, any> = {
    original_prompt: original,
    prompt: original,
    text: original,
    context_type: contextType,
  };
  const res = await apiService.executeSkill(skillName, context, original);
  return extractPolishResult(res);
}
