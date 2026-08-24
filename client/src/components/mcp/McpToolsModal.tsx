import React, { useState, useEffect } from 'react';
import { 
  X, 
  Cpu, 
  Check, 
  Play, 
  Terminal, 
  Plus, 
  BookOpen, 
  Mic, 
  Camera, 
  Share2, 
  ShieldAlert,
  Clock,
  Sparkles
} from 'lucide-react';
import { useMcpStore } from '../../stores/useMcpStore';
import { MCPToolDefinition } from '../../types';

interface McpToolsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const McpToolsModal: React.FC<McpToolsModalProps> = ({ isOpen, onClose }) => {
  const { tools, fetchTools, toggleTool, invokeTool, logs, isToolRunning } = useMcpStore();

  const [selectedTool, setSelectedTool] = useState<MCPToolDefinition | null>(null);
  const [testArgsJson, setTestArgsJson] = useState<string>('{\n  "novel_text": "九龙拉棺，泰山降临..."\n}');
  const [activeTab, setActiveTab] = useState<'tools' | 'logs'>('tools');

  useEffect(() => {
    if (isOpen) {
      fetchTools();
    }
  }, [isOpen]);

  useEffect(() => {
    if (tools.length > 0 && !selectedTool) {
      setSelectedTool(tools[0]);
    }
  }, [tools]);

  if (!isOpen) return null;

  const handleSelectTool = (tool: MCPToolDefinition) => {
    setSelectedTool(tool);
    if (tool.name === 'generate_minimax_voice') {
      setTestArgsJson('{\n  "text": "这一世，我命由我不由天！",\n  "voice_id": "male-qn-qingse",\n  "emotion": "intense"\n}');
    } else if (tool.name === 'director_3d_stage_plan') {
      setTestArgsJson('{\n  "framing": "medium",\n  "motion": "push_in",\n  "pose": "fight"\n}');
    } else if (tool.name === 'comfyui_render_node') {
      setTestArgsJson('{\n  "prompt": "1boy, glowing golden eyes, anime 8k",\n  "comfy_server_url": "http://127.0.0.1:8188"\n}');
    } else {
      setTestArgsJson('{\n  "novel_text": "九龙拉棺降临泰山之巅..."\n}');
    }
  };

  const handleExecuteTool = async () => {
    if (!selectedTool) return;
    try {
      const parsedArgs = JSON.parse(testArgsJson);
      await invokeTool(selectedTool.name, parsedArgs);
      setActiveTab('logs');
    } catch (e: any) {
      alert('参数 JSON 格式错误: ' + e.message);
    }
  };

