import { describe, expect, it } from 'vitest';
import type { RefItem } from '../../../kit';
import {
  RUNNING_STALE_MS, TEXT_SKILLS, buildSkillRequest, documentOf, documentPatch, isRunningState, markdownFileName, normalizeSkillId,
} from '../skills';

/** REQ-toonflow-canvas N1：技能下拉 + execute(overrides) 组装（键名是与宿主 H1 的约定，见 progress/N1.md）。 */

const story: RefItem = { key: 'txt|prompt', sourceId: 'txt', sourceHandle: 'prompt', sourceType: 'prompt', dataType: 'STRING', value: '雨夜，主角撑伞走过霓虹街道。', label: '故事' };
const image: RefItem = { key: 'img|image', sourceId: 'img', sourceHandle: 'image', sourceType: 'load-image', dataType: 'IMAGE', value: 'http://x/a.png', label: '定妆' };
const camera: RefItem = { key: 'cam|camera_prompt', sourceId: 'cam', sourceHandle: 'camera_prompt', sourceType: 'director3d', dataType: 'STRING', value: '[推进] 中景 → 近景', label: '3D 导演' };
const empty: RefItem = { key: 'e|prompt', sourceId: 'e', sourceHandle: 'prompt', sourceType: 'prompt', dataType: 'STRING', value: '', label: '空' };

describe('技能', () => {
  it('四个技能：自由生成（缺省）/ 扩写 / 剧本拆解 / 策划案；id 与宿主分支一致', () => {
    expect(TEXT_SKILLS.map((s) => [s.id, s.label])).toEqual([
      ['free_generation', '自由生成'],
      ['prompt_expansion', '扩写'],
      ['script_generation', '剧本拆解'],
      ['proposal_generation', '策划案'],
    ]);
    expect(normalizeSkillId(undefined)).toBe('free_generation');
    expect(normalizeSkillId('script_generation')).toBe('script_generation');
    expect(normalizeSkillId('custom_text')).toBe('free_generation');
    expect(normalizeSkillId('text_to_image')).toBe('free_generation');
  });
});

describe('正文键', () => {
  it('读取 prompt 优先（= 下游拿到的值），空时回落 text；写回两键同步', () => {
    expect(documentOf({ prompt: 'P', text: 'T' })).toBe('P');
    expect(documentOf({ prompt: '  ', text: 'T' })).toBe('T');
    expect(documentOf({ text: 'T' })).toBe('T');
    expect(documentOf({ prompt: 3 })).toBe('');
    expect(documentOf(undefined)).toBe('');
    // 都空白：原样返回（编辑器里先敲的换行 / 空格不丢）
    expect(documentOf({ prompt: '\n', text: '\n' })).toBe('\n');
    expect(documentPatch('## 标题')).toEqual({ text: '## 标题', prompt: '## 标题' });
  });
});

