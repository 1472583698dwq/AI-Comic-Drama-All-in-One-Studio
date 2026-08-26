import React, { useEffect, useState } from 'react';
import {
  Settings, KeyRound, Cpu, Sliders, Info, Save, TestTube2,
  Eye, EyeOff, CheckCircle2, XCircle, Loader2, Copy, ExternalLink,
  Bot, Mic, Film, FolderCheck, ArrowLeft, RefreshCw, Sparkles, Layers,
  Zap, Globe, Database, HelpCircle, Folder, FolderSearch, FolderOpen, Trash2
} from 'lucide-react';
import { apiService } from '../services/api';
import { useProjectStore } from '../stores/useProjectStore';
import { WorkflowInspectorModal } from '../components/workflow/WorkflowInspectorModal';

type TabKey = 'llm' | 'image' | 'voice' | 'video' | 'jianyin' | 'system';

interface TabItem {
  key: TabKey;
  label: string;
  sub: string;
  icon: React.ReactNode;
  badge?: string;
}

const TABS: TabItem[] = [
  { key: 'llm', label: '大模型与剧本引擎 (LLM)', sub: 'OpenAI / Responses API / DeepSeek / 通义', icon: <Bot className="w-4 h-4" />, badge: '核心' },
  { key: 'image', label: '分镜生图引擎 (Image)', sub: 'ComfyUI / 硅基流动 / 阿里万相', icon: <Cpu className="w-4 h-4" />, badge: '核心' },
  { key: 'voice', label: '角色配音引擎 (TTS)', sub: 'CosyVoice / MiniMax / GPT-SoVITS', icon: <Mic className="w-4 h-4" /> },
  { key: 'video', label: '视频与动效模型 (Video)', sub: 'Video-01 / 可灵 / Vidu', icon: <Film className="w-4 h-4" /> },
  { key: 'jianyin', label: '剪映草稿与存储路径', sub: '本地剪映草稿箱无缝直连', icon: <FolderCheck className="w-4 h-4" /> },
  { key: 'system', label: '系统与环境概览', sub: '端点与 .env 状态', icon: <Info className="w-4 h-4" /> },
];

