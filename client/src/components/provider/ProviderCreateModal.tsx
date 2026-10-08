// -*- coding: utf-8 -*-
/**
 * 新建自定义生成源 · 统一入口弹窗（三 tab）
 * ①粘贴文档（推荐）：贴 API 文档/cURL → 后台任务化 LLM 生成代码 → 阶段进度可见 → 自动测试
 * ②写代码：模板起步，手写 async def generate(ctx, api)
 * ③ComfyUI 工作流：转工作流导入（导入即派生生成源）
 * 全站创建表单收敛到本组件（管理弹窗 / 画布节点 / 扩展页 / Provider 节点共用）。
 */
import React, { useEffect, useRef, useState } from 'react';
import { X, FileText, Code2, Workflow, Loader2, Check, AlertTriangle, Sparkles, ArrowRight, RefreshCw } from 'lucide-react';
import { apiService } from '../../services/api';
import { toast } from '../../stores/useDialogStore';
import { useEscapeClose } from '../../hooks/useEscapeClose';
import { CustomHeadersEditor } from './CustomHeadersEditor';
import { CAPABILITIES_BY_KIND } from './providerCapabilities';

export type CreateTab = 'doc' | 'code' | 'comfy';
export type CreateKind = 'image' | 'video' | 'audio';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** 创建成功（自动测试已跑完）；select 表示调用方应把新源选中到当前节点 */
  onCreated?: (provider: any, opts: { select: boolean }) => void;
  defaultTab?: CreateTab;
  defaultKind?: CreateKind;
  /** 画布节点发起：成功后由调用方自动选中新源 */
  selectOnCreate?: boolean;
}

const KIND_LABEL: Record<CreateKind, string> = { image: '生图 image', video: '视频 video', audio: '语音 audio' };

/** 文档导入任务的阶段步骤（与后端 stage 字段对应） */
const DOC_STAGES = [
  { key: 'fetching_docs', label: '获取 API 文档' },
  { key: 'generating_code', label: 'LLM 生成源代码' },
  { key: 'registering', label: '注册生成源' },
  { key: 'done', label: '完成' },
];

const stageIndex = (stage: string): number => {
  const i = DOC_STAGES.findIndex((s) => s.key === stage);
  if (i >= 0) return i;
  return stage === 'queued' ? 0 : -1;
};

