import React, { useState, useEffect } from 'react';
import { Plus, Trash2, FileJson, List, Sparkles, HelpCircle, Sliders, CheckCircle2 } from 'lucide-react';

export interface CustomHeadersEditorProps {
  headers?: Record<string, string>;
  onChange: (headers: Record<string, string>) => void;
  disabled?: boolean;
  className?: string;
  title?: string;
}

interface HeaderPair {
  id: string;
  key: string;
  value: string;
}

const PRESET_HEADERS = [
  { key: 'x-opencode-session', label: 'OpenCode Session (必需)', hint: 'OpenCode 必需会话路由标识 (点击自动生成合规 session ID)', isPrimary: true },
  { key: 'X-Coder-AI-Governance-Token', label: 'OpenCode/Coder 治理Token', hint: 'Coder AI Gateway 治理认证令牌' },
  { key: 'HTTP-Referer', label: 'HTTP-Referer', hint: 'OpenRouter / 代理请求源站点' },
  { key: 'X-Title', label: 'X-Title', hint: 'OpenRouter 应用名称标识' },
  { key: 'Authorization', label: '自定义 Bearer', hint: '如 Bearer custom_token_xxx' },
  { key: 'anthropic-version', label: 'Anthropic Version', hint: '如 2023-06-01' },
];

