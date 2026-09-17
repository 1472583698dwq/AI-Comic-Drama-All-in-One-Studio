// 业务意图即时预判（前端关键词镜像）已移除：模式约束与计划均由后端 runtime 代码门控完成，
// 前端不再做关键词路由，避免出现与用户意图无关的假计划。

export interface ArtifactInfo { kind: 'image'|'video'|'audio'; url: string; tool: string; label: string }

function pickUrl(obj: any, keys: string[]): string | null {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = (obj as any)[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v) && typeof v[0] === 'string' && v[0].trim()) return v[0].trim();
  }
  return null;
}

/** 从 tool_result 中提取可落地的产物（图/视频/音频），供产物卡渲染 + 一键应用到分镜 */
export function extractArtifact(toolName: string, result: any): ArtifactInfo | null {
  if (!result || typeof result !== 'object') return null;
  const img = pickUrl(result, ['image_url','imageUrl','url']) ;
  const vid = pickUrl(result, ['video_url','videoUrl']);
  const aud = pickUrl(result, ['audio_url','audioUrl']);
  // 按工具类型优先
  if (/image|comfyui|tts/i.test(toolName)) {
    if (toolName.includes('voice') || toolName.includes('tts')) {
      if (aud) return { kind: 'audio', url: aud, tool: toolName, label: '配音试音' };
    }
    if (img) return { kind: 'image', url: img, tool: toolName, label: '分镜画面' };
    if (aud) return { kind: 'audio', url: aud, tool: toolName, label: '配音' };
  }
  if (/video/i.test(toolName)) {
    if (vid) return { kind: 'video', url: vid, tool: toolName, label: '分镜视频' };
    if (img) return { kind: 'image', url: img, tool: toolName, label: '视频首帧' };
  }
  if (vid) return { kind: 'video', url: vid, tool: toolName, label: '视频' };
  if (img) return { kind: 'image', url: img, tool: toolName, label: '图片' };
  if (aud) return { kind: 'audio', url: aud, tool: toolName, label: '音频' };
  return null;
}

/** 结构化错误：what/why/next（前端兜底，后端透传优先） */
export function toStructuredError(toolName: string, raw: string): { what: string; why: string; next: string } {
  const e = String(raw || '未知错误');
  if (/超时|timeout/i.test(e)) return { what: `${toolName} 执行超时`, why: '工具窗口已放宽至20分钟；仍超时多为任务排队/服务端卡住', next: '改用异步：提交返task_id后轮询，或检查源服务负载后重试' };
  if (/未配置|API_KEY|鉴权|401/i.test(e)) return { what: `${toolName} 鉴权/配置缺失`, why: '对应Provider的Key或服务地址未填', next: '去配置页补Key后点测试连通，或换本地ComfyUI源' };
  if (/无法连接|ComfyUI|ECONN|refused/i.test(e)) return { what: '生成服务不可达', why: 'ComfyUI或云端地址不通', next: '检查服务是否启动/地址是否正确，或换硅基流动等云源' };
  if (/拒绝|超时自动拒绝|确认/i.test(e)) return { what: '敏感操作被跳过', why: '破坏性工具需人工确认', next: '在WS在线时重新下指令并在确认卡点允许' };
  return { what: `${toolName} 执行失败`, why: e.slice(0, 200), next: '重试一次，或换个Provider/调小参数再试' };
}
