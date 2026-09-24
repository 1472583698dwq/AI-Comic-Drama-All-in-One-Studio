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

  // 2. TTS 超拟人配音生成（动态Provider；voice_id/emotion 缺省时由后端所选源的声明默认值兜底）
  async generateTTS(text: string, voiceId?: string, emotion?: string, opts?: { provider?: string; speed?: number; pitch?: number; model?: string; ref_audio_path?: string }): Promise<any> {
    const body: Record<string, any> = { text, speed: opts?.speed ?? 1.0, pitch: opts?.pitch ?? 0.0, provider: opts?.provider, model: opts?.model, ref_audio_path: opts?.ref_audio_path };
    if (voiceId) body.voice_id = voiceId;
    if (emotion) body.emotion = emotion;
    const res = await fetch(`${API_BASE_URL}/tts/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
    dynamic_inputs?: Record<string, any>;
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
        dynamic_inputs: params.dynamic_inputs,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(extractErrorMessage(res, body));
    }
    return await res.json();
  },

  async uploadImageToComfyUI(file: File): Promise<{ status: string; name: string }> {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`${API_BASE_URL}/images/comfyui/upload`, {
      method: 'POST',
      body: fd,
    });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
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

  // 3.5 动态视频生成 (I2V / R2V / T2V)
  async generateShotVideo(params: {
    prompt: string;
    mode?: 'i2v' | 'r2v' | 't2v';
    first_frame_url?: string;
    last_frame_url?: string;
    reference_images?: string[];
    duration?: number;
    resolution?: string;
    aspect_ratio?: string;
    provider?: string;
    workflow_id?: string;
    dynamic_inputs?: Record<string, any>;
    shot_id?: string;
  }): Promise<{
    video_url: string;
    local_path?: string;
    provider: string;
    engine: string;
    duration: number;
    elapsed_ms: number;
    task_id?: string;
    first_frame_url?: string;
    shot_id?: string;
  }> {
    const res = await fetch(`${API_BASE_URL}/videos/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: params.prompt,
        mode: params.mode || 'i2v',
        first_frame_url: params.first_frame_url,
        last_frame_url: params.last_frame_url,
        reference_images: params.reference_images,
        duration: params.duration || 5,
        resolution: params.resolution || '720p',
        aspect_ratio: params.aspect_ratio || '9:16',
        provider: params.provider,
        workflow_id: params.workflow_id,
        dynamic_inputs: params.dynamic_inputs,
        shot_id: params.shot_id,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(extractErrorMessage(res, body));
    }
    return await res.json();
  },

  async listVideoProviders(): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/videos/providers`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  async videoHealth(): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/videos/health`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  async getVideoTaskStatus(taskId: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/videos/status/${encodeURIComponent(taskId)}`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  // ComfyUI 工作流管理（支持外部目录直读）
  async listWorkflows(source: 'all' | 'internal' | 'external' = 'all'): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/images/workflows?source=${encodeURIComponent(source)}&_t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  async getExternalWorkflowsDir(): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/images/workflows/external/dir`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  async importExternalWorkflow(externalId: string, newName?: string): Promise<any> {
    const url = `${API_BASE_URL}/images/workflows/import/${encodeURIComponent(externalId)}${newName ? `?new_name=${encodeURIComponent(newName)}` : ''}`;
    const res = await fetch(url, { method: 'POST' });
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

  async inspectWorkflow(workflowId: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/images/workflows/${encodeURIComponent(workflowId)}/inspect`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  async refreshWorkflowAppContract(workflowId: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/images/workflows/${encodeURIComponent(workflowId)}/refresh-app-contract`, { method: 'POST' });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  async saveWorkflowOverrides(workflowId: string, data: { mapping?: Record<string, string>; node_overrides?: Record<string, Record<string, any>>; exposed_inputs?: any[]; auto_import_if_ext?: boolean }): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/images/workflows/${encodeURIComponent(workflowId)}/overrides`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  async validateWorkflow(workflowId: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/images/workflows/${encodeURIComponent(workflowId)}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  async listWorkflowSlots(workflowId: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/images/workflows/${encodeURIComponent(workflowId)}/slots`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  async setWorkflowNodeParam(workflowId: string, nodeId: string, paramName: string, value: any): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/images/workflows/${encodeURIComponent(workflowId)}/node/${encodeURIComponent(nodeId)}/${encodeURIComponent(paramName)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  async composeWorkflows(fragments: Array<{ workflow_id: string; prefix?: string }>, name?: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/images/workflows/compose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fragments, name }),
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

  async expandPrompt(prompt: string, kind: 'image' | 'video' | 'dialogue' = 'image'): Promise<string> {
    const res = await fetch(`${API_BASE_URL}/llm/expand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, kind }),
    });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    const data = await res.json();
    return data?.expanded || '';
  },

  // 节点 Agent 一体化：自然语言需求 → skill/源/参数规划 → 执行（params 为用户在高级面板覆写的异构参数）
  async canvasAgentGenerate(payload: { node_type: string; idea: string; provider_id?: string; skill_id?: string; slots?: Record<string, any>; extra_hint?: string; params?: Record<string, any>; node_id?: string }): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/canvas/agent/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
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

  async getSkillRaw(name: string): Promise<{ name: string; file_path: string; content: string }> {
    const res = await fetch(`${API_BASE_URL}/skills/${encodeURIComponent(name)}/raw`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async importSkill(file?: File, content?: string, nameOverwrite?: string): Promise<any> {
    const fd = new FormData();
    if (file) fd.append('file', file);
    if (content) fd.append('content', content);
    if (nameOverwrite) fd.append('name_overwrite', nameOverwrite);
    const res = await fetch(`${API_BASE_URL}/skills/import`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  async deleteSkill(skillName: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/skills/${encodeURIComponent(skillName)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  async reloadSkills(): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/skills/reload`, { method: 'POST' });
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

  // 6.1 剪映导出引擎自检（未安装时前端直接给出安装指引，而不是点了按钮才报错）
  async jianyinEngine(): Promise<{ installed: boolean; error?: string | null }> {
    const res = await fetch(`${API_BASE_URL}/projects/export-jianyin/engine`);
    if (!res.ok) return { installed: false, error: `HTTP ${res.status}` };
    return await res.json();
  },

  // 7. 系统配置
  async getConfig(): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/config`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async setupStatus(): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/system/setup-status`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async setupComplete(done: boolean = true): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/system/setup-complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done }),
    });
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
  async testConfig(    target: 'openai' | 'responses_api' | 'deepseek' | 'qwen' | 'minimax' | 'minimax_h3' | 'seedance' | 'kling' | 'wan3' | 'comfyui' | 'siliconflow' | 'dashscope' | 'elevenlabs' | 'cosyvoice' | 'gptsovits' | 'jianyin' | 'openai_image' | 'openai_video',
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

  // 8. 导演 Agent (LangChain 多轮+流式，双模式：chat问答/execute执行)
  async agentChat(prompt: string, context?: any, sessionId?: string, mode?: string, runMode?: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, context: context || {}, session_id: sessionId || undefined, mode: mode || 'execute', run_mode: runMode || 'approve' }),
    });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async agentChatStream(prompt: string, context?: any, sessionId?: string, onEvent?: (event: string, data: any)=>void, opts?: { signal?: AbortSignal; mode?: string; runMode?: string }): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/agent/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, context: context || {}, session_id: sessionId || undefined, mode: opts?.mode || 'execute', run_mode: opts?.runMode || 'approve' }),
      signal: opts?.signal,
    });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    if (!res.body || !onEvent) return await res.json();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let final: any = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') return final;
        try {
          const data = JSON.parse(dataStr);
          const ev = data.event || 'message';
          onEvent(ev, data);
          if (ev === 'agent_response') final = data;
        } catch {}
      }
    }
    return final;
  },
  async getAgentHistory(sessionId: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/agent/history?session_id=${encodeURIComponent(sessionId)}`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async clearAgentHistory(sessionId: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/agent/clear`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ session_id: sessionId }) });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  // v2 内核：一致性快照 / 运行中插话 / HTTP 审批回执 / 长期目标
  async agentSessionSnapshot(sessionId: string, tail = 200): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/agent/session/${encodeURIComponent(sessionId)}/snapshot?tail=${tail}`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async agentSteer(sessionId: string, prompt: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/agent/session/${encodeURIComponent(sessionId)}/steer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, context: {} }),
    });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  /** 运行模式热切换（WS 不可用时的 HTTP 兜底；切「自动」立即对当前轮生效并放行挂起审批） */
  async agentSetRunMode(sessionId: string, runMode: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/agent/session/${encodeURIComponent(sessionId)}/run_mode`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_mode: runMode }),
    });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async agentApprove(sessionId: string, approvalId: string, approved: boolean): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/agent/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, approval_id: approvalId, approved }),
    });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async agentSetGoal(sessionId: string, objective: string, maxRounds?: number): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/agent/session/${encodeURIComponent(sessionId)}/goal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ objective, max_rounds: maxRounds }),
    });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async creatorPropose(goal: string, context?: any): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/agent/creator/propose`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal, context: context || {} }),
    });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async creatorStart(proposalId: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/agent/creator/${encodeURIComponent(proposalId)}/start`, { method: 'POST' });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async creatorFinalize(proposalId: string, action: 'persist' | 'discard' | 'rollback'): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/agent/creator/${encodeURIComponent(proposalId)}/finalize`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async listCreatorTemplates(): Promise<{ templates: any[] }> {
    const res = await fetch(`${API_BASE_URL}/agent/creator/templates`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  // 分镜槽（storyboard_slots 聚合 + 项目覆盖 + 裸件 CRUD）
  async listStoryboardSlots(projectId?: string): Promise<any> {
    const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
    const res = await fetch(`${API_BASE_URL}/storyboard/slots${qs}`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async saveStoryboardOverrides(projectId: string, disabled: string[], order: Record<string, number>): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/storyboard/slots/project`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, disabled, order }),
    });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async deleteCustomStoryboardSlot(slot: string, sid: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/storyboard/slots/custom/${encodeURIComponent(slot)}/${encodeURIComponent(sid)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async listSkillVersions(skillName: string): Promise<{ skill: string; versions: Array<{ vid: string; mtime: number; size: number; source: string }> }> {
    const res = await fetch(`${API_BASE_URL}/skills/${encodeURIComponent(skillName)}/versions`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async getSkillVersion(skillName: string, vid: string): Promise<{ skill: string; vid: string; content: string }> {
    const res = await fetch(`${API_BASE_URL}/skills/${encodeURIComponent(skillName)}/versions/${encodeURIComponent(vid)}`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  // 9. 全链路编排
  async pipelineFullRun(params: {
    text: string; style_preset?: string; aspect_ratio?: string; custom_instructions?: string; max_images?: number;
    image_provider?: string; image_workflow_id?: string; audio_provider?: string;
    video_provider?: string; video_workflow_id?: string; enable_video?: boolean; max_videos?: number;
    gen_roles?: boolean; max_roles?: number;
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
        video_provider: params.video_provider,
        video_workflow_id: params.video_workflow_id,
        enable_video: params.enable_video ?? true,
        max_videos: params.max_videos ?? 6,
        gen_roles: params.gen_roles ?? true,
        max_roles: params.max_roles ?? 4,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(extractErrorMessage(res, body));
    }
    return await res.json();
  },

  // 9.1 一键成片 Agent（异步任务 + 轮询）
  async onekeyRun(params: {
    title?: string; text: string; style_preset?: string; aspect_ratio?: string; custom_instructions?: string;
    max_images?: number; image_provider?: string; image_workflow_id?: string; audio_provider?: string;
    video_provider?: string; video_workflow_id?: string; enable_video?: boolean; max_videos?: number;
    gen_roles?: boolean; max_roles?: number;
  }): Promise<{ task_id: string; status: string }> {
    const res = await fetch(`${API_BASE_URL}/onekey/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: params.title || '一键成片',
        text: params.text,
        style_preset: params.style_preset || 'donghua_xianxia',
        aspect_ratio: params.aspect_ratio || '9:16',
        custom_instructions: params.custom_instructions || '',
        max_images: params.max_images ?? 12,
        image_provider: params.image_provider,
        image_workflow_id: params.image_workflow_id,
        audio_provider: params.audio_provider,
        video_provider: params.video_provider,
        video_workflow_id: params.video_workflow_id,
        enable_video: params.enable_video ?? true,
        max_videos: params.max_videos ?? 6,
        gen_roles: params.gen_roles ?? true,
        max_roles: params.max_roles ?? 4,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(extractErrorMessage(res, body));
    }
    return await res.json();
  },
  async onekeyStatus(taskId: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/onekey/tasks/${encodeURIComponent(taskId)}`);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(extractErrorMessage(res, body));
    }
    return await res.json();
  },

  // ── Project 管理 (P0) ──
  async listProjects(params?: { q?: string; status?: string; sort?: string }): Promise<{ projects: any[]; total: number }> {
    const qs = new URLSearchParams();
    if (params?.q) qs.set('q', params.q);
    if (params?.status) qs.set('status', params.status);
    if (params?.sort) qs.set('sort', params.sort);
    const res = await fetch(`${API_BASE_URL}/projects?${qs.toString()}`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async createProject(params: { title: string; style_preset?: string; aspect_ratio?: string; description?: string }): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/projects`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(params) });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async getProject(projectId: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/projects/${encodeURIComponent(projectId)}`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async openProject(projectId: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/projects/${encodeURIComponent(projectId)}/open`, { method: 'POST' });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async deleteProject(projectId: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async duplicateProject(projectId: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/projects/${encodeURIComponent(projectId)}/duplicate`, { method: 'POST' });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async importProjectFile(file: File): Promise<{ project: any; content?: any }> {
    const fd = new FormData(); fd.append('file', file);
    const res = await fetch(`${API_BASE_URL}/projects/import`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async saveProjectContent(projectId: string, content: any): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/projects/${encodeURIComponent(projectId)}/content`, { method: 'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(content) });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async getProjectCanvas(projectId: string, canvasId?: string): Promise<any> {
    const qs = canvasId ? `?canvas_id=${encodeURIComponent(canvasId)}` : '';
    const res = await fetch(`${API_BASE_URL}/projects/${encodeURIComponent(projectId)}/canvas${qs}`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async saveProjectCanvas(projectId: string, snapshot: any, canvasId?: string, name?: string): Promise<any> {
    const body: any = { ...(snapshot || {}) };
    if (canvasId) body.canvas_id = canvasId;
    if (name) body.name = name;
    const res = await fetch(`${API_BASE_URL}/projects/${encodeURIComponent(projectId)}/canvas`, { method: 'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async listProjectCanvases(projectId: string): Promise<{ project_id: string; canvases: Array<{ id: string; name: string; updated_at: string; node_count: number }> }> {
    const res = await fetch(`${API_BASE_URL}/projects/${encodeURIComponent(projectId)}/canvases`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async renameProjectCanvas(projectId: string, canvasId: string, name: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/projects/${encodeURIComponent(projectId)}/canvases/${encodeURIComponent(canvasId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async deleteProjectCanvas(projectId: string, canvasId: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/projects/${encodeURIComponent(projectId)}/canvases/${encodeURIComponent(canvasId)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async getProjectAgentSessions(projectId: string): Promise<{ project_id: string; sessions: any[] }> {
    const res = await fetch(`${API_BASE_URL}/projects/${encodeURIComponent(projectId)}/agent-sessions`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async saveProjectAgentSessions(projectId: string, sessions: any[]): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/projects/${encodeURIComponent(projectId)}/agent-sessions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessions }),
    });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async deleteProjectAgentSession(projectId: string, sessionId: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/projects/${encodeURIComponent(projectId)}/agent-sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  // ── 素材库 Asset Library ──
  async listAssets(params?: { category?: string; status?: string; tag?: string; q?: string; project_id?: string; scope?: string; include_shared?: boolean; page?: number; limit?: number; sort?: string }): Promise<{ assets: any[]; total: number; page: number; limit: number; has_more?: boolean }> {
    const qs = new URLSearchParams();
    if (params) Object.entries(params).forEach(([k, v]) => { if (v != null && v !== '' && (k!=='scope' || v!=='all')) qs.set(k, String(v)); else if(k==='scope'&&v==='all'){} else if(v!=null) qs.set(k,String(v)); });
    const res = await fetch(`${API_BASE_URL}/assets?${qs.toString()}`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async getAsset(assetId: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/assets/${encodeURIComponent(assetId)}`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async createAsset(form: FormData): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/assets`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async updateAsset(assetId: string, form: FormData): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/assets/${encodeURIComponent(assetId)}`, { method: 'PUT', body: form });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async deleteAsset(assetId: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/assets/${encodeURIComponent(assetId)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async duplicateAsset(assetId: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/assets/${encodeURIComponent(assetId)}/duplicate`, { method: 'POST' });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async generateAsset(params: {
    name: string; prompt: string; category?: string; style_preset?: string;
    provider?: string; workflow_id?: string; negative_prompt?: string; aspect_ratio?: string;
    seed?: number; tags?: string; dynamic_inputs?: Record<string, any>;
    project_id?: string; scope?: string;
  }): Promise<{ asset: any; generation: any }> {
    const fd = new FormData();
    fd.append('name', params.name);
    fd.append('prompt', params.prompt);
    fd.append('category', params.category || 'character');
    if (params.style_preset) fd.append('style_preset', params.style_preset);
    if (params.provider) fd.append('provider', params.provider);
    if (params.workflow_id) fd.append('workflow_id', params.workflow_id);
    if (params.negative_prompt) fd.append('negative_prompt', params.negative_prompt);
    if (params.aspect_ratio) fd.append('aspect_ratio', params.aspect_ratio);
    if (params.seed != null) fd.append('seed', String(params.seed));
    if (params.tags) fd.append('tags', params.tags);
    if (params.dynamic_inputs) fd.append('dynamic_inputs', JSON.stringify(params.dynamic_inputs));
    if (params.project_id) fd.append('project_id', params.project_id);
    if (params.scope) fd.append('scope', params.scope);
    const res = await fetch(`${API_BASE_URL}/assets/generate`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async batchImportAssets(files: File[], meta?: { category?: string; tags?: string; visual_prompt?: string }): Promise<{ imported: number; assets: any[]; errors: string[] }> {
    const fd = new FormData();
    files.forEach(f => fd.append('files', f));
    if (meta?.category) fd.append('category', meta.category);
    if (meta?.tags) fd.append('tags', meta.tags);
    if (meta?.visual_prompt) fd.append('visual_prompt', meta.visual_prompt);
    const res = await fetch(`${API_BASE_URL}/assets/batch`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async getAssetStats(): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/assets/stats`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async migrateCharacters(projectId: string, characters: any[]): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/assets/migrate/characters`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project_id: projectId, characters }) });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async shareAsset(assetId: string, params: { scope?: string; target_project_ids?: string[] }): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/assets/${encodeURIComponent(assetId)}/share`, { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(params) });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async copyAssetToProject(assetId: string, target_project_id: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/assets/${encodeURIComponent(assetId)}/copy`, { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ target_project_id }) });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  // 10. 系统原生文件夹选择器与资源管理器
  async browseFolder(opts?: { initialDir?: string; title?: string }): Promise<{ selected_path: string; cancelled: boolean }> {
    const res = await fetch(`${API_BASE_URL}/system/browse-folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initial_dir: opts?.initialDir, title: opts?.title || '请选择文件夹' }),
    });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  async openFolder(folderPath: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/system/open-folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_path: folderPath }),
    });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },

  // ── Provider 多源解耦 (P 新增) ──
  async listProviders(params?: { kind?: string; include_builtin?: boolean; scope?: string; production_only?: boolean }): Promise<{ providers: any[]; total: number }> {
    const qs = new URLSearchParams();
    if (params?.kind) qs.set('kind', params.kind);
    if (params?.include_builtin === false) qs.set('include_builtin', 'false');
    if (params?.scope) qs.set('scope', params.scope);
    if (params?.production_only) qs.set('production_only', 'true');
    const res = await fetch(`${API_BASE_URL}/providers?${qs.toString()}`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async getProvider(providerId: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/providers/${encodeURIComponent(providerId)}`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async createProvider(payload: { name: string; kind: string; language?: string; code: string; code_entry?: string; models?: string[]; default_model?: string; api_key?: string; description?: string; headers?: Record<string, string>; custom_headers?: Record<string, string>; params_schema?: any; input_schema?: any; output_schema?: any; capabilities?: string[] }): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/providers`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async getCodeTemplate(language: string, kind: string): Promise<{ template: string }> {
    const res = await fetch(`${API_BASE_URL}/providers/code/templates?language=${encodeURIComponent(language)}&kind=${encodeURIComponent(kind)}`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async upgradeProviderToCode(providerId: string, language: string = 'python'): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/providers/${encodeURIComponent(providerId)}/upgrade-to-code`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ language }) });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async updateProvider(providerId: string, patch: Record<string, any>): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/providers/${encodeURIComponent(providerId)}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(patch) });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async deleteProvider(providerId: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/providers/${encodeURIComponent(providerId)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async testProvider(providerId: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/providers/${encodeURIComponent(providerId)}/test`, { method: 'POST' });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  // 统一扩展注册表（聚合查看 + 统一执行 + 统一启停）
  async listExtensions(params?: { kind?: string; source?: string; q?: string; projectId?: string }): Promise<any> {
    const qs = new URLSearchParams();
    if (params?.kind) qs.set('kind', params.kind);
    if (params?.source) qs.set('source', params.source);
    if (params?.q) qs.set('q', params.q);
    if (params?.projectId) qs.set('project_id', params.projectId);
    const res = await fetch(`${API_BASE_URL}/extensions${qs.toString() ? `?${qs}` : ''}`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async getExtension(extId: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/extensions/${encodeURIComponent(extId)}`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async executeExtension(extId: string, args?: Record<string, any>, entry?: string, projectId?: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/extensions/execute`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: extId, args: args || {}, entry, project_id: projectId || undefined }),
    });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async setExtensionEnabled(extId: string, enabled: boolean, projectId?: string): Promise<any> {
    const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
    const res = await fetch(`${API_BASE_URL}/extensions/${encodeURIComponent(extId)}/${enabled ? 'enable' : 'disable'}${qs}`, { method: 'POST' });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async uninstallExtension(extId: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/extensions/${encodeURIComponent(extId)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async extensionHealth(): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/extensions/health`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async checkExtensionId(kind: string, localId: string, publisher?: string): Promise<any> {
    const qs = new URLSearchParams({ kind, local_id: localId });
    if (publisher) qs.set('publisher', publisher);
    const res = await fetch(`${API_BASE_URL}/extensions/check-id?${qs}`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async importProvider(payload: { kind: string; name?: string; doc_text?: string; doc_url?: string; curl?: string; openapi_url?: string; api_key?: string; definition?: any; language?: string; code?: string }): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/providers/import`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async setProviderApiKey(providerId: string, api_key: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/providers/${encodeURIComponent(providerId)}/api-key`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ api_key }) });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  /** 代码源的生效配置：Key 来源（配置存储/代码内联/未配置）+ 代码里写死的常量 */
  async getProviderEffectiveConfig(providerId: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/providers/${encodeURIComponent(providerId)}/effective-config`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  /** 把代码里的内联 Key 迁到配置存储；rewrite_code=true 时同时改写代码改走 ctx */
  async migrateProviderInlineKey(providerId: string, rewrite_code = true): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/providers/${encodeURIComponent(providerId)}/migrate-inline-key`, {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ rewrite_code }),
    });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  // 插件系统 P0
  async listPlugins(): Promise<{ plugins: any[]; total: number }> {
    const res = await fetch(`${API_BASE_URL}/plugins`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async pluginSpec(): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/plugins/spec`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async installPlugin(file: File): Promise<any> {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`${API_BASE_URL}/plugins/install`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async setPluginEnabled(id: string, enabled: boolean): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/plugins/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async uninstallPlugin(id: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async reloadPlugin(id: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/plugins/${encodeURIComponent(id)}/reload`, { method: 'POST' });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async pluginsHealth(): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/plugins/health`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  // 自定义代码节点
  async listCustomNodes(kind?: string): Promise<{ nodes: any[]; total: number }> {
    const qs = kind ? `?kind=${encodeURIComponent(kind)}` : '';
    const res = await fetch(`${API_BASE_URL}/custom-nodes${qs}`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async getCustomNode(id: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/custom-nodes/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async runCustomNode(payload: { custom_node_id: string; inputs?: Record<string, any>; params?: Record<string, any>; project_id?: string }): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/custom-nodes/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async customNodeTemplates(): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/custom-nodes/templates`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  // 声明式画布节点（canvas_nodes 插件前端扩展点）
  async listCanvasNodes(projectId?: string): Promise<{ nodes: any[]; total: number }> {
    const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
    const res = await fetch(`${API_BASE_URL}/canvas-nodes${qs}`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async getCanvasNode(id: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/canvas-nodes/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async saveCanvasNode(spec: Record<string, any>): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/canvas-nodes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec) });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async deleteCanvasNode(id: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/canvas-nodes/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async runCanvasNode(payload: { canvas_node_id: string; inputs?: Record<string, any>; params?: Record<string, any>; project_id?: string }): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/canvas-nodes/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  // 主题包（themes）
  async listThemes(projectId?: string): Promise<{ themes: any[]; total: number }> {
    const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
    const res = await fetch(`${API_BASE_URL}/themes${qs}`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async saveTheme(spec: Record<string, any>): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/themes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec) });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async deleteTheme(id: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/themes/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  // 导出器（exporters）
  async listExporters(projectId?: string): Promise<{ exporters: any[]; total: number }> {
    const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
    const res = await fetch(`${API_BASE_URL}/exporters${qs}`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async saveExporter(spec: Record<string, any>): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/exporters`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec) });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async deleteExporter(id: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/exporters/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async runExporter(payload: { exporter_id: string; payload?: Record<string, any>; project_id?: string }): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/exporters/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  // 导演包（director_packs）
  async listDirectorPacks(projectId?: string): Promise<{ packs: any[]; total: number }> {
    const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
    const res = await fetch(`${API_BASE_URL}/director-packs${qs}`);
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async saveDirectorPack(spec: Record<string, any>): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/director-packs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec) });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
  async deleteDirectorPack(id: string): Promise<any> {
    const res = await fetch(`${API_BASE_URL}/director-packs/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(extractErrorMessage(res, await res.json().catch(() => null)));
    return await res.json();
  },
};