  const getToolIcon = (iconName: string) => {
    switch (iconName) {
      case 'BookOpen': return <BookOpen className="w-4 h-4 text-brand-light" />;
      case 'Mic': return <Mic className="w-4 h-4 text-accent-pink" />;
      case 'Camera': return <Camera className="w-4 h-4 text-accent-orange" />;
      case 'Share2': return <Share2 className="w-4 h-4 text-brand-blue" />;
      default: return <Cpu className="w-4 h-4 text-accent-green" />;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-fade-in">
      <div className="w-full max-w-4xl h-[80vh] bg-surface rounded-2xl border border-border flex flex-col overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="h-14 px-6 border-b border-border flex items-center justify-between bg-surface-secondary/50">
          <div className="flex items-center space-x-3">
            <div className="p-2 rounded-xl bg-accent-green/20 border border-accent-green/40 text-accent-green">
              <Cpu className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h2 className="text-sm font-bold text-white">Model Context Protocol (MCP) 工具中枢</h2>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-accent-green/20 text-accent-green border border-accent-green/30">
                  统一工具标准协议
                </span>
              </div>
              <p className="text-[11px] text-gray-400">
                双端支持即插即用接入外部 ComfyUI、MiniMax 语音、剪映工程与自定义 Agent Tools
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-3">
            {/* Tab Switcher */}
            <div className="flex bg-surface p-1 rounded-lg border border-border text-xs">
              <button
                onClick={() => setActiveTab('tools')}
                className={`px-3 py-1 rounded-md font-medium transition-all ${
                  activeTab === 'tools' ? 'bg-brand text-white shadow-sm' : 'text-gray-400 hover:text-white'
                }`}
              >
                已装工具 ({tools.length})
              </button>
              <button
                onClick={() => setActiveTab('logs')}
                className={`px-3 py-1 rounded-md font-medium transition-all flex items-center space-x-1 ${
                  activeTab === 'logs' ? 'bg-brand text-white shadow-sm' : 'text-gray-400 hover:text-white'
                }`}
              >
                <span>调用日志</span>
                <span className="w-1.5 h-1.5 rounded-full bg-accent-orange" />
              </button>
            </div>

            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-surface-tertiary transition-all"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div className="flex-1 flex overflow-hidden">
          {activeTab === 'tools' ? (
            <>
              {/* Left Tools List */}
              <div className="w-80 border-r border-border p-3 overflow-y-auto space-y-2 custom-scrollbar">
                {tools.map((tool) => {
                  const isSelected = selectedTool?.name === tool.name;
                  return (
                    <div
                      key={tool.name}
                      onClick={() => handleSelectTool(tool)}
                      className={`p-3 rounded-xl border cursor-pointer transition-all ${
                        isSelected
                          ? 'bg-surface-tertiary border-brand glow-border'
                          : 'bg-surface-secondary/70 border-border hover:border-border-active'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center space-x-2">
                          <div className="p-1 rounded-lg bg-black/40 border border-white/5">
                            {getToolIcon(tool.icon)}
                          </div>
                          <span className="text-xs font-bold text-white">{tool.name}</span>
                        </div>
                        <input
                          type="checkbox"
                          checked={tool.is_enabled}
                          onChange={(e) => {
                            e.stopPropagation();
                            toggleTool(tool.name);
                          }}
                          className="w-3.5 h-3.5 accent-brand"
                        />
                      </div>
                      <p className="text-[11px] text-gray-400 line-clamp-2">{tool.description}</p>
                      <div className="mt-2 flex items-center justify-between text-[10px] text-gray-500">
                        <span>作者: {tool.author}</span>
                        <span className="px-1.5 py-0.2 rounded bg-black/50 text-brand-light font-mono">
                          {tool.category}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Right Tool Inspector & Test Sandbox */}
              <div className="flex-1 p-6 flex flex-col space-y-4 overflow-y-auto custom-scrollbar">
                {selectedTool && (
                  <>
                    <div className="bg-surface-secondary p-4 rounded-xl border border-border">
                      <div className="flex items-center space-x-2 mb-1">
                        {getToolIcon(selectedTool.icon)}
                        <h3 className="text-sm font-bold text-white">{selectedTool.name}</h3>
                      </div>
                      <p className="text-xs text-gray-300">{selectedTool.description}</p>
                    </div>

                    {/* JSON Arguments Editor */}
                    <div className="flex-1 flex flex-col space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="text-xs font-semibold text-gray-300 flex items-center space-x-1.5">
                          <Terminal className="w-3.5 h-3.5 text-accent-green" />
                          <span>MCP Tool Arguments (JSON 格式)</span>
                        </label>
                        <span className="text-[10px] text-gray-500 font-mono">Schema-validated</span>
                      </div>
                      <textarea
                        value={testArgsJson}
                        onChange={(e) => setTestArgsJson(e.target.value)}
                        rows={7}
                        className="w-full flex-1 bg-black/60 border border-border rounded-xl p-3 font-mono text-xs text-accent-green focus:outline-none focus:border-brand custom-scrollbar"
                      />
                    </div>

                    {/* Execute Action */}
                    <div className="pt-2 flex items-center justify-between">
                      <span className="text-[11px] text-gray-400">
                        ⚡ 执行后将作为 Agent Tool Step 实时推送并在控制台生效
                      </span>
                      <button
                        onClick={handleExecuteTool}
                        disabled={isToolRunning}
                        className="px-5 py-2 rounded-xl bg-gradient-to-r from-brand to-accent-green text-white text-xs font-bold shadow-lg shadow-brand/20 hover:opacity-90 flex items-center space-x-2 transition-all"
                      >
                        <Play className={`w-3.5 h-3.5 fill-current ${isToolRunning ? 'animate-spin' : ''}`} />
                        <span>{isToolRunning ? '调用中...' : '立即调用 MCP Tool'}</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            </>
          ) : (
            /* Logs Tab */
            <div className="flex-1 p-6 overflow-y-auto space-y-3 custom-scrollbar">
              {logs.length === 0 ? (
                <div className="text-center py-16 text-gray-500 text-xs">暂无 MCP 调用日志</div>
              ) : (
                logs.map((log) => (
                  <div
                    key={log.id}
                    className="p-4 rounded-xl bg-surface-secondary border border-border space-y-2 font-mono text-xs"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <span
                          className={`w-2 h-2 rounded-full ${
                            log.status === 'success'
                              ? 'bg-accent-green'
                              : log.status === 'error'
                              ? 'bg-red-500'
                              : 'bg-accent-orange animate-pulse'
                          }`}
                        />
                        <span className="font-bold text-white">{log.tool_name}</span>
                      </div>
                      <div className="flex items-center space-x-3 text-gray-400 text-[11px]">
                        <span>{log.duration_ms}ms</span>
                        <span>{log.timestamp}</span>
                      </div>
                    </div>

                    <div className="bg-black/50 p-2.5 rounded-lg border border-border/60 text-gray-300 text-[11px] overflow-x-auto">
                      <div className="text-gray-500 text-[10px] mb-1">Arguments:</div>
                      <pre>{JSON.stringify(log.arguments, null, 2)}</pre>
                      {log.result && (
                        <>
                          <div className="text-brand-light text-[10px] mt-2 mb-1">Result:</div>
                          <pre className="text-gray-200">{JSON.stringify(log.result, null, 2)}</pre>
                        </>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
