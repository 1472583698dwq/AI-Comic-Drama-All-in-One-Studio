import React, { useEffect, useState } from 'react';
import { X, Save, Loader2, FileText, Cpu, Copy, Check } from 'lucide-react';
import { apiService } from '../../services/api';
import { toast } from '../../stores/useDialogStore';
import { useEscapeClose } from '../../hooks/useEscapeClose';

interface Props {
  /** 扩展条目（来自 /extensions） */
  ext: any;
  onClose: () => void;
  onSaved?: () => void;
}

/**
 * 技能编辑 / MCP 工具预览。
 *
 * - 技能：读原始 SKILL.md 全文（含 frontmatter）→ 改 → 用 /skills/import 覆盖保存，
 *   无损往返，不靠字段拼装。
 * - MCP 工具：后端没有任何写接口（内置工具是代码、插件工具在包里），只做预览。
 */
export const ExtensionDetailDrawer: React.FC<Props> = ({ ext, onClose, onSaved }) => {
  const isSkill = ext?.kind === 'skill';
  const isTool = ext?.kind === 'mcp_tool';
  const [content, setContent] = useState('');
  const [origin, setOrigin] = useState('');
  const [filePath, setFilePath] = useState('');
  const [tool, setTool] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  useEscapeClose(true, onClose);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        if (isSkill) {
          const r = await apiService.getSkillRaw(ext.local_id);
          if (cancelled) return;
          setContent(r?.content || '');
          setOrigin(r?.content || '');
          setFilePath(r?.file_path || '');
        } else if (isTool) {
          const tools = await apiService.listMcpTools();
          if (cancelled) return;
          setTool((tools as any[]).find((t) => t.name === ext.local_id) || null);
        }
      } catch (e: any) {
        if (!cancelled) toast.error(e?.message || '读取失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [ext?.id]);

  const dirty = isSkill && content !== origin;

  const save = async () => {
    setSaving(true);
    try {
      await apiService.importSkill(undefined, content, ext.local_id);
      toast.success('已保存并重载');
      setOrigin(content);
      onSaved?.();
      onClose();
    } catch (e: any) {
      toast.error(e?.message || '保存失败');
    } finally { setSaving(false); }
  };

  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(tool?.input_schema ?? {}, null, 2));
      setCopied(true); setTimeout(() => setCopied(false), 1800);
    } catch { toast.error('复制失败'); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-3xl max-h-[85vh] bg-white/60 dark:bg-white/[.05] rounded-2xl border border-white/70 dark:border-white/12 flex flex-col overflow-hidden">
        <div className="h-12 px-4 border-b border-white/70 dark:border-white/12 flex items-center gap-2 shrink-0">
          {isSkill ? <FileText className="w-4 h-4 text-amber-400" /> : <Cpu className="w-4 h-4 text-emerald-400" />}
          <span className="text-sm font-bold text-[color:var(--color-text-main)]">
            {isSkill ? '编辑技能' : isTool ? '工具预览' : '扩展详情'} {ext.local_id}
          </span>
          {!isSkill && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/65 dark:bg-white/[.09] border border-white/70 dark:border-white/12 text-gray-400">只读</span>
          )}
          <button onClick={onClose} className="ml-auto p-1 rounded hover:bg-white/65 dark:bg-white/[.09]">
            <X className="w-4 h-4 text-gray-400" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-3">
          {loading ? (
            <div className="text-[11.5px] text-gray-500 flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />读取中…
            </div>
          ) : isSkill ? (
            <>
              {filePath && <div className="text-[10.5px] font-mono text-gray-600 break-all">{filePath}</div>}
              <textarea
                value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} rows={22}
                className="w-full bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12 rounded-xl p-3 text-[11.5px] font-mono text-[color:var(--color-text-main)] leading-relaxed focus:outline-none focus:border-brand/60 resize-none"
              />
              <div className="text-[10.5px] text-gray-500 leading-relaxed">
                这是原始 SKILL.md 全文，上面的 <code className="font-mono">---</code> 之间是 frontmatter
                （name / description / tools 等），下面是给模型看的执行规范。保存即覆盖原文件并重载。
              </div>
            </>
          ) : !isTool ? (
            <GenericPreview ext={ext} />
          ) : tool ? (
            <>
              <div>
                <div className="text-[11px] text-gray-500 mb-1">描述</div>
                <div className="text-[12px] text-[color:var(--color-text-main)] leading-relaxed">
                  {tool.description || '（无）'}
                </div>
              </div>
              <div className="flex flex-wrap gap-2 text-[11px]">
                {tool.category && <Tag label={`分类 ${tool.category}`} />}
                {tool.author && <Tag label={`来源 ${tool.author}`} />}
                {ext.source_detail && <Tag label={`插件 ${ext.source_detail}`} />}
              </div>
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[11px] text-gray-500">入参 schema</span>
                  <button onClick={copyJson} className="text-[10.5px] text-gray-400 hover:text-white flex items-center gap-1">
                    {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    {copied ? '已复制' : '复制'}
                  </button>
                </div>
                <pre className="rounded-xl bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12 p-3 text-[11px] font-mono text-gray-300 overflow-auto max-h-80">
                  {JSON.stringify(tool.input_schema ?? {}, null, 2)}
                </pre>
              </div>
              <div className="text-[10.5px] text-gray-500 leading-relaxed">
                工具的实现是代码（内置在程序里，或由插件包带入），没有可编辑的定义文件。
                想试跑请用「自己造一个」里的 <b>MCP 工具</b> 面板。
              </div>
            </>
          ) : (
            <div className="text-[11.5px] text-gray-500">没找到这个工具的定义，可能刚被停用或卸载。</div>
          )}
        </div>

        {isSkill && (
          <div className="h-12 px-4 border-t border-white/70 dark:border-white/12 flex items-center gap-2 shrink-0">
            {dirty && <span className="text-[11px] text-amber-300">有未保存的修改</span>}
            <button onClick={onClose} className="ml-auto px-3 py-1.5 rounded-lg bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12 text-[11.5px] text-gray-300 hover:text-white">
              取消
            </button>
            <button onClick={save} disabled={!dirty || saving}
              className="px-4 py-1.5 rounded-lg bg-brand text-white text-[11.5px] font-bold hover:bg-brand-light disabled:opacity-40 flex items-center gap-1.5">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}保存
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

/** 没有专属编辑/预览界面的 kind：至少把它的身份与来源摊开，别做成死点 */
const GenericPreview: React.FC<{ ext: any }> = ({ ext }) => {
  const rows: Array<[string, any]> = [
    ['全局 id', ext.id],
    ['本地 id', ext.local_id],
    ['类别', ext.kind],
    ['子类', ext.sub_kind || '—'],
    ['来源', ext.source === 'plugin' ? `插件 ${ext.source_detail || ''}` : ext.source === 'builtin' ? '内置' : '自建'],
    ['发布者', ext.publisher || '—'],
    ['版本', ext.version || '—'],
    ['状态', ext.status],
    ['派生自', ext.derived_from || '—'],
    ['依赖', (ext.depends_on || []).join(', ') || '—'],
  ];
  return (
    <>
      {ext.description && (
        <div className="text-[12px] text-[color:var(--color-text-main)] leading-relaxed">{ext.description}</div>
      )}
      <div className="rounded-xl border border-white/70 dark:border-white/12 overflow-hidden">
        {rows.map(([k, v], i) => (
          <div key={k} className={`px-3 py-1.5 flex items-baseline gap-3 ${i % 2 ? 'bg-white/50 dark:bg-white/[.04]' : 'bg-surface-secondary/20'}`}>
            <span className="text-[11px] text-gray-500 w-20 shrink-0">{k}</span>
            <span className="text-[11px] font-mono text-gray-300 break-all">{String(v)}</span>
          </div>
        ))}
      </div>
      <div className="text-[10.5px] text-gray-500 leading-relaxed">
        这类扩展没有单项编辑接口（整包 POST 替换或由代码提供），只能看。
        要改内容请重新导入对应的包或声明文件。
      </div>
    </>
  );
};

const Tag: React.FC<{ label: string }> = ({ label }) => (
  <span className="px-2 py-0.5 rounded border border-white/70 dark:border-white/12 bg-white/65 dark:bg-white/[.09] text-gray-400">{label}</span>
);