export const CustomHeadersEditor: React.FC<CustomHeadersEditorProps> = ({
  headers = {},
  onChange,
  disabled = false,
  className = '',
  title = '自定义请求头 (Custom Headers)',
}) => {
  const [pairs, setPairs] = useState<HeaderPair[]>([]);
  const [isJsonMode, setIsJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState('{}');
  const [jsonError, setJsonError] = useState<string | null>(null);

  // 初始化 / 外部变化同步（避免重复创建 id 导致输入框失焦）
  useEffect(() => {
    if (isJsonMode) return;
    const currentHdrs = headers || {};
    // 比对当前 pairs 与 headers 是否实质一致
    const existingDict: Record<string, string> = {};
    for (const p of pairs) {
      if (p.key.trim()) existingDict[p.key.trim()] = p.value;
    }
    if (JSON.stringify(existingDict) === JSON.stringify(currentHdrs)) {
      return;
    }

    const newPairs: HeaderPair[] = Object.entries(currentHdrs).map(([k, v], idx) => {
      const match = pairs.find(p => p.key === k);
      return {
        id: match?.id || `hdr_${idx}_${Math.random().toString(36).slice(2, 8)}`,
        key: k,
        value: String(v ?? ''),
      };
    });
    setPairs(newPairs);
    setJsonText(JSON.stringify(currentHdrs, null, 2));
  }, [JSON.stringify(headers || {})]);

  const updateFromPairs = (nextPairs: HeaderPair[]) => {
    setPairs(nextPairs);
    const result: Record<string, string> = {};
    const lowerMap = new Set<string>();
    for (const p of nextPairs) {
      const k = p.key.trim();
      if (!k) continue;
      const lower = k.toLowerCase();
      if (lowerMap.has(lower)) {
        for (const existKey of Object.keys(result)) {
          if (existKey.toLowerCase() === lower) {
            delete result[existKey];
            break;
          }
        }
      }
      lowerMap.add(lower);
      result[k] = p.value;
    }
    setJsonText(JSON.stringify(result, null, 2));
    setJsonError(null);
    onChange(result);
  };

  const handleAddRow = (presetKey = '', presetValue = '') => {
    let finalVal = presetValue;
    if (presetKey.toLowerCase() === 'x-opencode-session' && !finalVal) {
      finalVal = `session_${Math.random().toString(36).slice(2, 10)}`;
    }
    const next = [...pairs, { id: `hdr_${Date.now()}_${Math.random()}`, key: presetKey, value: finalVal }];
    updateFromPairs(next);
  };

  const handleRemoveRow = (id: string) => {
    const next = pairs.filter(p => p.id !== id);
    updateFromPairs(next);
  };

  const handleChangeRow = (id: string, field: 'key' | 'value', val: string) => {
    const next = pairs.map(p => (p.id === id ? { ...p, [field]: val } : p));
    updateFromPairs(next);
  };

  const handleJsonChange = (text: string) => {
    setJsonText(text);
    if (!text.trim()) {
      setJsonError(null);
      onChange({});
      setPairs([]);
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setJsonError('必须为有效的 JSON 键值对对象 (如 {"Header-Name": "value"})');
        return;
      }
      const stringified: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (k && k.trim()) {
          stringified[k.trim()] = String(v ?? '');
        }
      }
      setJsonError(null);
      onChange(stringified);
      setPairs(Object.entries(stringified).map(([k, v], idx) => ({ id: `hdr_${idx}`, key: k, value: v })));
    } catch (e: any) {
      setJsonError(`JSON 语法错误: ${e.message}`);
    }
  };

  const hasOpenCodeSession = pairs.some(p => p.key.toLowerCase() === 'x-opencode-session' && p.value.trim());

  return (
    <div className={`space-y-3 rounded-2xl border-2 border-brand/30 bg-white/55 dark:bg-white/[.06] p-3.5 text-xs shadow-lg shadow-brand/5 ${className}`}>
      {/* 标题栏与模式切换 */}
      <div className="flex items-center justify-between pb-2 border-b border-white/55 dark:border-white/10">
        <div className="flex items-center gap-2">
          <div className="p-1 rounded-lg bg-brand/20 text-brand-light">
            <Sliders className="h-3.5 w-3.5" />
          </div>
          <span className="font-bold text-white text-xs">{title}</span>
          <span className="rounded-full bg-brand/20 px-2 py-0.5 text-[10px] font-bold text-brand-light border border-brand/30">
            OpenCode 规范
          </span>
          {hasOpenCodeSession && (
            <span className="flex items-center gap-1 rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-300 border border-emerald-500/30 animate-fade-in">
              <CheckCircle2 className="w-3 h-3" /> 已含 OpenCode 会话标识
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {pairs.length > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
              已生效 {pairs.length} 项
            </span>
          )}
          <button
            type="button"
            onClick={() => setIsJsonMode(!isJsonMode)}
            className="flex items-center gap-1 rounded-lg bg-white/55 dark:bg-white/[.06] hover:bg-white/65 dark:bg-white/[.09] px-2.5 py-1 text-[11px] font-semibold text-gray-300 hover:text-white border border-white/70 dark:border-white/12 transition-all"
          >
            {isJsonMode ? <List className="h-3.5 w-3.5 text-brand-light" /> : <FileJson className="h-3.5 w-3.5 text-brand-light" />}
            <span>{isJsonMode ? '切换为键值列表' : '切换为 JSON 代码'}</span>
          </button>
        </div>
      </div>

      {/* 快捷预设标签 - 高亮显眼设计 */}
      {!disabled && (
        <div className="p-2.5 rounded-xl bg-white/60 dark:bg-white/[.05] border border-white/60 dark:border-white/12 space-y-1.5">
          <div className="text-[11px] font-medium text-gray-300 flex items-center justify-between">
            <span className="flex items-center gap-1">
              <Sparkles className="h-3.5 w-3.5 text-amber-400" />
              <span>点击下方快捷预设标签，一键填入常用请求头：</span>
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            {PRESET_HEADERS.map(preset => {
              const hasKey = pairs.some(p => p.key.toLowerCase() === preset.key.toLowerCase());
              return (
                <button
                  key={preset.key}
                  type="button"
                  disabled={hasKey}
                  onClick={() => handleAddRow(preset.key, '')}
                  title={preset.hint}
                  className={`rounded-xl px-2.5 py-1 text-[11px] font-bold border transition-all flex items-center gap-1 ${
                    hasKey
                      ? 'border-white/70 dark:border-white/12 bg-white/55 dark:bg-white/[.06] text-zinc-600 cursor-not-allowed opacity-50'
                      : preset.isPrimary
                      ? 'border-amber-400/60 bg-amber-500/20 text-amber-200 hover:bg-amber-500/30 hover:border-amber-300 shadow-sm shadow-amber-500/20 ring-1 ring-amber-400/30'
                      : 'border-brand/40 bg-brand/10 text-brand-light hover:bg-brand/20 hover:border-brand'
                  }`}
                >
                  <span>+ {preset.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 列表模式 */}
      {!isJsonMode ? (
        <div className="space-y-2">
          {pairs.length === 0 ? (
            <div className="p-4 rounded-xl border border-dashed border-white/80 dark:border-white/20 text-center space-y-2 bg-white/55 dark:bg-white/[.06]">
              <div className="text-xs text-gray-300 font-medium">当前未配置自定义请求头（可选）</div>
              <div className="text-[11px] text-gray-500">
                如果您的模型网关要求携带鉴权令牌或 Session（如 OpenCode.ai、OpenRouter），请点击上方快捷标签或下方按钮添加。
              </div>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => handleAddRow()}
                  className="px-4 py-1.5 rounded-xl bg-brand text-white font-bold text-xs inline-flex items-center gap-1.5 shadow-md shadow-brand/20 hover:brightness-110 transition-all"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>添加首个请求头</span>
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {pairs.map((p, idx) => (
                <div
                  key={p.id}
                  className="p-2 rounded-xl bg-white/55 dark:bg-white/[.06] border border-white/60 dark:border-white/12 flex items-center gap-2 hover:border-brand/50 transition-colors"
                >
                  <span className="text-[10px] font-mono text-gray-500 w-4 text-center">#{idx + 1}</span>
                  <div className="flex-1 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                    <input
                      type="text"
                      disabled={disabled}
                      value={p.key}
                      onChange={e => handleChangeRow(p.id, 'key', e.target.value)}
                      placeholder="Header Key (如 x-opencode-session)"
                      className="w-full sm:w-5/12 rounded-lg border border-white/70 dark:border-white/12 bg-white/55 dark:bg-white/[.06] px-3 py-1.5 font-mono text-xs text-white placeholder-gray-500 focus:border-brand focus:outline-none"
                    />
                    <input
                      type="text"
                      disabled={disabled}
                      value={p.value}
                      onChange={e => handleChangeRow(p.id, 'value', e.target.value)}
                      placeholder="Header Value (如 session_12345)"
                      className="w-full sm:w-7/12 rounded-lg border border-white/70 dark:border-white/12 bg-white/55 dark:bg-white/[.06] px-3 py-1.5 font-mono text-xs text-white placeholder-gray-500 focus:border-brand focus:outline-none"
                    />
                  </div>
                  {!disabled && (
                    <button
                      type="button"
                      onClick={() => handleRemoveRow(p.id)}
                      className="p-1.5 rounded-lg text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-colors shrink-0"
                      title="删除此行"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              ))}

              {!disabled && (
                <div className="flex justify-start pt-1">
                  <button
                    type="button"
                    onClick={() => handleAddRow()}
                    className="flex items-center gap-1.5 rounded-xl border border-brand/40 bg-brand/10 hover:bg-brand/20 px-3.5 py-1.5 text-xs font-bold text-brand-light hover:border-brand transition-colors"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>继续添加一行请求头</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        /* JSON 模式 */
        <div className="space-y-1.5">
          <textarea
            disabled={disabled}
            value={jsonText}
            onChange={e => handleJsonChange(e.target.value)}
            rows={5}
            placeholder='{\n  "x-opencode-session": "session_xxxx",\n  "HTTP-Referer": "https://..."\n}'
            className="w-full rounded-xl border border-white/70 dark:border-white/12 bg-white/55 dark:bg-white/[.06] p-3 font-mono text-xs text-white placeholder-gray-500 focus:border-brand focus:outline-none leading-relaxed"
          />
          {jsonError && <div className="text-[11px] text-red-400 font-medium">⚠️ {jsonError}</div>}
        </div>
      )}
    </div>
  );
};