describe('buildSkillRequest → execute(overrides)', () => {
  it('指令 + 参考：{{ref N}} → 参考 N，文本参考（含 3D 导演机位）附在后面，图片给出编号对应并单独下发', () => {
    const req = buildSkillRequest({
      skillId: 'script_generation',
      instruction: '把 {{ref 1}} 拆成分镜，画风参考 {{ref 2}}',
      document: '旧正文',
      refs: [story, image, camera],
    });
    expect(req.ok).toBe(true);
    expect(Object.keys(req.overrides).sort()).toEqual([
      'gen_prompt', 'input_source', 'prompt', 'reference_images', 'reference_videos', 'refs', 'skill_id', 'source_text',
    ]);
    expect(req.overrides).toMatchObject({
      skill_id: 'script_generation',
      gen_prompt: '把 {{ref 1}} 拆成分镜，画风参考 {{ref 2}}',
      source_text: '旧正文',
      input_source: 'instruction',
      reference_images: ['http://x/a.png'],
      reference_videos: [],
    });
    expect(req.overrides.prompt).toBe([
      '把 参考 1 拆成分镜，画风参考 参考 2',
      '参考 1：\n雨夜，主角撑伞走过霓虹街道。',
      '参考 3：\n[推进] 中景 → 近景',
      '（参考编号对应：参考 2=第 1 张参考图）',
    ].join('\n\n'));
    expect(req.overrides.refs).toEqual([
      { n: 1, key: 'txt|prompt', source_id: 'txt', source_type: 'prompt', type: 'STRING', value: story.value, label: '故事' },
      { n: 2, key: 'img|image', source_id: 'img', source_type: 'load-image', type: 'IMAGE', value: 'http://x/a.png', label: '定妆' },
      { n: 3, key: 'cam|camera_prompt', source_id: 'cam', source_type: 'director3d', type: 'STRING', value: camera.value, label: '3D 导演' },
    ]);
    expect(req.warnings).toEqual(['「剧本拆解」只处理文本，参考 2 不会使用']);
  });

  it('自由生成不提示「媒体不会使用」（宿主可把图片交给多模态 LLM）', () => {
    const req = buildSkillRequest({ skillId: 'free_generation', instruction: '描述 {{ref 1}}', document: '', refs: [image] });
    expect(req.ok).toBe(true);
    expect(req.warnings).toEqual([]);
    expect(req.overrides.prompt).toBe('描述 参考 1\n\n（参考编号对应：参考 1=第 1 张参考图）');
  });

  it('指令为空：第一条文本参考作主体（不加前缀）→ input_source=refs', () => {
    const req = buildSkillRequest({ skillId: 'prompt_expansion', instruction: '  ', document: '正文', refs: [story] });
    expect(req.ok).toBe(true);
    expect(req.overrides.input_source).toBe('refs');
    expect(req.overrides.prompt).toBe(story.value);
  });

  it('指令与文本参考都空：扩写 / 拆解 / 策划案改用当前正文；自由生成不能发送', () => {
    for (const skillId of ['prompt_expansion', 'script_generation', 'proposal_generation']) {
      const req = buildSkillRequest({ skillId, instruction: '', document: '# 正文\n内容', refs: [] });
      expect(req.ok).toBe(true);
      expect(req.overrides.input_source).toBe('document');
      expect(req.overrides.prompt).toBe('# 正文\n内容');
    }
    const free = buildSkillRequest({ skillId: 'free_generation', instruction: '', document: '正文', refs: [] });
    expect(free.ok).toBe(false);
    expect(free.reason).toBe('请输入提示词，或连接文本参考');
    expect(buildSkillRequest({ skillId: 'prompt_expansion', instruction: '', document: '', refs: [] }).reason).toBe('请输入提示词，或连接文本参考 / 先写正文');
  });

  it('指令引用了暂无内容的参考：不能发送（同 Toonflow）；未引用的空参考只提示跳过', () => {
    const blocked = buildSkillRequest({ skillId: 'free_generation', instruction: '续写 {{ref 1}}', document: '', refs: [empty, story] });
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe('参考 1 暂无内容，请先补充引用内容');
    expect(blocked.warnings).toEqual(['参考 1 暂无内容，请先补充引用内容']);
    const skipped = buildSkillRequest({ skillId: 'free_generation', instruction: '续写 {{ref 2}}', document: '', refs: [empty, story] });
    expect(skipped.ok).toBe(true);
    expect(skipped.warnings).toEqual(['参考 1 暂无内容，已跳过']);
  });

  it('引用编号超出参考列表：提示重新引用', () => {
    const req = buildSkillRequest({ skillId: 'free_generation', instruction: '看 {{ref 3}}', document: '', refs: [story] });
    expect(req.ok).toBe(true);
    expect(req.warnings).toContain('参考 3 不存在，请重新引用');
  });
});

describe('运行态与文件名', () => {
  it('agent_state=running 且 10 分钟内更新才算运行中', () => {
    const now = Date.parse('2026-10-15T10:00:00Z');
    expect(isRunningState({ status: 'running', updated_at: '2026-10-15T09:59:00Z' }, now)).toBe(true);
    expect(isRunningState({ status: 'running', updated_at: new Date(now - RUNNING_STALE_MS - 1).toISOString() }, now)).toBe(false);
    expect(isRunningState({ status: 'running' }, now)).toBe(true);
    expect(isRunningState({ status: 'completed', updated_at: '2026-10-15T09:59:00Z' }, now)).toBe(false);
    expect(isRunningState(null, now)).toBe(false);
  });

  it('下载文件名：节点标题去掉非法字符，缺省「文本.md」', () => {
    expect(markdownFileName('第1集/分镜:草稿')).toBe('第1集 分镜 草稿.md');
    expect(markdownFileName('')).toBe('文本.md');
    expect(markdownFileName(undefined)).toBe('文本.md');
  });
});
