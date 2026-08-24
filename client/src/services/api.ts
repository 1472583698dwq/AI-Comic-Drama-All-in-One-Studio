import { Project, StoryboardShot, MCPToolDefinition } from '../types';

const isDev = typeof window !== 'undefined' && window.location.port === '5173';
const API_BASE_URL = isDev ? 'http://127.0.0.1:8000/api/v1' : '/api/v1';

function extractErrorMessage(res: Response, body: any): string {
  if (body?.detail) {
    if (typeof body.detail === 'string') return body.detail;
    if (Array.isArray(body.detail)) return body.detail.map((d: any) => d.msg || JSON.stringify(d)).join('; ');
  }
  return `请求失败 (HTTP ${res.status})`;
}

export const apiService = {
  // 1. 小说解析与分镜提取（真实 MiniMax LLM；未配置 Key 时抛 503）
  async parseScript(novelText: string, stylePreset: string = 'donghua_xianxia', aspectRatio: string = '9:16'): Promise<Project> {
    const res = await fetch(`${API_BASE_URL}/projects/parse-script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: novelText, style_preset: stylePreset, aspect_ratio: aspectRatio }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(extractErrorMessage(res, body));
    }
    return await res.json();
  },

  // 2. TTS 超拟人配音生成（动态Provider）
  async generateTTS(text: string, voiceId: string, emotion: string = 'neutral', opts?: { provider?: string; speed?: number; pitch?: number; model?: string; ref_audio_path?: string }): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/tts/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice_id: voiceId, emotion, speed: opts?.speed ?? 1.0, pitch: opts?.pitch ?? 0.0, provider: opts?.provider, model: opts?.model, ref_audio_path: opts?.ref_audio_path }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(extractErrorMessage(res, body));
    }
    return await res.json();
  },

  async listTtsProviders(): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/tts/providers`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  async listTtsVoices(provider?: string): Promise<any> {
    const url = provider ? `${API_BASE_URL}/tts/voices?provider=${encodeURIComponent(provider)}` : `${API_BASE_URL}/tts/voices`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  // 3. 图片生成（动态Provider + 工作流）
  async generateShotImage(params: {
    prompt: string; negative_prompt?: string; aspect_ratio?: string; style_preset?: string; seed?: number;
    provider?: string; workflow_id?: string; model?: string; steps?: number; cfg?: number; width?: number; height?: number;
  }): Promise<{ image_url: string; seed: number; engine: string; provider: string }> {
    const res = await fetch(`${API_BASE_URL}/images/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: params.prompt,
        negative_prompt: params.negative_prompt || '',
        aspect_ratio: params.aspect_ratio || '9:16',
        style_preset: params.style_preset,
        seed: params.seed,
        provider: params.provider,
        workflow_id: params.workflow_id,
        model: params.model,
        width: params.width,
        height: params.height,
        steps: params.steps,
        cfg: params.cfg,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(extractErrorMessage(res, body));
    }
    return await res.json();
  },

  async generateCharacter3Views(params: {
    name: string; visual_prompt: string; description?: string; style_preset?: string;
  }): Promise<{ three_views: Record<string, string>; errors: Record<string, string> }> {
    const res = await fetch(`${API_BASE_URL}/images/character-3views`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: params.name,
        visual_prompt: params.visual_prompt,
        description: params.description || '',
        style_preset: params.style_preset || 'donghua_xianxia',
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(extractErrorMessage(res, body));
    }
    return await res.json();
  },

  async imagesHealth(provider?: string): Promise<any> {
    const url = provider ? `${API_BASE_URL}/images/health?provider=${encodeURIComponent(provider)}` : `${API_BASE_URL}/images/health`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  async listImageProviders(): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/images/providers`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  // ComfyUI 工作流管理
  async listWorkflows(): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/images/workflows`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  async getWorkflow(workflowId: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/images/workflows/${encodeURIComponent(workflowId)}`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  async deleteWorkflow(workflowId: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/images/workflows/${encodeURIComponent(workflowId)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  async uploadWorkflow(file: File, name?: string, description?: string): Promise<any> {
    const fd = new FormData();
    fd.append('file', file);
    if (name) fd.append('name', name);
    if (description) fd.append('description', description);
    const res = await fetch(`${API_BASE_URL}/images/workflows/upload`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  async uploadWorkflowJson(jsonText: string, name?: string, description?: string, mapping?: any): Promise<any> {
    const fd = new FormData();
    fd.append('workflow_json', jsonText);
    if (name) fd.append('name', name);
    if (description) fd.append('description', description);
    if (mapping) fd.append('mapping', JSON.stringify(mapping));
    const res = await fetch(`${API_BASE_URL}/images/workflows/upload`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  async updateWorkflowMapping(workflowId: string, mapping: Record<string, string>): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/images/workflows/${encodeURIComponent(workflowId)}/mapping`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mapping }),
    });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  // 4. MCP 工具
  async listMcpTools(): Promise<MCPToolDefinition[]> {
    const res = await fetch(`${API_BASE_URL}/mcp/tools`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  async callMcpTool(toolName: string, args: Record<string, any>): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/mcp/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool_name: toolName, arguments: args }),
    });
    return await res.json();
  },

  // 5. 技能 (Skills)
  async listSkills(): Promise<any[]> {
    const res = await fetch(`${API_BASE_URL}/skills`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  async executeSkill(skillName: string, context: Record<string, any>, userPrompt?: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/skills/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skill_name: skillName, context, user_prompt: userPrompt || '' }),
    });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  // 6. 导出剪映官方草稿工程
  async exportJianYingDraft(project: Project): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/projects/export-jianyin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(project),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(extractErrorMessage(res, body));
    }
    return await res.json();
  },

  // 7. 系统配置
  async getConfig(): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/config`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async saveConfig(config: Record<string, string>): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async testConfig(
    target: 'openai' | 'responses_api' | 'deepseek' | 'qwen' | 'minimax' | 'comfyui' | 'siliconflow' | 'dashscope' | 'elevenlabs' | 'cosyvoice' | 'gptsovits' | 'jianyin' | 'openai_compat',
    config?: Record<string, string>
  ): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/config/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target, config }),
    });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  // 8. 导演 Agent
  async agentChat(prompt: string, context?: any): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, context: context || {} }),
    });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  // 9. 全链路编排
  async pipelineFullRun(params: {
    text: string; style_preset?: string; aspect_ratio?: string; custom_instructions?: string; max_images?: number;
    image_provider?: string; image_workflow_id?: string; audio_provider?: string;
  }): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/pipeline/full-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: params.text,
        style_preset: params.style_preset || 'donghua_xianxia',
        aspect_ratio: params.aspect_ratio || '9:16',
        custom_instructions: params.custom_instructions || '',
        max_images: params.max_images ?? 12,
        image_provider: params.image_provider,
        image_workflow_id: params.image_workflow_id,
        audio_provider: params.audio_provider,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(extractErrorMessage(res, body));
    }
    return await res.json();
  },
};