export const ConfigView: React.FC = () => {
  const { setActiveTab } = useProjectStore();
  const [tab, setTab] = useState<TabKey>('llm');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; detail: string } | null>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [envFile, setEnvFile] = useState('');
  const [checks, setChecks] = useState<Record<string, any>>({});
  const [workflowList, setWorkflowList] = useState<any[]>([]);
  const [loadingWfs, setLoadingWfs] = useState(false);
  const [inspectingWorkflowId, setInspectingWorkflowId] = useState('');

  const loadWorkflowsList = async () => {
    setLoadingWfs(true);
    try {
      const res = await apiService.listWorkflows('all');
      setWorkflowList(res.workflows || res || []);
    } catch (e) {
    } finally {
      setLoadingWfs(false);
    }
  };

  const handleDeleteWorkflow = async (wf: any) => {
    if (wf.source !== 'internal') {
      alert('外部直读工作流为只读，请直接在文件系统中删除对应的 JSON 文件');
      return;
    }
    if (!confirm(`确定要永久删除内部工作流 "${wf.name || wf.id}" 吗？\n此操作将删除 storage/workflows/${wf.id}.json 与 .meta.json，且不可恢复。`)) return;
    try {
      await apiService.deleteWorkflow(wf.id);
      // 立即本地过滤，避免后端缓存或竞态导致列表未刷新
      setWorkflowList(prev => prev.filter((w: any) => w.id !== wf.id));
      // 若被删的是默认工作流，同步清空默认配置（需用户手动保存）
      let needClearDefault = false;
      if (form.COMFYUI_DEFAULT_IMAGE_WORKFLOW === wf.id) {
        setField('COMFYUI_DEFAULT_IMAGE_WORKFLOW', '');
        needClearDefault = true;
      }
      if (form.COMFYUI_DEFAULT_VIDEO_WORKFLOW === wf.id) {
        setField('COMFYUI_DEFAULT_VIDEO_WORKFLOW', '');
        needClearDefault = true;
      }
      if (needClearDefault) {
        setMsg({ type: 'success', text: `已删除工作流 ${wf.id}，已自动清空对应的默认配置，请记得点击“保存全部配置”` });
      } else {
        setMsg({ type: 'success', text: `已删除内部工作流 ${wf.id}` });
      }
      // 强制重新拉取以确保与后端一致（带时间戳防缓存）
      await loadWorkflowsList();
      // 二次校验：若仍存在则再次过滤
      setWorkflowList(prev => prev.filter((w: any) => w.id !== wf.id));
    } catch (e: any) {
      alert(`删除失败: ${e.message || e}`);
    }
  };

  const load = async () => {
    setLoading(true);
    setMsg(null);
    try {
      const res = await apiService.getConfig();
      const loadedConfig = res.config || {};
      setForm(loadedConfig);
      setEnvFile(res.env_file || '');
      setChecks(res.checks || {});
      try {
        localStorage.setItem('minimax_studio_config_backup', JSON.stringify(loadedConfig));
      } catch (err) {}
    } catch (e: any) {
      try {
        const cached = localStorage.getItem('minimax_studio_config_backup');
        if (cached) {
          setForm(JSON.parse(cached));
          setMsg({ type: 'error', text: '后端连接异常，已自动从浏览器本地缓存恢复配置' });
        } else {
          setMsg({ type: 'error', text: e?.message || '加载配置失败' });
        }
      } catch (err) {
        setMsg({ type: 'error', text: e?.message || '加载配置失败' });
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (tab === 'image') {
      loadWorkflowsList();
    }
  }, [tab]);

  const setField = (k: string, v: string) => {
    setForm((prev) => ({ ...prev, [k]: v }));
    setMsg(null);
  };

  const toggleShowKey = (k: string) => {
    setShowKeys((prev) => ({ ...prev, [k]: !prev[k] }));
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setMsg({ type: 'success', text: '已复制到剪贴板' });
  };

  const handlePickFolder = async (fieldKey: string, title: string = '请选择文件夹') => {
    try {
      const currentVal = form[fieldKey] || '';
      const res = await apiService.browseFolder({ initialDir: currentVal, title });
      if (res && res.selected_path) {
        setField(fieldKey, res.selected_path);
        setMsg({ type: 'success', text: `已成功选择目录: ${res.selected_path}` });
      }
    } catch (e: any) {
      setMsg({ type: 'error', text: e?.message || '打开系统文件夹选择器失败' });
    }
  };

  const handleOpenFolder = async (fieldKey: string) => {
    const path = form[fieldKey] || '';
    if (!path) {
      setMsg({ type: 'error', text: '请先配置有效的文件夹路径' });
      return;
    }
    try {
      await apiService.openFolder(path);
    } catch (e: any) {
      setMsg({ type: 'error', text: e?.message || '打开目录失败' });
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const payload: any = { ...form };
      const res = await apiService.saveConfig(payload);
      try {
        localStorage.setItem('minimax_studio_config_backup', JSON.stringify(payload));
      } catch (err) {}
      const targetPath = res.env_file || envFile || '.env';
      setMsg({ type: 'success', text: `配置已成功持久化至 ${targetPath} 并即时热重载生效！` });
      await load();
    } catch (e: any) {
      setMsg({ type: 'error', text: e?.message || '保存配置失败' });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (target: 'openai' | 'responses_api' | 'deepseek' | 'qwen' | 'minimax' | 'comfyui' | 'siliconflow' | 'dashscope' | 'elevenlabs' | 'cosyvoice' | 'gptsovits' | 'jianyin' | 'openai_compat') => {
    setTesting(target);
    setTestResult((p) => ({ ...p, [target]: null }));
    try {
      const res = await apiService.testConfig(target, form);
      setTestResult((p) => ({ ...p, [target]: { ok: res.ok, detail: res.detail } }));
    } catch (e: any) {
      setTestResult((p) => ({ ...p, [target]: { ok: false, detail: e?.message || '测试失败' } }));
    } finally {
      setTesting(null);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm bg-background">
        <Loader2 className="w-5 h-5 animate-spin mr-2 text-brand-light" />
        <span>正在读取系统配置...</span>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-background">
      {/* Top Header Breadcrumb */}
      <div className="h-12 bg-surface border-b border-border px-6 flex items-center justify-between shrink-0">
        <div className="flex items-center space-x-3">
          <button
            onClick={() => setActiveTab('studio')}
            className="flex items-center space-x-1.5 px-3 py-1 rounded-lg bg-surface-secondary hover:bg-surface-tertiary text-xs text-gray-300 hover:text-white border border-border transition-all"
            title="返回漫剧工作台"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>返回漫剧工作台</span>
          </button>
          <span className="text-gray-600">/</span>
          <div className="flex items-center space-x-2">
            <div className="p-1 rounded bg-brand/20 border border-brand/40 text-brand-light">
              <Settings className="w-3.5 h-3.5" />
            </div>
            <span className="text-xs font-bold text-white">模型与引擎配置中心</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-surface-tertiary text-gray-400 font-mono">
              Universal AI Studio Settings
            </span>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          <button
            onClick={load}
            className="flex items-center space-x-1.5 text-xs text-gray-400 hover:text-white px-2.5 py-1 rounded-lg hover:bg-surface-secondary transition-all"
            title="重新读取 .env 文件"
          >
            <RefreshCw className="w-3 h-3" />
            <span>重载</span>
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center space-x-1.5 px-4 py-1.5 rounded-xl bg-gradient-to-r from-brand to-brand-blue hover:opacity-90 text-white text-xs font-bold shadow-md shadow-brand/25 disabled:opacity-40 transition-all"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            <span>{saving ? '保存中...' : '保存全部配置'}</span>
          </button>
        </div>
      </div>

      {/* Main Split Layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar Navigation */}
        <div className="w-64 bg-surface border-r border-border flex flex-col shrink-0">
          <div className="p-3 space-y-1.5 flex-1 overflow-y-auto custom-scrollbar">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`w-full flex items-start space-x-3 p-2.5 rounded-xl border text-left transition-all ${
                  tab === t.key
                    ? 'bg-brand/15 border-brand text-white shadow-sm ring-1 ring-brand/30'
                    : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-surface-secondary'
                }`}
              >
                <div className={`p-1.5 rounded-lg mt-0.5 ${
                  tab === t.key ? 'bg-brand text-white' : 'bg-surface-secondary text-gray-400'
                }`}>
                  {t.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold truncate text-white">{t.label}</span>
                    {t.badge && (
                      <span className="text-[9px] px-1 py-0.2 rounded bg-accent-orange/20 text-accent-orange border border-accent-orange/30 font-medium">
                        {t.badge}
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] text-gray-500 truncate mt-0.5">{t.sub}</p>
                </div>
              </button>
            ))}
          </div>

          <div className="p-3 border-t border-border bg-surface-secondary/30">
            <div className="text-[10px] text-gray-400 font-medium flex items-center space-x-1 mb-1">
              <Sparkles className="w-3 h-3 text-accent-orange" />
              <span>配置文件热重载</span>
            </div>
            <div className="text-[9px] text-gray-500 font-mono truncate" title={envFile}>
              {envFile || 'server/.env'}
            </div>
          </div>
        </div>

        {/* Right Content Area */}
        <div className="flex-1 flex flex-col overflow-hidden bg-[#07070A]">
          <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar max-w-4xl">
            {/* Global Notice Alert */}
            {msg && (
              <div className={`px-4 py-3 rounded-2xl border text-xs flex items-center justify-between animate-fade-in ${
                msg.type === 'success'
                  ? 'bg-accent-green/10 border-accent-green/30 text-accent-green'
                  : 'bg-red-500/10 border-red-500/30 text-red-300'
              }`}>
                <div className="flex items-center space-x-2">
                  {msg.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
                  <span>{msg.text}</span>
                </div>
                <button onClick={() => setMsg(null)} className="text-xs px-2 py-0.5 rounded hover:bg-white/10">✕</button>
              </div>
            )}

            {/* TAB 1: 大模型与剧本引擎 (LLM) */}
            {tab === 'llm' && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-sm font-bold text-white flex items-center space-x-2">
                    <Bot className="w-4 h-4 text-brand-light" />
                    <span>剧本拆解与导演 Agent 大模型引擎 (LLM Provider)</span>
                  </h2>
                  <p className="text-xs text-gray-400 mt-1">
                    系统支持任意 OpenAI 兼容接口、全新 OpenAI Responses API、DeepSeek、通义千问、硅基流动与本地 Ollama。
                  </p>
                </div>

                {/* Preset Fast Selector */}
                <div className="bg-surface rounded-2xl border border-border p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold text-gray-200">
                      选择预置大模型方案（点击一键填入常用配置）
                    </label>
                    <span className="text-[10px] text-brand-light font-mono">
                      当前提供商: {form.LLM_PROVIDER || 'openai_compatible'}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
                    {[
                      {
                        id: 'deepseek',
                        name: 'DeepSeek 官方',
                        desc: 'deepseek-chat / reasoner',
                        action: () => {
                          setField('LLM_PROVIDER', 'deepseek');
                          setField('LLM_API_TYPE', 'chat_completions');
                          setField('OPENAI_BASE_URL', 'https://api.deepseek.com/v1');
                          setField('OPENAI_MODEL', 'deepseek-chat');
                        }
                      },
                      {
                        id: 'openai_standard',
                        name: 'OpenAI 官方 (Chat)',
                        desc: 'gpt-4o / gpt-4o-mini',
                        action: () => {
                          setField('LLM_PROVIDER', 'openai_compatible');
                          setField('LLM_API_TYPE', 'chat_completions');
                          setField('OPENAI_BASE_URL', 'https://api.openai.com/v1');
                          setField('OPENAI_MODEL', 'gpt-4o');
                        }
                      },
                      {
                        id: 'responses_api',
                        name: 'OpenAI Responses API',
                        desc: '/v1/responses 现代接口',
                        action: () => {
                          setField('LLM_PROVIDER', 'responses_api');
                          setField('LLM_API_TYPE', 'responses_api');
                          setField('RESPONSES_API_URL', 'https://api.openai.com/v1/responses');
                          setField('RESPONSES_MODEL', 'gpt-4o');
                        }
                      },
                      {
                        id: 'qwen',
                        name: '阿里百炼通义千问',
                        desc: 'qwen-plus / qwen-max',
                        action: () => {
                          setField('LLM_PROVIDER', 'qwen');
                          setField('LLM_API_TYPE', 'chat_completions');
                          setField('OPENAI_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1');
                          setField('OPENAI_MODEL', 'qwen-plus');
                        }
                      },
                      {
                        id: 'siliconflow',
                        name: '硅基流动 (SiliconFlow)',
                        desc: 'DeepSeek-V3 / Qwen 托管',
                        action: () => {
                          setField('LLM_PROVIDER', 'siliconflow');
                          setField('LLM_API_TYPE', 'chat_completions');
                          setField('OPENAI_BASE_URL', 'https://api.siliconflow.cn/v1');
                          setField('OPENAI_MODEL', 'deepseek-ai/DeepSeek-V3');
                        }
                      },
                      {
                        id: 'ollama',
                        name: '本地 Ollama / LMStudio',
                        desc: 'http://localhost:11434/v1',
                        action: () => {
                          setField('LLM_PROVIDER', 'openai_compatible');
                          setField('LLM_API_TYPE', 'chat_completions');
                          setField('OPENAI_BASE_URL', 'http://localhost:11434/v1');
                          setField('OPENAI_MODEL', 'qwen2.5:14b');
                        }
                      },
                      {
                        id: 'minimax',
                        name: 'MiniMax 官方接口',
                        desc: 'abab6.5s-chat 专有接口',
                        action: () => {
                          setField('LLM_PROVIDER', 'minimax');
                          setField('LLM_MODEL', 'abab6.5s-chat');
                        }
                      },
                      {
                        id: 'custom',
                        name: '自定义 OpenAI 端点',
                        desc: 'OneAPI / NewAPI / 代理',
                        action: () => {
                          setField('LLM_PROVIDER', 'openai_compatible');
                          setField('LLM_API_TYPE', 'chat_completions');
                        }
                      },
                    ].map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={item.action}
                        className={`p-3 rounded-xl border text-left transition-all ${
                          (form.LLM_PROVIDER === item.id || (item.id === 'openai_standard' && form.LLM_PROVIDER === 'openai_compatible' && form.LLM_API_TYPE !== 'responses_api'))
                            ? 'bg-brand/20 border-brand ring-1 ring-brand text-white shadow-sm'
                            : 'bg-surface-secondary border-border text-gray-400 hover:border-border-active'
                        }`}
                      >
                        <div className="text-xs font-bold text-white truncate">{item.name}</div>
                        <div className="text-[10px] text-gray-500 truncate mt-1">{item.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Section A: Standard OpenAI-Compatible & Custom Gateway */}
                <div className="bg-surface rounded-2xl border border-border p-5 space-y-4">
                  <div className="flex items-center justify-between border-b border-border pb-3">
                    <div className="flex items-center space-x-2">
                      <span className="w-2 h-2 rounded-full bg-accent-green" />
                      <span className="text-xs font-bold text-white">OpenAI / DeepSeek / 通义千问 / 硅基流动 标准接口</span>
                    </div>
                    <span className="text-[10px] text-gray-400 font-mono">/v1/chat/completions</span>
                  </div>

                  <div>
                    <label className="text-xs font-medium text-gray-300 flex items-center justify-between">
                      <span>OPENAI_API_KEY (大模型 API 密钥) <span className="text-accent-green">*</span></span>
                    </label>
                    <div className="mt-1.5 flex items-center space-x-2">
                      <div className="flex-1 relative">
                        <input
                          type={showKeys['OPENAI_API_KEY'] ? 'text' : 'password'}
                          value={form.OPENAI_API_KEY || ''}
                          onChange={(e) => setField('OPENAI_API_KEY', e.target.value)}
                          placeholder="sk-..."
                          className="w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 pr-9 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand"
                        />
                        <button
                          type="button"
                          onClick={() => toggleShowKey('OPENAI_API_KEY')}
                          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-gray-400 hover:text-white"
                        >
                          {showKeys['OPENAI_API_KEY'] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(form.OPENAI_API_KEY || '')}
                        className="p-2 rounded-xl bg-surface-tertiary border border-border text-gray-400 hover:text-white"
                        title="复制"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs font-medium text-gray-300">OPENAI_BASE_URL (API 基础地址)</label>
                      <input
                        value={form.OPENAI_BASE_URL || ''}
                        onChange={(e) => setField('OPENAI_BASE_URL', e.target.value)}
                        placeholder="https://api.deepseek.com/v1"
                        className="mt-1.5 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-300">OPENAI_MODEL (模型名称)</label>
                      <input
                        value={form.OPENAI_MODEL || ''}
                        onChange={(e) => setField('OPENAI_MODEL', e.target.value)}
                        placeholder="deepseek-chat"
                        className="mt-1.5 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand"
                      />
                    </div>
                  </div>

                  <div className="flex items-center space-x-3 pt-2">
                    <button
                      type="button"
                      onClick={() => handleTest('openai')}
                      disabled={!!testing}
                      className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-xl bg-surface-tertiary border border-border hover:border-brand text-xs text-white disabled:opacity-40"
                    >
                      {testing === 'openai' ? <Loader2 className="w-3.5 h-3.5 animate-spin text-brand" /> : <TestTube2 className="w-3.5 h-3.5 text-accent-green" />}
                      <span>测试 OpenAI 兼容接口连通性</span>
                    </button>
                    {testResult.openai && (
                      <span className={`text-xs flex items-center space-x-1.5 ${testResult.openai.ok ? 'text-accent-green' : 'text-red-400'}`}>
                        {testResult.openai.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
                        <span>{testResult.openai.detail}</span>
                      </span>
                    )}
                  </div>
                </div>

                {/* Section B: OpenAI Responses API Mode */}
                <div className="bg-surface rounded-2xl border border-border p-5 space-y-4">
                  <div className="flex items-center justify-between border-b border-border pb-3">
                    <div className="flex items-center space-x-2">
                      <span className="w-2 h-2 rounded-full bg-brand-light" />
                      <span className="text-xs font-bold text-white">OpenAI 现代 Responses API 支持 (/v1/responses)</span>
                    </div>
                    <span className="text-[10px] text-brand-light bg-brand/10 border border-brand/20 px-2 py-0.5 rounded-full font-mono">
                      New Responses API
                    </span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs font-medium text-gray-300">RESPONSES_API_URL (Responses API 端点)</label>
                      <input
                        value={form.RESPONSES_API_URL || ''}
                        onChange={(e) => setField('RESPONSES_API_URL', e.target.value)}
                        placeholder="https://api.openai.com/v1/responses"
                        className="mt-1.5 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-300">RESPONSES_MODEL (Responses 目标模型)</label>
                      <input
                        value={form.RESPONSES_MODEL || ''}
                        onChange={(e) => setField('RESPONSES_MODEL', e.target.value)}
                        placeholder="gpt-4o"
                        className="mt-1.5 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-medium text-gray-300 flex items-center justify-between">
                      <span>RESPONSES_API_KEY (专属密钥，留空则自动复用上方 OPENAI_API_KEY)</span>
                    </label>
                    <div className="mt-1.5 relative">
                      <input
                        type={showKeys['RESPONSES_API_KEY'] ? 'text' : 'password'}
                        value={form.RESPONSES_API_KEY || ''}
                        onChange={(e) => setField('RESPONSES_API_KEY', e.target.value)}
                        placeholder="留空自动使用 OPENAI_API_KEY"
                        className="w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 pr-9 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand"
                      />
                      <button
                        type="button"
                        onClick={() => toggleShowKey('RESPONSES_API_KEY')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-gray-400 hover:text-white"
                      >
                        {showKeys['RESPONSES_API_KEY'] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center space-x-3 pt-2">
                    <button
                      type="button"
                      onClick={() => handleTest('responses_api')}
                      disabled={!!testing}
                      className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-xl bg-surface-tertiary border border-border hover:border-brand text-xs text-white disabled:opacity-40"
                    >
                      {testing === 'responses_api' ? <Loader2 className="w-3.5 h-3.5 animate-spin text-brand" /> : <TestTube2 className="w-3.5 h-3.5 text-brand-light" />}
                      <span>测试 Responses API 连通性</span>
                    </button>
                    {testResult.responses_api && (
                      <span className={`text-xs flex items-center space-x-1.5 ${testResult.responses_api.ok ? 'text-accent-green' : 'text-red-400'}`}>
                        {testResult.responses_api.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
                        <span>{testResult.responses_api.detail}</span>
                      </span>
                    )}
                  </div>
                </div>

                {/* Section C: MiniMax API (Optional Reference) */}
                <div className="bg-surface rounded-2xl border border-border p-5 space-y-4">
                  <div className="flex items-center justify-between border-b border-border pb-3">
                    <div className="flex items-center space-x-2">
                      <span className="w-2 h-2 rounded-full bg-accent-pink" />
                      <span className="text-xs font-bold text-white">MiniMax API 接口 (可选厂商)</span>
                    </div>
                    <span className="text-[10px] text-gray-500">仅在提供商选为 MiniMax 时生效</span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs font-medium text-gray-300">MINIMAX_API_KEY</label>
                      <div className="mt-1.5 relative">
                        <input
                          type={showKeys['MINIMAX_API_KEY'] ? 'text' : 'password'}
                          value={form.MINIMAX_API_KEY || ''}
                          onChange={(e) => setField('MINIMAX_API_KEY', e.target.value)}
                          placeholder="sk-..."
                          className="w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 pr-9 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand"
                        />
                        <button
                          type="button"
                          onClick={() => toggleShowKey('MINIMAX_API_KEY')}
                          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-gray-400 hover:text-white"
                        >
                          {showKeys['MINIMAX_API_KEY'] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-300">LLM_MODEL (MiniMax 剧本模型)</label>
                      <input
                        value={form.LLM_MODEL || ''}
                        onChange={(e) => setField('LLM_MODEL', e.target.value)}
                        placeholder="abab6.5s-chat"
                        className="mt-1.5 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand"
                      />
                    </div>
                  </div>

                  <div className="flex items-center space-x-3 pt-2">
                    <button
                      type="button"
                      onClick={() => handleTest('minimax')}
                      disabled={!!testing}
                      className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-xl bg-surface-tertiary border border-border hover:border-brand text-xs text-white disabled:opacity-40"
                    >
                      {testing === 'minimax' ? <Loader2 className="w-3.5 h-3.5 animate-spin text-brand" /> : <TestTube2 className="w-3.5 h-3.5 text-accent-pink" />}
                      <span>测试 MiniMax 连通性</span>
                    </button>
                    {testResult.minimax && (
                      <span className={`text-xs flex items-center space-x-1.5 ${testResult.minimax.ok ? 'text-accent-green' : 'text-red-400'}`}>
                        {testResult.minimax.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
                        <span>{testResult.minimax.detail}</span>
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* TAB 2: 分镜生图引擎 (Image) */}
            {tab === 'image' && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-sm font-bold text-white flex items-center space-x-2">
                    <Cpu className="w-4 h-4 text-accent-green" />
                    <span>分镜与角色画面生成引擎 (Image Generation) - 动态Provider</span>
                  </h2>
                  <p className="text-xs text-gray-400 mt-1">
                    支持动态切换：ComfyUI(工作流导入) / 硅基流动 / 阿里万相 / OpenAI兼容。所有Provider已对导演Agent全量暴露。
                  </p>
                </div>

                {/* 全局 Provider 选择器 */}
                <div className="bg-surface rounded-2xl border border-border p-5 space-y-4">
                  <div className="flex items-center justify-between border-b border-border pb-3">
                    <div className="flex items-center space-x-2">
                      <span className="w-2 h-2 rounded-full bg-brand" />
                      <span className="text-xs font-bold text-white">默认生图 Provider（全局 / 可按镜头覆盖）</span>
                    </div>
                    <span className="text-[10px] text-gray-500">导演Agent可动态指定 provider 参数覆盖</span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs font-medium text-gray-300">IMAGE_PROVIDER (默认生图通道)</label>
                      <select
                        value={form.IMAGE_PROVIDER || 'comfyui'}
                        onChange={(e) => setField('IMAGE_PROVIDER', e.target.value)}
                        className="mt-1.5 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-brand"
                      >
                        <option value="comfyui">ComfyUI (本地/云端 + 工作流)</option>
                        <option value="siliconflow">硅基流动 SiliconFlow (FLUX)</option>
                        <option value="dashscope">阿里通义万相 DashScope</option>
                        <option value="openai_compat">OpenAI兼容 (DALL·E/代理)</option>
                      </select>
                    </div>
                    <div className="flex items-end">
                      <div className="text-[10px] text-gray-500 leading-4">
                        <div>• 选择后全链路与Agent默认走此通道</div>
                        <div>• 单镜可通过 <code className="px-1 py-0.5 rounded bg-surface-tertiary text-brand-light">provider</code> 参数覆盖</div>
                        <div>• 工作流仅适用于 comfyui</div>
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <label className="text-xs font-medium text-gray-300">SILICONFLOW_IMAGE_MODEL</label>
                      <input value={form.SILICONFLOW_IMAGE_MODEL || ''} onChange={(e) => setField('SILICONFLOW_IMAGE_MODEL', e.target.value)} placeholder="black-forest-labs/FLUX.1-schnell" className="mt-1.5 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-300">DASHSCOPE_IMAGE_MODEL</label>
                      <input value={form.DASHSCOPE_IMAGE_MODEL || ''} onChange={(e) => setField('DASHSCOPE_IMAGE_MODEL', e.target.value)} placeholder="wanx2.1-t2i-turbo" className="mt-1.5 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-300">OPENAI_IMAGE_MODEL / BASE_URL</label>
                      <input value={form.OPENAI_IMAGE_MODEL || ''} onChange={(e) => setField('OPENAI_IMAGE_MODEL', e.target.value)} placeholder="dall-e-3" className="mt-1.5 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand" />
                      <input value={form.OPENAI_IMAGE_BASE_URL || ''} onChange={(e) => setField('OPENAI_IMAGE_BASE_URL', e.target.value)} placeholder="可选: https://.../v1" className="mt-2 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand" />
                    </div>
                  </div>
                  <div className="flex items-center space-x-3 pt-2">
                    <button type="button" onClick={() => handleTest('dashscope')} disabled={!!testing} className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-surface-tertiary border border-border hover:border-brand text-xs text-white disabled:opacity-40">
                      {testing === 'dashscope' ? <Loader2 className="w-3.5 h-3.5 animate-spin text-brand" /> : <TestTube2 className="w-3.5 h-3.5 text-accent-green" />}<span>测试 DashScope</span>
                    </button>
                    {testResult.dashscope && (<span className={`text-xs flex items-center space-x-1.5 ${testResult.dashscope.ok ? 'text-accent-green' : 'text-red-400'}`}>{testResult.dashscope.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}<span>{testResult.dashscope.detail}</span></span>)}
                    <button type="button" onClick={() => handleTest('openai_compat' as any)} disabled={!!testing} className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-surface-tertiary border border-border hover:border-brand text-xs text-white disabled:opacity-40">
                      <TestTube2 className="w-3.5 h-3.5 text-accent-green" /><span>测试 OpenAI兼容</span>
                    </button>
                  </div>
                </div>

                {/* ComfyUI Settings */}
                <div className="bg-surface rounded-2xl border border-border p-5 space-y-4">
                  <div className="flex items-center justify-between border-b border-border pb-3">
                    <div className="flex items-center space-x-2">
                      <span className="w-2 h-2 rounded-full bg-accent-green" />
                      <span className="text-xs font-bold text-white">ComfyUI 本地 / 局域网 / 云端服务</span>
                    </div>
                    <span className="text-[10px] text-gray-500">支持 SDXL / Flux / ControlNet 工作流</span>
                  </div>

                  <div>
                    <label className="text-xs font-medium text-gray-300">COMFYUI_SERVER_URL (ComfyUI 服务地址)</label>
                    <div className="mt-1.5 flex items-center space-x-2">
                      <input
                        value={form.COMFYUI_SERVER_URL || ''}
                        onChange={(e) => setField('COMFYUI_SERVER_URL', e.target.value)}
                        placeholder="http://127.0.0.1:8188"
                        className="flex-1 bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand"
                      />
                      <button
                        type="button"
                        onClick={() => setField('COMFYUI_SERVER_URL', 'http://127.0.0.1:8188')}
                        className="px-3 py-2 rounded-xl bg-surface-tertiary border border-border text-xs text-gray-300 hover:text-white"
                      >
                        默认本机
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs font-medium text-gray-300">COMFYUI_CHECKPOINT (首选底模名称)</label>
                      <input
                        value={form.COMFYUI_CHECKPOINT || ''}
                        onChange={(e) => setField('COMFYUI_CHECKPOINT', e.target.value)}
                        placeholder="留空自动选择 models/checkpoints 第一个模型"
                        className="mt-1.5 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-300">COMFYUI_TIMEOUT_SECONDS (单图超时秒数)</label>
                      <input
                        type="number"
                        value={form.COMFYUI_TIMEOUT_SECONDS || '240'}
                        onChange={(e) => setField('COMFYUI_TIMEOUT_SECONDS', e.target.value)}
                        placeholder="240"
                        className="mt-1.5 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-brand"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
                    <div>
                      <label className="text-xs font-medium text-gray-300 flex items-center justify-between">
                        <span>COMFYUI_DEFAULT_IMAGE_WORKFLOW (默认生图工作流)</span>
                        {form.COMFYUI_DEFAULT_IMAGE_WORKFLOW && (
                          <button
                            type="button"
                            onClick={() => setField('COMFYUI_DEFAULT_IMAGE_WORKFLOW', '')}
                            className="text-[10px] text-gray-500 hover:text-red-400"
                          >
                            清除默认
                          </button>
                        )}
                      </label>
                      <select
                        value={form.COMFYUI_DEFAULT_IMAGE_WORKFLOW || ''}
                        onChange={(e) => setField('COMFYUI_DEFAULT_IMAGE_WORKFLOW', e.target.value)}
                        className="mt-1.5 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-brand"
                      >
                        <option value="">-- 系统内置默认 SDXL 工作流 --</option>
                        {workflowList.map((wf: any) => (
                          <option key={wf.id} value={wf.id}>
                            {wf.name || wf.id} ({wf.source === 'internal' ? '内部' : '外部'})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="text-xs font-medium text-gray-300 flex items-center justify-between">
                        <span>COMFYUI_DEFAULT_VIDEO_WORKFLOW (默认生视频工作流)</span>
                        {form.COMFYUI_DEFAULT_VIDEO_WORKFLOW && (
                          <button
                            type="button"
                            onClick={() => setField('COMFYUI_DEFAULT_VIDEO_WORKFLOW', '')}
                            className="text-[10px] text-gray-500 hover:text-red-400"
                          >
                            清除默认
                          </button>
                        )}
                      </label>
                      <select
                        value={form.COMFYUI_DEFAULT_VIDEO_WORKFLOW || ''}
                        onChange={(e) => setField('COMFYUI_DEFAULT_VIDEO_WORKFLOW', e.target.value)}
                        className="mt-1.5 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-brand"
                      >
                        <option value="">-- 动态图生视频 Mock / 自动探测 --</option>
                        {workflowList.map((wf: any) => (
                          <option key={wf.id} value={wf.id}>
                            {wf.name || wf.id} ({wf.source === 'internal' ? '内部' : '外部'})
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="flex items-center space-x-3 pt-2">
                    <button
                      type="button"
                      onClick={() => handleTest('comfyui')}
                      disabled={!!testing}
                      className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-xl bg-surface-tertiary border border-border hover:border-brand text-xs text-white disabled:opacity-40"
                    >
                      {testing === 'comfyui' ? <Loader2 className="w-3.5 h-3.5 animate-spin text-brand" /> : <TestTube2 className="w-3.5 h-3.5 text-accent-green" />}
                      <span>测试 ComfyUI 连通性</span>
                    </button>
                    {testResult.comfyui && (
                      <span className={`text-xs flex items-center space-x-1.5 ${testResult.comfyui.ok ? 'text-accent-green' : 'text-red-400'}`}>
                        {testResult.comfyui.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
                        <span>{testResult.comfyui.detail}</span>
                      </span>
                    )}
                  </div>
                </div>

                {/* ComfyUI Workflows Direct Directory */}
                <div className="bg-surface rounded-2xl border border-border p-5 space-y-4">
                  <div className="flex items-center justify-between border-b border-border pb-3">
                    <div className="flex items-center space-x-2">
                      <span className="w-2 h-2 rounded-full bg-brand" />
                      <span className="text-xs font-bold text-white">ComfyUI 工作流目录直读（无需手动导入）</span>
                    </div>
                    <span className="text-[10px] text-gray-500">指定后自动扫描全部 *.json，一键可用</span>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-300">COMFYUI_WORKFLOWS_DIR (ComfyUI 工作流文件夹路径)</label>
                    <div className="mt-1.5 flex items-center space-x-2">
                      <input
                        value={form.COMFYUI_WORKFLOWS_DIR || ''}
                        onChange={(e) => setField('COMFYUI_WORKFLOWS_DIR', e.target.value)}
                        placeholder="例如: D:/ComfyUI/workflows 或 D:/ComfyUI/user/default/workflows"
                        className="flex-1 bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand"
                      />
                      <button
                        type="button"
                        onClick={() => handlePickFolder('COMFYUI_WORKFLOWS_DIR', '请选择 ComfyUI 工作流文件夹')}
                        className="flex items-center space-x-1 px-3 py-2 rounded-xl bg-brand/20 hover:bg-brand/30 border border-brand/40 text-xs font-semibold text-brand-light hover:text-white transition-all shadow-sm"
                        title="打开系统文件夹选择对话框"
                      >
                        <FolderSearch className="w-3.5 h-3.5" />
                        <span>选择文件夹</span>
                      </button>
                      {form.COMFYUI_WORKFLOWS_DIR && (
                        <button
                          type="button"
                          onClick={() => handleOpenFolder('COMFYUI_WORKFLOWS_DIR')}
                          className="flex items-center space-x-1 px-2.5 py-2 rounded-xl bg-surface-tertiary hover:bg-surface-secondary border border-border text-xs text-gray-300 hover:text-white transition-all"
                          title="在操作系统资源管理器中打开此文件夹"
                        >
                          <FolderOpen className="w-3.5 h-3.5" />
                          <span>打开</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          const v = form.COMFYUI_WORKFLOWS_DIR || '';
                          if (!v) setMsg({type:'error', text:'请先填入或选择路径后再保存'});
                          else handleTest('comfyui');
                        }}
                        className="px-3 py-2 rounded-xl bg-surface-tertiary border border-border text-xs text-gray-300 hover:text-white"
                      >
                        检测
                      </button>
                    </div>
                    <p className="text-[10px] text-gray-500 mt-2 leading-4">
                      • 填入后保存，系统将递归扫描该目录下所有 <code className="px-1 py-0.5 rounded bg-surface-tertiary text-brand-light">*.json</code> 工作流<br/>
                      • 仅 <span className="text-accent-green">API Format</span> 可直接执行，Save Format 会提示需在ComfyUI中 Export API Format<br/>
                      • 外部工作流 id 以 <code className="px-1 py-0.5 rounded bg-surface-tertiary text-brand-light">ext_xxx</code> 开头，可直接在生图时指定 <code className="px-1 py-0.5 rounded bg-surface-tertiary text-brand-light">workflow_id</code> 使用，无需导入；如需编辑映射可一键导入为内部工作流
                    </p>
                  </div>
                  <div className="flex items-center space-x-3">
                    <span className="text-[10px] text-gray-500">当前已配置: {form.COMFYUI_WORKFLOWS_DIR ? <span className="text-accent-green font-mono">{form.COMFYUI_WORKFLOWS_DIR}</span> : <span className="text-gray-600">未配置（仅显示内部工作流）</span>}</span>
                  </div>
                </div>

                {/* ComfyUI Workflows List & Parameter Inspector */}
                <div className="bg-surface rounded-2xl border border-border p-5 space-y-4">
                  <div className="flex items-center justify-between border-b border-border pb-3">
                    <div className="flex items-center space-x-2">
                      <span className="w-2 h-2 rounded-full bg-accent-blue" />
                      <span className="text-xs font-bold text-white">ComfyUI 工作流列表与节点参数深度配置 (Node & Parameter Studio)</span>
                    </div>
                    <button
                      type="button"
                      onClick={loadWorkflowsList}
                      disabled={loadingWfs}
                      className="text-[11px] text-gray-400 hover:text-white flex items-center space-x-1"
                    >
                      <RefreshCw className={`w-3 h-3 ${loadingWfs ? 'animate-spin' : ''}`} />
                      <span>刷新工作流</span>
                    </button>
                  </div>

                  {loadingWfs ? (
                    <div className="py-8 text-center text-xs text-gray-500 flex items-center justify-center space-x-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>正在扫描并解析工作流列表...</span>
                    </div>
                  ) : workflowList.length === 0 ? (
                    <div className="py-6 text-center text-xs text-gray-500">
                      暂无可用工作流，请配置上方的 COMFYUI_WORKFLOWS_DIR 路径或导入工作流。
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {workflowList.map((wf: any) => {
                        const isDefaultImg = form.COMFYUI_DEFAULT_IMAGE_WORKFLOW === wf.id;
                        const isDefaultVid = form.COMFYUI_DEFAULT_VIDEO_WORKFLOW === wf.id;
                        return (
                          <div
                            key={wf.id}
                            className={`bg-surface-secondary border rounded-xl p-3.5 flex flex-col justify-between transition-all space-y-2.5 ${
                              isDefaultImg || isDefaultVid ? 'border-brand/60 ring-1 ring-brand/30 bg-surface-secondary/90' : 'border-border hover:border-brand/40'
                            }`}
                          >
                            <div>
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-semibold text-white truncate max-w-[180px]" title={wf.name || wf.id}>
                                  {wf.name || wf.id}
                                </span>
                                <div className="flex items-center gap-1.5">
                                  {isDefaultImg && (
                                    <span className="text-[9px] px-1.5 py-0.5 rounded font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40">
                                      ⭐️ 默认生图
                                    </span>
                                  )}
                                  {isDefaultVid && (
                                    <span className="text-[9px] px-1.5 py-0.5 rounded font-bold bg-purple-500/20 text-purple-300 border border-purple-500/40">
                                      🎬 默认生视频
                                    </span>
                                  )}
                                  <span className={`text-[9px] px-2 py-0.5 rounded-full font-mono border ${
                                    wf.source === 'internal'
                                      ? 'bg-accent-green/15 text-accent-green border-accent-green/30'
                                      : 'bg-accent-purple/15 text-accent-purple border-accent-purple/30'
                                  }`}>
                                    {wf.source === 'internal' ? '内部' : '外部直读'}
                                  </span>
                                </div>
                              </div>
                              <div className="text-[10px] text-gray-500 font-mono mt-1 truncate">
                                ID: {wf.id} {wf.node_count ? `· ${wf.node_count} 节点` : ''}
                              </div>
                              {wf.description && (
                                <p className="text-[11px] text-gray-400 mt-1 line-clamp-1">
                                  {wf.description}
                                </p>
                              )}
                            </div>

                            <div className="flex items-center justify-between pt-1 border-t border-border/50">
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => setField('COMFYUI_DEFAULT_IMAGE_WORKFLOW', isDefaultImg ? '' : wf.id)}
                                  className={`text-[10px] font-medium transition ${
                                    isDefaultImg ? 'text-amber-300 hover:text-red-400' : 'text-gray-400 hover:text-amber-300'
                                  }`}
                                  title={isDefaultImg ? '点击取消默认生图工作流' : '设为全局默认生图工作流'}
                                >
                                  {isDefaultImg ? '⭐️ 取消默认生图' : '⭐️ 设为默认生图'}
                                </button>
                                <span className="text-gray-600 text-[10px]">|</span>
                                <button
                                  type="button"
                                  onClick={() => setField('COMFYUI_DEFAULT_VIDEO_WORKFLOW', isDefaultVid ? '' : wf.id)}
                                  className={`text-[10px] font-medium transition ${
                                    isDefaultVid ? 'text-purple-300 hover:text-red-400' : 'text-gray-400 hover:text-purple-300'
                                  }`}
                                  title={isDefaultVid ? '点击取消默认生视频工作流' : '设为全局默认生视频工作流'}
                                >
                                  {isDefaultVid ? '🎬 取消默认生视频' : '🎬 设为默认生视频'}
                                </button>
                              </div>

                              <div className="flex items-center gap-1.5">
                                {wf.source === 'internal' && (
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteWorkflow(wf)}
                                    className="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-[11px] font-semibold text-rose-300 hover:text-rose-200 transition-all shadow-sm"
                                    title="删除此内部工作流"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                    <span>删除</span>
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => setInspectingWorkflowId(wf.id)}
                                  className="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg bg-brand/15 hover:bg-brand/25 border border-brand/30 text-[11px] font-semibold text-brand-light hover:text-white transition-all shadow-sm"
                                >
                                  <Sliders className="w-3 h-3" />
                                  <span>⚙️ 参数与暴露</span>
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Cloud Providers */}
                <div className="bg-surface rounded-2xl border border-border p-5 space-y-4">
                  <div className="flex items-center justify-between border-b border-border pb-3">
                    <div className="flex items-center space-x-2">
                      <span className="w-2 h-2 rounded-full bg-accent-orange" />
                      <span className="text-xs font-bold text-white">云端生图 (无需本地显卡)</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs font-medium text-gray-300">SILICONFLOW_API_KEY (硅基流动 Key)</label>
                      <div className="mt-1.5 relative">
                        <input
                          type={showKeys['SILICONFLOW_API_KEY'] ? 'text' : 'password'}
                          value={form.SILICONFLOW_API_KEY || ''}
                          onChange={(e) => setField('SILICONFLOW_API_KEY', e.target.value)}
                          placeholder="sk-..."
                          className="w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 pr-8 text-xs font-mono text-white focus:outline-none focus:border-brand"
                        />
                        <button
                          type="button"
                          onClick={() => toggleShowKey('SILICONFLOW_API_KEY')}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
                        >
                          {showKeys['SILICONFLOW_API_KEY'] ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                        </button>
                      </div>
                    </div>

                    <div>
                      <label className="text-xs font-medium text-gray-300">DASHSCOPE_API_KEY (阿里百炼万相 Key)</label>
                      <div className="mt-1.5 relative">
                        <input
                          type={showKeys['DASHSCOPE_API_KEY'] ? 'text' : 'password'}
                          value={form.DASHSCOPE_API_KEY || ''}
                          onChange={(e) => setField('DASHSCOPE_API_KEY', e.target.value)}
                          placeholder="sk-..."
                          className="w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 pr-8 text-xs font-mono text-white focus:outline-none focus:border-brand"
                        />
                        <button
                          type="button"
                          onClick={() => toggleShowKey('DASHSCOPE_API_KEY')}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
                        >
                          {showKeys['DASHSCOPE_API_KEY'] ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center space-x-3 pt-2">
                    <button
                      type="button"
                      onClick={() => handleTest('siliconflow')}
                      disabled={!!testing}
                      className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-xl bg-surface-tertiary border border-border hover:border-brand text-xs text-white disabled:opacity-40"
                    >
                      {testing === 'siliconflow' ? <Loader2 className="w-3.5 h-3.5 animate-spin text-brand" /> : <TestTube2 className="w-3.5 h-3.5 text-accent-green" />}
                      <span>测试硅基流动 API</span>
                    </button>
                    {testResult.siliconflow && (
                      <span className={`text-xs flex items-center space-x-1.5 ${testResult.siliconflow.ok ? 'text-accent-green' : 'text-red-400'}`}>
                        {testResult.siliconflow.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
                        <span>{testResult.siliconflow.detail}</span>
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* TAB 3: 配音与音色 (TTS) */}
            {tab === 'voice' && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-sm font-bold text-white flex items-center space-x-2">
                    <Mic className="w-4 h-4 text-accent-pink" />
                    <span>角色台词与旁白配音引擎 (Voice & TTS) - 动态Provider</span>
                  </h2>
                  <p className="text-xs text-gray-400 mt-1">
                    支持动态切换：MiniMax / ElevenLabs / CosyVoice / GPT-SoVITS，所有能力已对导演Agent全量暴露。
                  </p>
                </div>

                <div className="bg-surface rounded-2xl border border-border p-5 space-y-4">
                  <div className="flex items-center justify-between border-b border-border pb-3">
                    <div className="flex items-center space-x-2">
                      <span className="w-2 h-2 rounded-full bg-brand" />
                      <span className="text-xs font-bold text-white">默认配音 Provider（全局 / 可按台词覆盖）</span>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs font-medium text-gray-300">TTS_PROVIDER (默认配音通道)</label>
                      <select value={form.TTS_PROVIDER || 'minimax'} onChange={(e) => setField('TTS_PROVIDER', e.target.value)} className="mt-1.5 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-brand">
                        <option value="minimax">MiniMax Speech-01</option>
                        <option value="elevenlabs">ElevenLabs</option>
                        <option value="cosyvoice">CosyVoice (本地)</option>
                        <option value="gpt_sovits">GPT-SoVITS (本地)</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-300">ELEVENLABS_MODEL</label>
                      <input value={form.ELEVENLABS_MODEL || ''} onChange={(e) => setField('ELEVENLABS_MODEL', e.target.value)} placeholder="eleven_multilingual_v2" className="mt-1.5 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand" />
                    </div>
                  </div>
                  <div className="flex items-center space-x-3 pt-2">
                    <button type="button" onClick={() => handleTest('elevenlabs')} disabled={!!testing} className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-surface-tertiary border border-border hover:border-brand text-xs text-white disabled:opacity-40">
                      {testing === 'elevenlabs' ? <Loader2 className="w-3.5 h-3.5 animate-spin text-brand" /> : <TestTube2 className="w-3.5 h-3.5 text-accent-pink" />}<span>测试 ElevenLabs</span>
                    </button>
                    {testResult.elevenlabs && (<span className={`text-xs flex items-center space-x-1.5 ${testResult.elevenlabs.ok ? 'text-accent-green' : 'text-red-400'}`}>{testResult.elevenlabs.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}<span>{testResult.elevenlabs.detail}</span></span>)}
                    <button type="button" onClick={() => handleTest('cosyvoice')} disabled={!!testing} className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-surface-tertiary border border-border hover:border-brand text-xs text-white disabled:opacity-40">
                      <TestTube2 className="w-3.5 h-3.5 text-brand-light" /><span>测试 CosyVoice</span>
                    </button>
                    {testResult.cosyvoice && (<span className={`text-xs ${testResult.cosyvoice.ok ? 'text-accent-green' : 'text-red-400'}`}>{testResult.cosyvoice.detail}</span>)}
                    <button type="button" onClick={() => handleTest('gptsovits' as any)} disabled={!!testing} className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-surface-tertiary border border-border hover:border-brand text-xs text-white disabled:opacity-40">
                      <TestTube2 className="w-3.5 h-3.5 text-brand-light" /><span>测试 GPT-SoVITS</span>
                    </button>
                    {testResult.gptsovits && (<span className={`text-xs ${testResult.gptsovits.ok ? 'text-accent-green' : 'text-red-400'}`}>{testResult.gptsovits.detail}</span>)}
                  </div>
                </div>

                <div className="bg-surface rounded-2xl border border-border p-5 space-y-4">
                  <div className="flex items-center justify-between border-b border-border pb-3">
                    <div className="flex items-center space-x-2">
                      <span className="w-2 h-2 rounded-full bg-brand-blue" />
                      <span className="text-xs font-bold text-white">开源/本地自建配音 (CosyVoice / GPT-SoVITS) 详细地址</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs font-medium text-gray-300">COSYVOICE_URL (阿里 CosyVoice 接口地址)</label>
                      <input
                        value={form.COSYVOICE_URL || ''}
                        onChange={(e) => setField('COSYVOICE_URL', e.target.value)}
                        placeholder="http://127.0.0.1:9233"
                        className="mt-1.5 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-300">GPTSOVITS_URL (GPT-SoVITS 接口地址)</label>
                      <input
                        value={form.GPTSOVITS_URL || ''}
                        onChange={(e) => setField('GPTSOVITS_URL', e.target.value)}
                        placeholder="http://127.0.0.1:9880"
                        className="mt-1.5 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand"
                      />
                    </div>
                  </div>
                </div>

                <div className="bg-surface rounded-2xl border border-border p-5 space-y-4">
                  <div className="flex items-center justify-between border-b border-border pb-3">
                    <div className="flex items-center space-x-2">
                      <span className="w-2 h-2 rounded-full bg-accent-pink" />
                      <span className="text-xs font-bold text-white">云端超拟人配音 (MiniMax Speech-01 / ElevenLabs)</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs font-medium text-gray-300">TTS_MODEL (MiniMax 语音模型)</label>
                      <input
                        value={form.TTS_MODEL || ''}
                        onChange={(e) => setField('TTS_MODEL', e.target.value)}
                        placeholder="speech-01-turbo"
                        className="mt-1.5 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-300">ELEVENLABS_API_KEY (海外 ElevenLabs)</label>
                      <input
                        type="password"
                        value={form.ELEVENLABS_API_KEY || ''}
                        onChange={(e) => setField('ELEVENLABS_API_KEY', e.target.value)}
                        placeholder="可选"
                        className="mt-1.5 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand"
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 4: 视频模型 (Video) */}
            {tab === 'video' && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-sm font-bold text-white flex items-center space-x-2">
                    <Film className="w-4 h-4 text-brand-blue" />
                    <span>图生视频与运镜动效生成 (Video Generation)</span>
                  </h2>
                  <p className="text-xs text-gray-400 mt-1">
                    支持将分镜图像配合 3D 导演台运镜轨迹一键生成动态漫剧视频。
                  </p>
                </div>

                <div className="bg-surface rounded-2xl border border-border p-5 space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <label className="text-xs font-medium text-gray-300">VIDEO_MODEL (视频模型标识)</label>
                      <input
                        value={form.VIDEO_MODEL || ''}
                        onChange={(e) => setField('VIDEO_MODEL', e.target.value)}
                        placeholder="video-01"
                        className="mt-1.5 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-300">KLING_API_KEY (快手可灵 AI)</label>
                      <input
                        type="password"
                        value={form.KLING_API_KEY || ''}
                        onChange={(e) => setField('KLING_API_KEY', e.target.value)}
                        placeholder="可选"
                        className="mt-1.5 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-300">VIDU_API_KEY (生数科技 Vidu)</label>
                      <input
                        type="password"
                        value={form.VIDU_API_KEY || ''}
                        onChange={(e) => setField('VIDU_API_KEY', e.target.value)}
                        placeholder="可选"
                        className="mt-1.5 w-full bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand"
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 5: 剪映草稿与路径 (JianYing) */}
            {tab === 'jianyin' && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-sm font-bold text-white flex items-center space-x-2">
                    <FolderCheck className="w-4 h-4 text-accent-orange" />
                    <span>剪映 / CapCut 官方草稿箱无缝直连</span>
                  </h2>
                  <p className="text-xs text-gray-400 mt-1">
                    配置本地剪映草稿目录后，点击「导出剪映」将直接同步至剪映客户端草稿箱，打开剪映即可直接剪辑！
                  </p>
                </div>

                <div className="bg-surface rounded-2xl border border-border p-5 space-y-4">
                  <div>
                    <label className="text-xs font-medium text-gray-300 flex items-center justify-between">
                      <span>JIANYIN_DRAFT_PATH (剪映本地草稿目录)</span>
                      <span className="text-[10px] text-gray-500">Windows: AppData/Local/JianyingPro/...</span>
                    </label>
                    <div className="mt-1.5 flex items-center space-x-2">
                      <input
                        value={form.JIANYIN_DRAFT_PATH || ''}
                        onChange={(e) => setField('JIANYIN_DRAFT_PATH', e.target.value)}
                        placeholder="例如: C:/Users/Administrator/AppData/Local/JianyingPro/User Data/Projects/com.lveditor.draft"
                        className="flex-1 bg-surface-secondary border border-border rounded-xl px-3 py-2 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand"
                      />
                      <button
                        type="button"
                        onClick={() => handlePickFolder('JIANYIN_DRAFT_PATH', '请选择剪映草稿保存目录 (com.lveditor.draft)')}
                        className="flex items-center space-x-1 px-3 py-2 rounded-xl bg-accent-orange/20 hover:bg-accent-orange/30 border border-accent-orange/40 text-xs font-semibold text-accent-orange hover:text-white transition-all shadow-sm"
                        title="打开系统文件夹选择对话框"
                      >
                        <FolderSearch className="w-3.5 h-3.5" />
                        <span>选择文件夹</span>
                      </button>
                      {form.JIANYIN_DRAFT_PATH && (
                        <button
                          type="button"
                          onClick={() => handleOpenFolder('JIANYIN_DRAFT_PATH')}
                          className="flex items-center space-x-1 px-2.5 py-2 rounded-xl bg-surface-tertiary hover:bg-surface-secondary border border-border text-xs text-gray-300 hover:text-white transition-all"
                          title="在操作系统资源管理器中打开此文件夹"
                        >
                          <FolderOpen className="w-3.5 h-3.5" />
                          <span>打开</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          const user = 'Administrator';
                          setField('JIANYIN_DRAFT_PATH', `C:/Users/${user}/AppData/Local/JianyingPro/User Data/Projects/com.lveditor.draft`);
                        }}
                        className="px-2.5 py-2 rounded-xl bg-surface-tertiary border border-border text-xs text-gray-400 hover:text-white"
                        title="填入标准默认参考路径"
                      >
                        默认路径
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center space-x-3 pt-2">
                    <button
                      type="button"
                      onClick={() => handleTest('jianyin')}
                      disabled={!!testing}
                      className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-xl bg-surface-tertiary border border-border hover:border-brand text-xs text-white disabled:opacity-40"
                    >
                      {testing === 'jianyin' ? <Loader2 className="w-3.5 h-3.5 animate-spin text-brand" /> : <TestTube2 className="w-3.5 h-3.5 text-accent-orange" />}
                      <span>验证目录有效性</span>
                    </button>
                    {testResult.jianyin && (
                      <span className={`text-xs flex items-center space-x-1.5 ${testResult.jianyin.ok ? 'text-accent-green' : 'text-red-400'}`}>
                        {testResult.jianyin.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
                        <span>{testResult.jianyin.detail}</span>
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* TAB 6: 系统概览 (System) */}
            {tab === 'system' && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-sm font-bold text-white flex items-center space-x-2">
                    <Info className="w-4 h-4 text-brand-blue" />
                    <span>系统服务与环境状态</span>
                  </h2>
                  <p className="text-xs text-gray-400 mt-1">查看各服务端口、统一协议端点与配置文件。</p>
                </div>

                <div className="bg-surface rounded-2xl border border-border p-5 space-y-3 text-xs">
                  <div className="flex items-center justify-between py-2 border-b border-border">
                    <span className="text-gray-400">后端 FastAPI 全栈引擎</span>
                    <span className="font-mono text-white">http://127.0.0.1:8000</span>
                  </div>
                  <div className="flex items-center justify-between py-2 border-b border-border">
                    <span className="text-gray-400">FastMCP 标准协议挂载点</span>
                    <span className="font-mono text-accent-green">/mcp-server (已挂载)</span>
                  </div>
                  <div className="flex items-center justify-between py-2 border-b border-border">
                    <span className="text-gray-400">当前生效 .env 路径</span>
                    <span className="font-mono text-brand-light truncate max-w-sm">{envFile || 'server/.env'}</span>
                  </div>
                  <div className="flex items-center justify-between py-2">
                    <span className="text-gray-400">当前大模型配置状态</span>
                    <span className={`font-semibold ${checks.openai_configured || checks.minimax_configured ? 'text-accent-green' : 'text-amber-400'}`}>
                      {checks.openai_configured ? 'OpenAI / DeepSeek / 通用 Key 已就绪' : (checks.minimax_configured ? 'MiniMax Key 已就绪' : '未配置 (建议在 LLM 标签页填入)')}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Bottom Save Footer */}
          <div className="h-16 px-6 border-t border-border bg-surface flex items-center justify-between shrink-0">
            <button
              onClick={load}
              className="text-xs text-gray-400 hover:text-white transition-all"
            >
              放弃未保存更改
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center space-x-2 px-6 py-2 rounded-xl bg-gradient-to-r from-brand to-brand-blue hover:opacity-95 text-white text-xs font-bold shadow-lg shadow-brand/30 disabled:opacity-40 transition-all"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              <span>{saving ? '正在写入并热重载...' : '保存全部配置'}</span>
            </button>
          </div>
        </div>
      </div>

      {inspectingWorkflowId && (
        <WorkflowInspectorModal
          workflowId={inspectingWorkflowId}
          isOpen={!!inspectingWorkflowId}
          onClose={() => setInspectingWorkflowId('')}
          onSaved={loadWorkflowsList}
          onDeleted={(deletedId) => {
            setWorkflowList(prev => prev.filter((w: any) => w.id !== deletedId));
            if (form.COMFYUI_DEFAULT_IMAGE_WORKFLOW === deletedId) setField('COMFYUI_DEFAULT_IMAGE_WORKFLOW', '');
            if (form.COMFYUI_DEFAULT_VIDEO_WORKFLOW === deletedId) setField('COMFYUI_DEFAULT_VIDEO_WORKFLOW', '');
            setMsg({ type: 'success', text: `已删除内部工作流 ${deletedId}，已自动清理默认配置` });
            loadWorkflowsList();
          }}
        />
      )}
    </div>
  );
};