export const ProviderCreateModal: React.FC<Props> = ({
  isOpen, onClose, onCreated, defaultTab = 'doc', defaultKind = 'image', selectOnCreate = false,
}) => {
  const [tab, setTab] = useState<CreateTab>(defaultTab);
  const [kind, setKind] = useState<CreateKind>(defaultKind);
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [language, setLanguage] = useState('python');

  // ① 贴文档
  const [docText, setDocText] = useState('');
  const [docUrl, setDocUrl] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [task, setTask] = useState<any>(null);
  const pollRef = useRef<any>(null);

  // ② 写代码
  const [code, setCode] = useState('');
  const [codeBusy, setCodeBusy] = useState(false);
  const [tplBusy, setTplBusy] = useState(false);
  const [description, setDescription] = useState('');
  const [models, setModels] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [headers, setHeaders] = useState<Record<string, string>>({});

  // 打开时重置为请求的 tab/kind（同一实例复用）
  const [openSig, setOpenSig] = useState('');
  const sig = `${defaultTab}|${defaultKind}`;
  if (isOpen && openSig !== sig) {
    setOpenSig(sig);
    setTab(defaultTab);
    setKind(defaultKind);
    setTask(null);
    setImportBusy(false);
  }

  useEscapeClose(isOpen, onClose);

  const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  useEffect(() => () => stopPoll(), []);

  const resetDoc = () => { setTask(null); stopPoll(); setImportBusy(false); };

  /** 终态处理：自动测试 → toast → 通知调用方 */
  const finishWithProvider = async (provider: any, resultStatus: string) => {
    if (!provider?.id) return;
    let testMsg = '';
    try {
      const t = await apiService.testProvider(provider.id);
      testMsg = t?.ok ? '连通测试 ✓' : `连通测试未通过：${String(t?.detail || t?.error || '').slice(0, 120)}`;
    } catch (e: any) {
      testMsg = `连通测试失败：${String(e?.message || e).slice(0, 120)}`;
    }
    if (resultStatus === 'success') {
      toast.success(`✓ 已创建 ${provider.display_name || provider.name || provider.id} · ${testMsg}`);
      onCreated?.(provider, { select: selectOnCreate });
      onClose();
    } else {
      toast.warning(`已创建 ${provider.id}，但代码编译体检未通过 · ${testMsg}`);
      onCreated?.(provider, { select: selectOnCreate });
    }
  };

  const submitDoc = async () => {
    const text = docText.trim();
    const url = docUrl.trim();
    if (!text && !url) { toast.error('请粘贴 API 文档 / cURL，或填写文档 URL'); return; }
    setImportBusy(true);
    setTask({ stage: 'queued', stage_label: '排队中…', log: [] });
    try {
      const res = await apiService.importProvider({
        kind, name: name || undefined, doc_text: text || undefined,
        doc_url: url || undefined, api_key: apiKey || undefined,
        language, async_task: true,
      });
      const tid = res?.task_id;
      if (!tid) throw new Error(res?.detail || '任务未创建');
      setTask((t: any) => ({ ...t, task_id: tid, stage: 'fetching_docs', stage_label: '任务已启动…' }));
      stopPoll();
      pollRef.current = setInterval(async () => {
        try {
          const rec = await apiService.getProviderImportTask(tid);
          setTask(rec);
          if (rec?.done) {
            stopPoll();
            setImportBusy(false);
            if (rec.stage === 'failed') {
              toast.error(`导入失败：${String(rec.error || '').slice(0, 200)}`);
              return;
            }
            await finishWithProvider(rec.provider, rec.result_status || 'success');
          }
        } catch (e: any) {
          stopPoll();
          setImportBusy(false);
          toast.error(`进度查询失败：${String(e?.message || e).slice(0, 160)}`);
        }
      }, 1500);
    } catch (e: any) {
      stopPoll();
      setImportBusy(false);
      setTask(null);
      toast.error(e?.message || '导入启动失败');
    }
  };

  const loadTemplate = async () => {
    setTplBusy(true);
    try {
      const r = await apiService.getCodeTemplate(language, kind);
      setCode(r.template || '');
    } catch (e: any) {
      toast.error(e?.message || '模板加载失败');
    } finally { setTplBusy(false); }
  };

  const toggleCap = (id: string) => {
    setCapabilities((cur) => (cur.includes(id) ? cur.filter((c) => c !== id) : [...cur, id]));
  };

  const submitCode = async () => {
    if (!code || code.trim().length < 20) {
      toast.error('代码模式需提供 python/javascript 源码（async def generate(ctx, api)），可点「加载模板」起步');
      return;
    }
    setCodeBusy(true);
    try {
      const payload: any = {
        name: name || undefined, kind, language, code,
        description: description || undefined,
        capabilities,
      };
      if (models) payload.models = models.split(',').map((s: string) => s.trim()).filter(Boolean);
      if (defaultModel) payload.default_model = defaultModel;
      if (apiKey) payload.api_key = apiKey;
      if (Object.keys(headers).length > 0) payload.headers = headers;
      const res = await apiService.createProvider(payload);
      const provider = res?.provider || {};
      await finishWithProvider(provider, 'success');
    } catch (e: any) {
      toast.error(e?.message || '创建失败');
    } finally { setCodeBusy(false); }
  };

  if (!isOpen) return null;

  const curStageIdx = task ? stageIndex(task.stage) : -1;
  const failed = task?.stage === 'failed';

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-fade-in" onClick={() => { if (!importBusy && !codeBusy) { resetDoc(); onClose(); } }}>
      <div
        role="dialog"
        aria-label="新建自定义生成源"
        className="w-full max-w-2xl max-h-[88vh] bg-surface/80 rounded-2xl border border-white/70 dark:border-white/12 flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="h-12 px-5 border-b border-white/70 dark:border-white/12 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-brand/15 border border-brand/25 text-brand"><Sparkles className="w-4 h-4" /></div>
            <div>
              <div className="text-sm font-bold text-[color:var(--color-text-main)]">新建自定义生成源</div>
              <div className="text-[10.5px] [color:var(--color-text-muted)]">贴文档自动写代码 · 手写代码 · ComfyUI 工作流派生</div>
            </div>
          </div>
          <button
            onClick={() => { if (!importBusy && !codeBusy) { resetDoc(); onClose(); } }}
            aria-label="关闭"
            className="p-1.5 rounded-lg [color:var(--color-text-muted)] hover:[color:var(--color-text-main)] hover:bg-surface/80 disabled:opacity-40"
            disabled={importBusy || codeBusy}
          ><X className="w-4.5 h-4.5" /></button>
        </div>

        {/* Tabs */}
        <div className="px-5 pt-3 flex items-center gap-1.5 shrink-0">
          {([
            ['doc', '粘贴文档（推荐）', FileText],
            ['code', '写代码', Code2],
            ['comfy', 'ComfyUI 工作流', Workflow],
          ] as const).map(([k, label, Icon]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`px-3 py-1.5 rounded-full text-[11.5px] font-medium border flex items-center gap-1.5 transition-colors ${
                tab === k ? 'bg-brand/15 text-brand border-brand/40' : 'bg-surface/80 border-white/70 dark:border-white/12 [color:var(--color-text-secondary)] hover:[color:var(--color-text-main)]'
              }`}
            ><Icon className="w-3.5 h-3.5" strokeWidth={1.7} />{label}</button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto custom-scrollbar p-5 space-y-3">
          {/* 通用：kind / 名称 / Key */}
          <div className="grid grid-cols-2 gap-2">
            <select
              value={kind} onChange={(e) => setKind(e.target.value as CreateKind)}
              className="bg-surface/80 border border-white/70 dark:border-white/12 rounded-lg px-2.5 py-2 text-xs [color:var(--color-text-main)] focus:outline-none focus:border-brand"
            >
              {(Object.keys(KIND_LABEL) as CreateKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
            <input
              value={name} onChange={(e) => setName(e.target.value)}
              placeholder="名称（可选，如 我的FLUX）"
              className="bg-surface/80 border border-white/70 dark:border-white/12 rounded-lg px-3 py-2 text-xs [color:var(--color-text-main)] placeholder:[color:var(--color-text-muted)] focus:outline-none focus:border-brand"
            />
          </div>
          {tab !== 'comfy' && (
            <input
              type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off"
              placeholder="API Key（可选；代码里用 api.get('api_key') 取）"
              className="w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-lg px-3 py-2 text-xs [color:var(--color-text-main)] placeholder:[color:var(--color-text-muted)] font-mono focus:outline-none focus:border-brand"
            />
          )}

          {/* ① 粘贴文档 */}
          {tab === 'doc' && (
            <div className="space-y-2">
              <textarea
                value={docText} onChange={(e) => setDocText(e.target.value)}
                placeholder={'粘贴 API 文档 / cURL / OpenAPI 片段…\n例：POST https://api.xxx.com/v1/images/generations  Authorization: Bearer <key>  body: {prompt, size}…'}
                rows={7}
                disabled={importBusy}
                className="w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-xl p-3 text-[11px] font-mono [color:var(--color-text-main)] placeholder:[color:var(--color-text-muted)] focus:outline-none focus:border-brand resize-none disabled:opacity-60"
              />
              <div className="flex items-center gap-2">
                <input
                  value={docUrl} onChange={(e) => setDocUrl(e.target.value)}
                  placeholder="或文档 / OpenAPI URL（可选）"
                  disabled={importBusy}
                  className="flex-1 bg-surface/80 border border-white/70 dark:border-white/12 rounded-lg px-3 py-2 text-xs [color:var(--color-text-main)] placeholder:[color:var(--color-text-muted)] focus:outline-none focus:border-brand disabled:opacity-60"
                />
                <select
                  value={language} onChange={(e) => setLanguage(e.target.value)} disabled={importBusy}
                  className="bg-surface/80 border border-white/70 dark:border-white/12 rounded-lg px-2 py-2 text-[11px] [color:var(--color-text-main)] focus:outline-none focus:border-brand disabled:opacity-60"
                >
                  <option value="python">python</option>
                  <option value="javascript">javascript</option>
                </select>
              </div>

              {/* 任务进度：阶段步骤条 + 实时阶段文案 */}
              {task && (
                <div className="p-3 rounded-xl bg-surface/80 border border-white/70 dark:border-white/12 space-y-2">
                  <div className="flex items-center gap-1.5">
                    {DOC_STAGES.map((s, i) => {
                      const done = !failed && curStageIdx > i;
                      const active = !failed && curStageIdx === i;
                      return (
                        <React.Fragment key={s.key}>
                          {i > 0 && <div className={`h-px flex-1 ${done ? 'bg-emerald-400' : 'bg-border'}`} />}
                          <div className={`flex items-center gap-1 text-[10.5px] whitespace-nowrap ${
                            failed && curStageIdx === i ? 'text-red-400'
                              : done ? 'text-emerald-400'
                              : active ? 'text-brand font-semibold'
                              : '[color:var(--color-text-muted)]'
                          }`}>
                            {done ? <Check className="w-3 h-3" /> : failed && curStageIdx === i ? <AlertTriangle className="w-3 h-3" /> : (
                              <span className={`w-3 h-3 rounded-full border ${active ? 'border-brand bg-brand/30' : 'border-white/70 dark:border-white/12'}`} />
                            )}
                            {s.label}
                          </div>
                        </React.Fragment>
                      );
                    })}
                  </div>
                  <div className={`text-[11px] flex items-center gap-1.5 ${failed ? 'text-red-400' : 'text-brand'}`}>
                    {failed ? <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> : <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />}
                    <span className="min-w-0 break-all">{failed ? (task.error || '导入失败') : (task.stage_label || '处理中…')}</span>
                  </div>
                  {!failed && <div className="text-[10px] [color:var(--color-text-muted)]">LLM 生成代码约 1–3 分钟，期间可继续别的操作，任务在后台运行。</div>}
                  {failed && (
                    <button
                      onClick={submitDoc}
                      className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs font-bold flex items-center gap-1.5"
                    ><RefreshCw className="w-3.5 h-3.5" />重试</button>
                  )}
                </div>
              )}

              <div className="flex justify-end">
                <button
                  onClick={submitDoc} disabled={importBusy}
                  className="px-4 py-2 rounded-lg bg-brand text-white text-xs font-bold flex items-center gap-1.5 disabled:opacity-50 shadow-sm shadow-brand/25"
                >
                  {importBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                  {importBusy ? '生成中…' : '让导演解析并创建'}
                </button>
              </div>
            </div>
          )}

          {/* ② 写代码 */}
          {tab === 'code' && (
            <div className="space-y-2">
              <div>
                <div className="text-[11px] [color:var(--color-text-muted)] mb-1.5">
                  能力细分（多选；不选=按插槽自动推断：{(CAPABILITIES_BY_KIND[kind] || []).map((o) => o.label).join(' / ') || '—'}）
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(CAPABILITIES_BY_KIND[kind] || []).map((o) => {
                    const on = capabilities.includes(o.id);
                    return (
                      <button
                        key={o.id} type="button" title={o.desc} onClick={() => toggleCap(o.id)}
                        className={`px-2.5 py-1 rounded-full text-[11px] font-bold border transition-all ${on ? 'bg-brand/20 border-brand text-white' : 'bg-surface/80 border-white/70 dark:border-white/12 [color:var(--color-text-secondary)] hover:[color:var(--color-text-main)]'}`}
                      >{o.label}</button>
                    );
                  })}
                </div>
              </div>
              <textarea
                value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder="描述" rows={2}
                className="w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-lg p-2 text-xs [color:var(--color-text-main)] placeholder:[color:var(--color-text-muted)] focus:outline-none focus:border-brand"
              />
              <div className="space-y-1">
                <label className="text-[11px] font-semibold [color:var(--color-text-secondary)]">自定义请求头 (Custom Headers)</label>
                <CustomHeadersEditor headers={headers} onChange={setHeaders} />
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold [color:var(--color-text-secondary)]">代码（async def generate(ctx, api)）</span>
                  <button
                    type="button" onClick={loadTemplate} disabled={tplBusy}
                    className="ml-auto px-2.5 py-1 rounded-lg bg-surface/80 border border-white/70 dark:border-white/12 text-[11px] [color:var(--color-text-secondary)] hover:[color:var(--color-text-main)] disabled:opacity-40 flex items-center gap-1"
                  >{tplBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Code2 className="w-3 h-3" />}{tplBusy ? '加载中…' : '加载模板'}</button>
                </div>
                <textarea
                  value={code} onChange={(e) => setCode(e.target.value)} rows={10}
                  placeholder="async def generate(ctx, api): ...  # 末尾可追加 # PARAMS_SCHEMA: {...}"
                  className="w-full bg-surface/80 border border-white/70 dark:border-white/12 rounded-lg p-2 font-mono text-[11px] [color:var(--color-text-main)] placeholder:[color:var(--color-text-muted)] focus:outline-none focus:border-brand resize-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={models} onChange={(e) => setModels(e.target.value)}
                  placeholder="models 逗号分隔，可空"
                  className="bg-surface/80 border border-white/70 dark:border-white/12 rounded-lg px-3 py-2 text-xs [color:var(--color-text-main)] placeholder:[color:var(--color-text-muted)] focus:outline-none focus:border-brand"
                />
                <input
                  value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)}
                  placeholder="default_model，可空"
                  className="bg-surface/80 border border-white/70 dark:border-white/12 rounded-lg px-3 py-2 text-xs [color:var(--color-text-main)] placeholder:[color:var(--color-text-muted)] focus:outline-none focus:border-brand"
                />
              </div>
              <div className="flex justify-end">
                <button
                  onClick={submitCode} disabled={codeBusy}
                  className="px-4 py-2 rounded-lg bg-brand text-white text-xs font-bold flex items-center gap-1.5 disabled:opacity-50 shadow-sm shadow-brand/25"
                >
                  {codeBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  {codeBusy ? '创建中…' : '创建'}
                </button>
              </div>
            </div>
          )}

          {/* ③ ComfyUI 工作流 */}
          {tab === 'comfy' && (
            <div className="space-y-3">
              <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/25 text-[11.5px] text-emerald-200 leading-relaxed">
                导入一个 ComfyUI 工作流（上传 .json / 粘贴 JSON / 外部目录），配置槽位映射后保存，
                它就会自动成为一个独立生成源——画布、素材库、分镜台都能直接选。
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                {[
                  ['上传 / 拖入 .json', 'ComfyUI API Format'],
                  ['粘贴 JSON 文本', '从剪贴板直接导入'],
                  ['外部目录直读', 'COMFYUI_WORKFLOWS_DIR'],
                ].map(([t, d]) => (
                  <div key={t} className="p-3 rounded-xl bg-surface/80 border border-white/70 dark:border-white/12">
                    <div className="text-[11.5px] font-semibold [color:var(--color-text-main)]">{t}</div>
                    <div className="text-[10px] [color:var(--color-text-muted)] mt-0.5">{d}</div>
                  </div>
                ))}
              </div>
              <div className="flex justify-end">
                <button
                  onClick={() => { resetDoc(); onClose(); window.dispatchEvent(new CustomEvent('open-workflow-import')); }}
                  className="px-4 py-2 rounded-lg bg-brand text-white text-xs font-bold flex items-center gap-1.5 shadow-sm shadow-brand/25"
                ><ArrowRight className="w-3.5 h-3.5" />打开工作流导入</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
