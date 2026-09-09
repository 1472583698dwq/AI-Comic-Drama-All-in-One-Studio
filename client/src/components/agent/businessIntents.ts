// 业务意图即时预判（前端镜像，后端 /agent/plan/preview 为权威）
// 主链：小说->分镜->角色定妆->单镜(机位/生图/视频/配音)->批量一键->画布->剪映导出->素材

export type BusinessIntent =
  | 'script' | 'character' | 'shot_single' | 'batch_onekey'
  | 'canvas' | 'export' | 'asset' | 'debug' | 'chat';

const RULES: Array<{ intent: BusinessIntent; label: string; kws: string[]; risk: 'low'|'medium'|'high' }> = [
  { intent: 'batch_onekey', label: '批量/一键成片', kws: ['一键','整集','全片','批量','全自动','成片','多集','全部镜头'], risk: 'high' },
  { intent: 'script', label: '编剧拆解', kws: ['小说','拆解','分镜','剧本','章节','导入小说','解析','大纲'], risk: 'medium' },
  { intent: 'character', label: '角色定妆', kws: ['角色','定妆','三视图','立绘','人设','声线','音色','试音'], risk: 'medium' },
  { intent: 'canvas', label: '画布编排', kws: ['画布','节点','连线','编排','工作流','dag'], risk: 'medium' },
  { intent: 'export', label: '导出交付', kws: ['导出','剪映','capcut','草稿','jianyin'], risk: 'medium' },
  { intent: 'asset', label: '素材复用', kws: ['素材','找图','场景','道具','底图','预演','白模'], risk: 'low' },
  { intent: 'debug', label: '排障诊断', kws: ['状态','健康','连通','报错','失败','超时','工作流','provider','查错'], risk: 'low' },
  { intent: 'shot_single', label: '单镜制作', kws: ['生图','重绘','换图','视频','运镜','推镜','拉镜','环绕','配音','台词','机位','特写','当前镜','本镜','镜头','3d','导演'], risk: 'medium' },
];

export function detectLocalIntent(prompt: string, hasActiveShot: boolean): { intent: BusinessIntent; label: string; risk: string } {
  const p = (prompt || '').toLowerCase();
  if (!p.trim()) return { intent: 'chat', label: '问答讲解', risk: 'low' };
  if (p.length > 200 && !hasActiveShot) {
    // 长文本大概率是小说正文
    const hasKw = RULES.some(r => r.kws.some(k => p.includes(k.toLowerCase())));
    if (!hasKw) return { intent: 'script', label: '编剧拆解', risk: 'medium' };
  }
  for (const r of RULES) {
    if (r.kws.some(k => p.includes(k.toLowerCase()))) return { intent: r.intent, label: r.label, risk: r.risk };
  }
  if (hasActiveShot) return { intent: 'shot_single', label: '单镜制作', risk: 'medium' };
  return { intent: 'chat', label: '问答讲解', risk: 'low' };
}

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
  if (/超时|timeout/i.test(e)) return { what: `${toolName} 执行超时`, why: '生成类任务(尤其视频)常需60~300s，单次40s窗口不够', next: '改用异步：提交返task_id后轮询，或切更小分辨率/更短时长重试' };
  if (/未配置|API_KEY|鉴权|401/i.test(e)) return { what: `${toolName} 鉴权/配置缺失`, why: '对应Provider的Key或服务地址未填', next: '去配置页补Key后点测试连通，或换本地ComfyUI源' };
  if (/无法连接|ComfyUI|ECONN|refused/i.test(e)) return { what: '生成服务不可达', why: 'ComfyUI或云端地址不通', next: '检查服务是否启动/地址是否正确，或换硅基流动等云源' };
  if (/拒绝|超时自动拒绝|确认/i.test(e)) return { what: '敏感操作被跳过', why: '破坏性工具需人工确认', next: '在WS在线时重新下指令并在确认卡点允许' };
  return { what: `${toolName} 执行失败`, why: e.slice(0, 200), next: '重试一次，或换个Provider/调小参数再试' };
}
