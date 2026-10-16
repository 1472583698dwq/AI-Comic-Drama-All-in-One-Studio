// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas N1 文本节点：Markdown 编辑器（对照 Toonflow textNode/markdownEditor.vue）。
 * 工具条：标题 / 加粗 / 斜体 / 列表 / 撤销 / 重做 ｜ 复制正文 / 原文⇄富文本；
 * 富文本 = tiptap（@tiptap/react + starter-kit + 表格 / 任务列表 / 图片），Markdown 进出见 markdownDoc.ts；
 * 原文 = 直接编辑 Markdown 源码。正文无法被富文本原样保留时（isRichSafe=false）默认用原文编辑，避免静默改写。
 * 本文件由 TextDocumentDialog 懒加载（tiptap 表格等扩展与 @tiptap/markdown 不进首屏包）。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import { Placeholder } from '@tiptap/extensions';
import { docToMarkdown, isRichSafe, markdownSchemaExtensions, markdownToDoc } from './markdownDoc';
import { copyText } from './clipboard';

export interface MarkdownEditorProps {
  value: string;
  onChange: (markdown: string) => void;
  /** 只读（生成中） */
  readOnly?: boolean;
  ariaLabel?: string;
}

type Action = 'heading' | 'bold' | 'italic' | 'list' | 'undo' | 'redo';

const ACTIONS: { key: Action; label: string; title: string }[] = [
  { key: 'heading', label: '标题', title: '二级标题' },
  { key: 'bold', label: '加粗', title: '加粗（⌘/Ctrl+B）' },
  { key: 'italic', label: '斜体', title: '斜体（⌘/Ctrl+I）' },
  { key: 'list', label: '列表', title: '无序列表' },
  { key: 'undo', label: '撤销', title: '撤销（⌘/Ctrl+Z）' },
  { key: 'redo', label: '重做', title: '重做（⌘/Ctrl+Shift+Z）' },
];

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

function toolbarState(e: Editor | null) {
  if (!e || e.isDestroyed) return null;
  return {
    heading: e.isActive('heading', { level: 2 }),
    bold: e.isActive('bold'),
    italic: e.isActive('italic'),
    list: e.isActive('bulletList'),
    undo: e.can().undo(),
    redo: e.can().redo(),
  };
}

function EditorToolbar({ editor, disabled, right }: { editor: Editor | null; disabled: boolean; right: ReactNode }) {
  const watched = useEditorState({ editor, selector: ({ editor: e }) => toolbarState(e) });
  // useEditorState 要等编辑器第一次事务才算出状态：编辑器刚挂上时直接算一次，避免按钮一直置灰
  const state = watched ?? toolbarState(editor);
  const run = (action: Action) => {
    if (!editor || disabled) return;
    const chain = editor.chain().focus();
    if (action === 'heading') chain.toggleHeading({ level: 2 }).run();
    else if (action === 'bold') chain.toggleBold().run();
    else if (action === 'italic') chain.toggleItalic().run();
    else if (action === 'list') chain.toggleBulletList().run();
    else if (action === 'undo') chain.undo().run();
    else chain.redo().run();
  };
  return (
    <div className="cv-md-editor__toolbar" role="toolbar" aria-label="Markdown 编辑工具">
      {ACTIONS.map(({ key, label, title }) => {
        const toggle = key !== 'undo' && key !== 'redo';
        const off = disabled || !editor || !state || (key === 'undo' && !state.undo) || (key === 'redo' && !state.redo);
        return (
          <button
            key={key}
            type="button"
            title={title}
            disabled={off}
            aria-pressed={toggle ? !!state?.[key] : undefined}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run(key)}
          >
            {label}
          </button>
        );
      })}
      <span className="cv-md-editor__spacer" />
      {right}
    </div>
  );
}

