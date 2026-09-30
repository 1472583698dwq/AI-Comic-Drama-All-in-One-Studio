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
  Play,
  Upload,
  Trash2,
  RefreshCw as RefreshIcon,
  Download
} from 'lucide-react';
import { apiService } from '../../services/api';
import { useSkillStore } from '../../stores/useSkillStore';
import { useProjectStore } from '../../stores/useProjectStore';
import { SkillVersionDiff } from './SkillVersionDiff';
import { SkillDefinition } from '../../types';
import { confirmAsync, toast } from '../../stores/useDialogStore';
import { useEscapeClose } from '../../hooks/useEscapeClose';

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
  const [showImport, setShowImport] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importContent, setImportContent] = useState('');
  const [importName, setImportName] = useState('');
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      fetchSkills();
    }
  }, [isOpen]);

  // Agent 通过 Creator 落地新技能后会派发该事件，此前无人监听，列表不会自动刷新
  useEffect(() => {
    const onRefresh = () => { if (isOpen) fetchSkills(); };
    window.addEventListener('skill-list-refresh', onRefresh);
    return () => window.removeEventListener('skill-list-refresh', onRefresh);
  }, [isOpen, fetchSkills]);

  const handleImport = async () => {
    if (!importFile && !importContent.trim()) {
      alert('请选择 SKILL.md/.zip 文件或粘贴内容');
      return;
    }
    setImporting(true);
    try {
      const res = await apiService.importSkill(importFile || undefined, importContent || undefined, importName || undefined);
      alert(`已导入技能: ${res.skill?.name || importName}${res.overwritten ? '（已覆盖旧版，旧版已自动备份，可在版本历史中 diff/回溯）' : ''}`);
      setShowImport(false);
      setImportFile(null);
      setImportContent('');
      setImportName('');
      await fetchSkills();
    } catch (e: any) {
      alert('导入失败: ' + (e?.message || String(e)));
    } finally {
      setImporting(false);
    }
  };

  const handleDelete = async (skillName: string) => {
    const confirmed = await confirmAsync({
      title: '删除技能',
      message: `确定要删除技能 "${skillName}" 吗？\n此操作将从文件系统中永久删除对应的 SKILL.md。`,
      isDanger: true,
      confirmText: '确认删除',
      cancelText: '取消'
    });
    if (!confirmed) return;
    try {
      await apiService.deleteSkill(skillName);
      toast.success(`技能 "${skillName}" 已删除`);
      await fetchSkills();
    } catch (e: any) {
      toast.error('删除失败: ' + (e?.message || String(e)));
    }
  };

  const handleReload = async () => {
    try {
      await apiService.reloadSkills();
      await fetchSkills();
    } catch (e: any) {
      alert('重载失败: ' + (e?.message || String(e)));
    }
  };

  useEscapeClose(isOpen, onClose);
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
      <div className="w-full max-w-4xl h-[82vh] bg-white/60 dark:bg-white/[.05] rounded-2xl border border-white/70 dark:border-white/12 flex flex-col overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="h-14 px-6 border-b border-white/70 dark:border-white/12 flex items-center justify-between bg-white/55 dark:bg-white/[.05]">
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

          <div className="flex items-center gap-1.5">
            <button
              onClick={handleReload}
              className="px-3 py-1.5 rounded-lg bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12 text-xs text-gray-300 hover:text-white hover:border-brand flex items-center gap-1.5"
              title="重载所有 Skills"
            >
              <RefreshIcon className="w-3.5 h-3.5" /> 重载
            </button>
            <button
              onClick={() => setShowImport(true)}
              className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs font-bold hover:bg-brand-light flex items-center gap-1.5 shadow-md"
            >
              <Upload className="w-3.5 h-3.5" /> 导入 Skill
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/65 dark:bg-white/[.09] transition-all"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left Skills List */}
          <div className="w-80 border-r border-white/70 dark:border-white/12 p-3 overflow-y-auto space-y-2.5 custom-scrollbar">
            {skills.map((skill) => {
              const isSelected = selectedSkill?.name === skill.name;
              return (
                <div
                  key={skill.name}
                  onClick={() => setSelectedSkill(skill)}
                  className={`p-3.5 rounded-xl border cursor-pointer transition-all relative group ${
                    isSelected
                      ? 'bg-white/65 dark:bg-white/[.09] border-accent-orange glow-border'
                      : 'bg-white/60 dark:bg-white/[.05] border-white/70 dark:border-white/12 hover:border-white/80 dark:border-white/20'
                  }`}
                >
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(skill.name);
                    }}
                    className="absolute top-2 right-2 p-1 rounded-lg bg-white/75 dark:bg-black/50 text-gray-400 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all"
                    title="删除此 Skill"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                  <div className="flex items-center space-x-2 mb-1.5 pr-6">
                    <div className="p-1.5 rounded-lg bg-white/55 dark:bg-white/[.06] border border-white/5">
                      {getSkillIcon(skill.category)}
                    </div>
                    <span className="text-xs font-bold text-white truncate">{skill.name}</span>
                  </div>
                  <p className="text-[11px] text-gray-400 line-clamp-2 leading-relaxed">{skill.description}</p>
                  
                  {/* Tools Badge */}
                  <div className="mt-2.5 flex flex-wrap gap-1">
                    {skill.tools?.map((t) => (
                      <span key={t} className="text-[9px] px-1.5 py-0.2 rounded bg-white/55 dark:bg-white/[.06] text-accent-green font-mono border border-accent-green/20">
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
                <div className="bg-white/55 dark:bg-white/[.06] p-4 rounded-xl border border-white/70 dark:border-white/12">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center space-x-2">
                      {getSkillIcon(selectedSkill.category)}
                      <h3 className="text-sm font-bold text-white">{selectedSkill.name}</h3>
                      <span className="text-[10px] text-gray-400">v{selectedSkill.version}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-gray-500">作者: {selectedSkill.author}</span>
                      <button
                        onClick={() => handleDelete(selectedSkill.name)}
                        className="p-1 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 hover:text-red-300 border border-red-500/20"
                        title="删除此 Skill"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                  <p className="text-xs text-gray-300 leading-relaxed">{selectedSkill.description}</p>
                </div>

                {/* Skill SOP Instructions Preview */}
                <div className="bg-white/55 dark:bg-white/[.06] p-4 rounded-xl border border-white/60 dark:border-white/12 flex flex-col space-y-2">
                  <div className="flex items-center space-x-1.5 text-xs font-semibold text-brand-light">
                    <FileCode className="w-3.5 h-3.5" />
                    <span>SKILL.md 导演指导规范 (Instructions)</span>
                  </div>
                  <pre className="text-[11px] text-gray-300 font-mono whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto custom-scrollbar">
                    {selectedSkill.instructions || '此 Skill 声明了专属执行逻辑，执行时将自动调用关联的 MCP 工具。'}
                  </pre>
                </div>

                {/* Skill 版本历史与 diff */}
                <SkillVersionDiff skillName={selectedSkill.name} />

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
                        <span key={i} className="text-[10px] px-2 py-0.5 rounded bg-white/55 dark:bg-white/[.06] text-accent-green font-mono flex items-center space-x-1 border border-accent-green/30">
                          <Cpu className="w-3 h-3" />
                          <span>{tc.tool} (OK)</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Execute Action */}
                <div className="pt-2 flex items-center justify-between border-t border-white/70 dark:border-white/12 mt-auto">
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

      {/* Import Skill Modal */}
      {showImport && (
        <div className="absolute inset-0 bg-white/75 dark:bg-black/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setShowImport(false)}>
          <div className="bg-white/60 dark:bg-white/[.05] border border-white/70 dark:border-white/12 rounded-2xl w-full max-w-lg p-5 space-y-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <Upload className="w-4 h-4 text-brand" /> 导入 Skill
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-brand/20 text-brand-light border border-brand/30">SKILL.md / .zip</span>
              </h3>
              <button onClick={() => setShowImport(false)} className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/65 dark:bg-white/[.09]">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-gray-300">上传文件（.md 或 .zip）</label>
                <input
                  type="file"
                  accept=".md,.zip"
                  onChange={(e) => setImportFile(e.target.files?.[0] || null)}
                  className="mt-1 w-full text-xs text-gray-300 file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:bg-brand file:text-white file:text-xs file:font-bold hover:file:bg-brand-light"
                />
                {importFile && <div className="text-[11px] text-gray-400 mt-1">已选: {importFile.name} ({(importFile.size / 1024).toFixed(1)} KB)</div>}
              </div>

              <div className="text-center text-[11px] text-gray-500">— 或 —</div>

              <div>
                <label className="text-xs font-semibold text-gray-300">粘贴 SKILL.md 内容</label>
                <textarea
                  value={importContent}
                  onChange={(e) => setImportContent(e.target.value)}
                  placeholder={`---\nname: my-awesome-skill\ndescription: 描述\nversion: 1.0.0\ncategory: general\ntools:\n  - generate_image\n---\n\n# 技能说明\n...`}
                  rows={8}
                  className="mt-1 w-full bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12 rounded-xl p-3 text-xs font-mono text-white placeholder-gray-500 focus:outline-none focus:border-brand resize-none"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-gray-300">自定义技能名（可选，留空则从文件解析）</label>
                <input
                  value={importName}
                  onChange={(e) => setImportName(e.target.value)}
                  placeholder="如: my-skill-name"
                  className="mt-1 w-full bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12 rounded-xl px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <button onClick={() => setShowImport(false)} className="px-4 py-2 rounded-xl bg-white/55 dark:bg-white/[.06] border border-white/70 dark:border-white/12 text-xs text-gray-300 hover:text-white">
                取消
              </button>
              <button
                onClick={handleImport}
                disabled={importing || (!importFile && !importContent.trim())}
                className="px-5 py-2 rounded-xl bg-brand text-white text-xs font-bold hover:bg-brand-light disabled:opacity-40 flex items-center gap-1.5"
              >
                {importing ? <RefreshIcon className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                <span>{importing ? '导入中...' : '确认导入'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
