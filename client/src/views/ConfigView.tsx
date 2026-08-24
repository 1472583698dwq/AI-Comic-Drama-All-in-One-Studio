import React, { useEffect, useState } from 'react';
import {
  Settings, KeyRound, Cpu, Sliders, Info, Save, TestTube2,
  Eye, EyeOff, CheckCircle2, XCircle, Loader2, Copy, ExternalLink,
  Bot, Mic, Film, FolderCheck, ArrowLeft, RefreshCw, Sparkles, Layers,
  Zap, Globe, Database, HelpCircle
} from 'lucide-react';
import { apiService } from '../services/api';
import { useProjectStore } from '../stores/useProjectStore';

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

  const load = async () => {
    setLoading(true);
    setMsg(null);
    try {
      const res = await apiService.getConfig();
      setForm(res.config || {});
      setEnvFile(res.env_file || '');
      setChecks(res.checks || {});
    } catch (e: any) {
      setMsg({ type: 'error', text: e?.message || '加载配置失败' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

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

  const handleSave = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const payload: any = { ...form };
      await apiService.saveConfig(payload);
      setMsg({ type: 'success', text: '配置已成功写入 server/.env 并即时热重载生效！' });
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
                        onClick={() => {
                          const v = form.COMFYUI_WORKFLOWS_DIR || '';
                          if (!v) setMsg({type:'error', text:'请先填入路径后再保存'});
                          else handleTest('comfyui');
                        }}
                        className="px-3 py-2 rounded-xl bg-surface-tertiary border border-border text-xs text-gray-300 hover:text-white"
                      >
                        检测目录
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
                        onClick={() => {
                          const user = 'Administrator';
                          setField('JIANYIN_DRAFT_PATH', `C:/Users/${user}/AppData/Local/JianyingPro/User Data/Projects/com.lveditor.draft`);
                        }}
                        className="px-3 py-2 rounded-xl bg-surface-tertiary border border-border text-xs text-gray-300 hover:text-white"
                      >
                        填入默认参考路径
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
    </div>
  );
};
