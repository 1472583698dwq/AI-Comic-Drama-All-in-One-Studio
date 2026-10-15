import { describe, expect, it } from 'vitest';
import { docToMarkdown, isRichSafe, markdownToDoc, normalizeMarkdown } from '../markdownDoc';
import { renderMarkdownHtml } from '../markdownHtml';
import type { JSONContent } from '@tiptap/core';

/** REQ-toonflow-canvas N1：Markdown ⇄ tiptap 文档往返 + 预览 HTML 净化。 */

const roundTrip = (md: string) => docToMarkdown(markdownToDoc(md));
const types = (doc: JSONContent) => (doc.content || []).map((n) => n.type);

describe('Markdown → tiptap 文档', () => {
  it('块级结构：标题 / 列表 / 引用 / 代码块 / 分割线 / 表格 / 任务列表 / 图片', () => {
    const doc = markdownToDoc([
      '## 第一场',
      '- 甲',
      '- 乙',
      '1. 一',
      '2. 二',
      '> 旁白',
      '```js\nconst a = 1;\n```',
      '---',
      '| 角色 | 台词 |\n| --- | --- |\n| 林夕 | 你好 |',
      '- [ ] 待办\n- [x] 完成',
      '![定妆](/storage/a.png)',
    ].join('\n\n'));
    expect(types(doc)).toEqual([
      'heading', 'bulletList', 'orderedList', 'blockquote', 'codeBlock', 'horizontalRule', 'table', 'taskList', 'paragraph',
    ]);
    expect(doc.content![0].attrs?.level).toBe(2);
    expect(doc.content![4].attrs?.language).toBe('js');
    const task = doc.content![7];
    expect(task.content!.map((i) => i.attrs?.checked)).toEqual([false, true]);
    const img = doc.content![8].content![0];
    expect(img.type).toBe('image');
    expect(img.attrs?.src).toBe('/storage/a.png');
  });

  it('行内标记：加粗 / 斜体 / 删除线 / 行内代码 / 显式链接', () => {
    const doc = markdownToDoc('**粗** *斜* ~~删~~ `码` [官网](https://example.com)');
    const marks = (doc.content![0].content || []).flatMap((n) => (n.marks || []).map((m) => m.type));
    expect(marks).toEqual(expect.arrayContaining(['bold', 'italic', 'strike', 'code', 'link']));
  });

  it('空文本 → 只有一个空段落', () => {
    expect(markdownToDoc('')).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(docToMarkdown(markdownToDoc('  \n'))).toBe('');
  });
});

describe('往返（富文本编辑不改写正文）', () => {
  it('常见 Markdown 文档往返一致', () => {
    const md = [
      '# 策划案',
      '## 世界观',
      '赛博都市，**霓虹**与*雨夜*。',
      '- 主角：林夕\n- 反派：K',
      '1. 第一集\n2. 第二集',
      '> 一句旁白',
      '```\nshot 1\n```',
      '---',
      '- [ ] 写分镜\n- [x] 定角色',
      '![定妆](https://x.com/a.png)',
      '[参考](https://x.com/doc)',
      '~~删掉~~ `code`',
    ].join('\n\n');
    expect(roundTrip(md)).toBe(md);
    expect(isRichSafe(md)).toBe(true);
  });

  it('提示词原样保留：不转义 [ ] _ * ~ \\、不编码 & < >、不把 URL / <lora:…> 变链接', () => {
    const samples = [
      '镜头 1: [中景] 主角回眸\n台词: （无对白）',
      'a cat, 8k, (best quality:1.2), <lora:abc:0.8>, 1girl_solo, 2*3=6',
      'price $5 & 50% off, a < b > c, path C:\\tmp\\x, ~约~',
      '推镜 3~5 秒，然后 6~8 秒定格',
      '参考 https://example.com/a_b?x=1 以及 <https://example.com>',
      '【场景 1】\n镜头 1: [medium] walk\n台词: 你好\n\n镜头 2: [close] smile\n台词: （无对白）',
    ];
    for (const s of samples) {
      expect(roundTrip(s)).toBe(s);
      expect(isRichSafe(s)).toBe(true);
    }
  });

  it('单换行留在段落内（不变成硬换行 "  \\n"），再次往返稳定', () => {
    const md = '第一行\n第二行\n\n新段落';
    const doc = markdownToDoc(md);
    expect(doc.content).toHaveLength(2);
    expect(doc.content![0].content![0].text).toBe('第一行\n第二行');
    expect(roundTrip(md)).toBe(md);
  });

  it('会被规范化的写法 → isRichSafe=false（编辑器据此默认原文编辑）；规范化后再往返稳定', () => {
    const lossy = ['_斜体_', '* 星号列表', '| a | b |\n|-|-|\n| 1 | 2 |', '转义 \\*号', '<b>html</b>'];
    for (const s of lossy) {
      expect(isRichSafe(s)).toBe(false);
      const once = roundTrip(s);
      expect(roundTrip(once)).toBe(once);
    }
    expect(roundTrip('_斜体_')).toBe('*斜体*');
    expect(roundTrip('| a | b |\n|-|-|\n| 1 | 2 |')).toContain('| --- |');
  });

  it('编辑后的文档 JSON → Markdown（富文本输入的字面字符原样写出）', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '镜头' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '1girl_solo, [中景] ' }, { type: 'text', marks: [{ type: 'bold' }], text: '雨夜' }] },
      ],
    };
    expect(docToMarkdown(doc)).toBe('## 镜头\n\n1girl_solo, [中景] **雨夜**');
  });

  it('normalizeMarkdown 只忽略换行风格 / 行尾空白 / 多余空行', () => {
    expect(normalizeMarkdown('a  \r\nb\n\n\n\nc\n')).toBe('a\nb\n\nc');
  });

  it('只差块间空行（「标题\\n正文」→「标题\\n\\n正文」）仍算可富文本编辑', () => {
    expect(roundTrip('## 第一场\n雨夜，**霓虹**街道。')).toBe('## 第一场\n\n雨夜，**霓虹**街道。');
    expect(isRichSafe('## 第一场\n雨夜，**霓虹**街道。')).toBe(true);
  });
});