/** 富文本面板：只在用户真正编辑时回写（打开、切换模式不会改写正文）。 */
function RichPane({ value, onChange, readOnly, ariaLabel, onEditor, onError }: {
  value: string; onChange: (v: string) => void; readOnly: boolean; ariaLabel: string; onEditor: (editor: Editor | null) => void; onError: (msg: string) => void;
}) {
  const lastRef = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const editorRef = useRef<Editor | null>(null);

  const extensions = useMemo(() => [
    ...markdownSchemaExtensions(),
    Placeholder.configure({ placeholder: '输入正文，支持 Markdown…' }),
  ], []);
  const [initial] = useState(() => {
    try {
      return { doc: markdownToDoc(value), error: '' };
    } catch (e) {
      return { doc: markdownToDoc(''), error: errorText(e, '正文解析失败，可切换原文继续编辑') };
    }
  });
  useEffect(() => {
    if (initial.error) onErrorRef.current(initial.error);
  }, [initial]);
  const editorProps = useMemo(() => ({
    attributes: { class: 'cv-md cv-md-editor__content', role: 'textbox', 'aria-multiline': 'true', 'aria-label': ariaLabel },
    // 粘贴纯文本按 Markdown 解析（Toonflow 同款）；带 HTML 的剪贴板交给 tiptap 自己解析
    handlePaste: (_view: unknown, event: ClipboardEvent) => {
      const ed = editorRef.current;
      const cb = event.clipboardData;
      if (!ed || readOnlyRef.current || ed.isActive('codeBlock') || cb?.getData('text/html')) return false;
      const text = cb?.getData('text/markdown') || cb?.getData('text/plain');
      if (!text) return false;
      const blocks = markdownToDoc(text).content || [];
      const content = blocks.length === 1 && blocks[0].type === 'paragraph' ? blocks[0].content || [] : blocks;
      return content.length ? ed.commands.insertContent(content) : false;
    },
  }), [ariaLabel]);

  const editor = useEditor({
    extensions,
    content: initial.doc,
    editable: !readOnly,
    shouldRerenderOnTransaction: false,
    editorProps,
    onUpdate: ({ editor: ed }) => {
      try {
        const md = docToMarkdown(ed.getJSON());
        if (md === lastRef.current) return;
        lastRef.current = md;
        onChangeRef.current(md);
      } catch (e) {
        onErrorRef.current(errorText(e, '正文序列化失败，可切换原文继续编辑'));
      }
    },
  });
  editorRef.current = editor;

  // 外部改了正文（生成结果、Agent 写入）→ 重建内容，不回写
  useEffect(() => {
    if (!editor || editor.isDestroyed || value === lastRef.current) return;
    lastRef.current = value;
    try {
      editor.commands.setContent(markdownToDoc(value), { emitUpdate: false });
    } catch (e) {
      onErrorRef.current(errorText(e, '正文更新失败'));
    }
  }, [editor, value]);
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.setEditable(!readOnly, false);
  }, [editor, readOnly]);
  // 工具条由父组件渲染在固定位置（切换原文 / 富文本时按钮不重建、焦点不丢）
  const onEditorRef = useRef(onEditor);
  onEditorRef.current = onEditor;
  useEffect(() => {
    onEditorRef.current(editor);
    return () => onEditorRef.current(null);
  }, [editor]);

  return (
    <div className="cv-md-editor__rich nowheel">
      <EditorContent editor={editor} />
    </div>
  );
}

export default function MarkdownEditor({ value, onChange, readOnly = false, ariaLabel = '编辑文本内容' }: MarkdownEditorProps) {
  // REQ-toonflow-canvas 富文本无法原样保留时默认原文编辑（见 markdownDoc.isRichSafe）
  const [richSafe] = useState(() => isRichSafe(value));
  const [sourceMode, setSourceMode] = useState(!richSafe);
  const [error, setError] = useState('');
  const [richEditor, setRichEditor] = useState<Editor | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    setError('');
    if (await copyText(value)) setCopied(true);
    else setError('复制失败，请在原文中选择并复制');
  };
  const toolbarRight = (
    <>
      <button type="button" onClick={() => void copy()} disabled={!value}>{copied ? '已复制' : '复制正文'}</button>
      <button
        type="button"
        aria-pressed={sourceMode}
        title={sourceMode ? '切换到富文本编辑' : '切换到 Markdown 原文编辑'}
        onClick={() => { setError(''); setSourceMode((v) => !v); }}
      >
        {sourceMode ? '富文本' : '原文'}
      </button>
    </>
  );

  return (
    <section className="cv-md-editor">
      <EditorToolbar editor={sourceMode ? null : richEditor} disabled={sourceMode || readOnly} right={toolbarRight} />
      {error && <p className="cv-md-editor__error" role="alert">{error}</p>}
      {sourceMode && !richSafe && (
        <p className="cv-md-editor__notice" role="note">本文含有富文本会改写的写法（如表格格式、转义字符、HTML），已默认用原文编辑；切换到富文本后一经修改会按 Markdown 规范重写全文。</p>
      )}
      {sourceMode ? (
        <textarea
          className="cv-md-editor__source nowheel"
          value={value}
          readOnly={readOnly}
          aria-label="编辑 Markdown 原文"
          spellCheck={false}
          onChange={(e) => { if (!readOnly) onChange(e.target.value); }}
        />
      ) : (
        <RichPane value={value} onChange={onChange} readOnly={readOnly} ariaLabel={ariaLabel} onEditor={setRichEditor} onError={setError} />
      )}
      <p className="cv-md-editor__hint">富文本会规范化 Markdown（列表符号、表格对齐等）；需要逐字保留的提示词请用原文编辑。</p>
    </section>
  );
}
