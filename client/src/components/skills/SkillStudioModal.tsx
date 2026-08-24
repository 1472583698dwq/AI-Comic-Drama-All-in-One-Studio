import React, { useEffect, useState } from 'react';
import { 
  X, 
  Wand2, 
  Zap, 
  CheckCircle2, 
  Sparkles, 
  FileCode, 
  Cpu, 
  Flame, 
  ShieldCheck, 
  Film,
  Play
} from 'lucide-react';
import { useSkillStore } from '../../stores/useSkillStore';
import { useProjectStore } from '../../stores/useProjectStore';
import { SkillDefinition } from '../../types';

interface SkillStudioModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SkillStudioModal: React.FC<SkillStudioModalProps> = ({ isOpen, onClose }) => {
  const { skills, fetchSkills, selectedSkill, setSelectedSkill, runSkill, isRunningSkill, lastResult } = useSkillStore();
  const { project, activeShotId } = useProjectStore();

  const shots = project?.scenes.flatMap((s) => s.shots) || [];
  const activeShot = shots.find((s) => s.id === activeShotId) || shots[0];

  const [promptOverride, setPromptOverride] = useState('');

  useEffect(() => {
    if (isOpen) {
      fetchSkills();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleExecute = async () => {
    if (!selectedSkill) return;
    await runSkill(
      selectedSkill.name,
      {
        dialogue: activeShot?.dialogue || activeShot?.action_desc || '这一世，我命由我不由天！',
        character_name: activeShot?.speaker_name || '叶凡',
        project_id: project?.id || 'current-proj',
      },
      promptOverride
    );
  };

  const getSkillIcon = (cat: string) => {
    switch (cat) {
      case 'script_enhancement': return <Flame className="w-4 h-4 text-accent-orange" />;
      case 'character_design': return <ShieldCheck className="w-4 h-4 text-accent-pink" />;
      case 'video_assembly': return <Film className="w-4 h-4 text-brand-light" />;
      default: return <Wand2 className="w-4 h-4 text-accent-green" />;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-fade-in">
      <div className="w-full max-w-4xl h-[82vh] bg-surface rounded-2xl border border-border flex flex-col overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="h-14 px-6 border-b border-border flex items-center justify-between bg-surface-secondary/60">
          <div className="flex items-center space-x-3">
            <div className="p-2 rounded-xl bg-gradient-to-r from-accent-orange to-brand text-white shadow-sm">
              <Wand2 className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h2 className="text-sm font-bold text-white">漫剧专业技能工坊 (Skill Studio)</h2>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-accent-orange/20 text-accent-orange border border-accent-orange/30">
                  Antigravity / ViMax Skill 标准
                </span>
              </div>
              <p className="text-[11px] text-gray-400">
                Skills 封装了高级漫剧导演 SOP，可自主调用系统 3D 导演台、MiniMax 语音、ComfyUI 与剪映工程
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-surface-tertiary transition-all"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left Skills List */}
          <div className="w-80 border-r border-border p-3 overflow-y-auto space-y-2.5 custom-scrollbar">
            {skills.map((skill) => {
              const isSelected = selectedSkill?.name === skill.name;
              return (
                <div
                  key={skill.name}
                  onClick={() => setSelectedSkill(skill)}
                  className={`p-3.5 rounded-xl border cursor-pointer transition-all ${
                    isSelected
                      ? 'bg-surface-tertiary border-accent-orange glow-border'
                      : 'bg-surface-secondary/70 border-border hover:border-border-active'
                  }`}
                >
                  <div className="flex items-center space-x-2 mb-1.5">
                    <div className="p-1.5 rounded-lg bg-black/40 border border-white/5">
                      {getSkillIcon(skill.category)}
                    </div>
                    <span className="text-xs font-bold text-white truncate">{skill.name}</span>
                  </div>
                  <p className="text-[11px] text-gray-400 line-clamp-2 leading-relaxed">{skill.description}</p>
                  
                  {/* Tools Badge */}
                  <div className="mt-2.5 flex flex-wrap gap-1">
                    {skill.tools?.map((t) => (
                      <span key={t} className="text-[9px] px-1.5 py-0.2 rounded bg-black/50 text-accent-green font-mono border border-accent-green/20">
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Right Skill Inspector & Runner */}
          <div className="flex-1 p-6 flex flex-col space-y-4 overflow-y-auto custom-scrollbar">
            {selectedSkill && (
              <>
                <div className="bg-surface-secondary p-4 rounded-xl border border-border">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center space-x-2">
                      {getSkillIcon(selectedSkill.category)}
                      <h3 className="text-sm font-bold text-white">{selectedSkill.name}</h3>
                      <span className="text-[10px] text-gray-400">v{selectedSkill.version}</span>
                    </div>
                    <span className="text-[10px] text-gray-500">作者: {selectedSkill.author}</span>
                  </div>
                  <p className="text-xs text-gray-300 leading-relaxed">{selectedSkill.description}</p>
                </div>

                {/* Skill SOP Instructions Preview */}
                <div className="bg-black/50 p-4 rounded-xl border border-border/80 flex flex-col space-y-2">
                  <div className="flex items-center space-x-1.5 text-xs font-semibold text-brand-light">
                    <FileCode className="w-3.5 h-3.5" />
                    <span>SKILL.md 导演指导规范 (Instructions)</span>
                  </div>
                  <pre className="text-[11px] text-gray-300 font-mono whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto custom-scrollbar">
                    {selectedSkill.instructions || '此 Skill 声明了专属执行逻辑，执行时将自动调用关联的 MCP 工具。'}
                  </pre>
                </div>

                {/* Execution Result Log Banner */}
                {lastResult && (
                  <div className="p-3.5 rounded-xl bg-accent-green/10 border border-accent-green/30 space-y-1.5 animate-fade-in">
                    <div className="flex items-center justify-between text-xs font-bold text-accent-green">
                      <div className="flex items-center space-x-1.5">
                        <CheckCircle2 className="w-4 h-4" />
                        <span>Skill 执行成功 (+{lastResult.execution_time_ms}ms)</span>
                      </div>
                    </div>
                    <p className="text-xs text-gray-200">{lastResult.result_message}</p>
                    
                    {/* Tool Calls */}
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {lastResult.tool_calls.map((tc, i) => (
                        <span key={i} className="text-[10px] px-2 py-0.5 rounded bg-black/60 text-accent-green font-mono flex items-center space-x-1 border border-accent-green/30">
                          <Cpu className="w-3 h-3" />
                          <span>{tc.tool} (OK)</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Execute Action */}
                <div className="pt-2 flex items-center justify-between border-t border-border mt-auto">
                  <span className="text-[11px] text-gray-400">
                    🎯 针对当前选中的镜 #{activeShot?.shot_index || 1} 立即执行
                  </span>

                  <button
                    onClick={handleExecute}
                    disabled={isRunningSkill}
                    className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-accent-orange to-brand text-white text-xs font-bold shadow-lg shadow-accent-orange/20 hover:opacity-90 flex items-center space-x-2 transition-all"
                  >
                    <Zap className={`w-4 h-4 ${isRunningSkill ? 'animate-spin' : ''}`} />
                    <span>{isRunningSkill ? 'Skill 正在调度工具链...' : '立即执行此 Skill'}</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