describe('预览 HTML（marked + DOMPurify）', () => {
  it('GFM 渲染：标题、单换行变 <br>、表格、任务列表复选框只读', () => {
    const html = renderMarkdownHtml('## 标题\n第一行\n第二行\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] 完成');
    const el = document.createElement('div');
    el.innerHTML = html;
    expect(el.querySelector('h2')?.textContent).toBe('标题');
    expect(el.querySelector('p')?.innerHTML).toBe('第一行<br>第二行');
    expect(el.querySelectorAll('td')).toHaveLength(2);
    const box = el.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
  });

  it('净化：去掉脚本 / 事件属性 / javascript: 链接 / 内联样式；外链新窗口打开', () => {
    const html = renderMarkdownHtml([
      '[坏](javascript:alert(1)) [好](https://x.com)',
      '<img src="x.png" onerror="alert(1)">',
      '<script>alert(1)</script>',
      '<span style="color:red;text-align:center">字</span>',
    ].join('\n\n'));
    expect(html).not.toMatch(/<script|onerror|javascript:|color:\s*red/i);
    const el = document.createElement('div');
    el.innerHTML = html;
    const links = Array.from(el.querySelectorAll('a'));
    const bad = links.find((a) => a.textContent === '坏')!;
    expect(bad.getAttribute('href')).toBeNull();
    const good = links.find((a) => a.textContent === '好')!;
    expect(good.getAttribute('target')).toBe('_blank');
    expect(good.getAttribute('rel')).toBe('noopener noreferrer');
    expect(el.querySelector('img')?.getAttribute('src')).toBe('x.png');
    expect((el.querySelector('span') as HTMLElement).style.textAlign).toBe('center');
  });

  it('单个 ~ 不当删除线（3~5 秒），~~x~~ 仍是删除线', () => {
    const el = document.createElement('div');
    el.innerHTML = renderMarkdownHtml('推镜 3~5 秒，然后 6~8 秒 ~~旧~~');
    expect(el.querySelectorAll('del')).toHaveLength(1);
    expect(el.querySelector('del')?.textContent).toBe('旧');
    expect(el.textContent).toContain('3~5 秒，然后 6~8 秒');
  });

  it('<lora:…> 按原文显示，http 自动链接保留；空文本返回空串', () => {
    const el = document.createElement('div');
    el.innerHTML = renderMarkdownHtml('<lora:abc:0.8> 与 <https://x.com>');
    expect(el.textContent).toContain('<lora:abc:0.8>');
    expect(el.querySelector('a')?.getAttribute('href')).toBe('https://x.com');
    expect(renderMarkdownHtml('   ')).toBe('');
  });
});
