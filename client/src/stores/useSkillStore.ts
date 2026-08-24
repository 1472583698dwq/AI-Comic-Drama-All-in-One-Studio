import { create } from 'zustand';
import { SkillDefinition, SkillExecutionResult } from '../types';
import { apiService } from '../services/api';
import { useProjectStore } from './useProjectStore';

interface SkillState {
  skills: SkillDefinition[];
  selectedSkill: SkillDefinition | null;
  isRunningSkill: boolean;
  lastResult: SkillExecutionResult | null;

  // Actions
  fetchSkills: () => Promise<void>;
  setSelectedSkill: (skill: SkillDefinition | null) => void;
  runSkill: (skillName: string, context?: Record<string, any>, userPrompt?: string) => Promise<SkillExecutionResult>;
}

export const useSkillStore = create<SkillState>((set, get) => ({
  skills: [],
  selectedSkill: null,
  isRunningSkill: false,
  lastResult: null,

  fetchSkills: async () => {
    const list = await apiService.listSkills();
    set({ skills: list, selectedSkill: list[0] || null });
  },

  setSelectedSkill: (skill) => set({ selectedSkill: skill }),

  runSkill: async (skillName, context = {}, userPrompt = '') => {
    set({ isRunningSkill: true });
    try {
      const res = await apiService.executeSkill(skillName, context, userPrompt);
      set({ lastResult: res, isRunningSkill: false });

      // If skill modified shot attributes, automatically apply to current active shot
      if (res.modified_data) {
        const { activeShotId, updateShot } = useProjectStore.getState();
        if (activeShotId) {
          updateShot(activeShotId, res.modified_data);
        }
      }

      return res;
    } catch (e: any) {
      set({ isRunningSkill: false });
      throw e;
    }
  },
}));
