# 接力文档 — Per-Node Agent 收口(节点内嵌控制台 · 单轨执行 · 真全局GO)

> **日期**:2026-09-01 晚 · **分支**:`main`(工作区含 09-01 白天未提交改动之上继续)  
> **目标**:补完白天接力文档宣称但未落地的 agent化:节点不再只是展示卡,全局 Bar 不再硬控节点,执行单轨化,导演 Agent 真能感知 48 源。

---

## 一、修了什么(四大断点对照)

| 断点 | 之前 | 现在 | 关键文件 |
|---|---|---|---|
| 节点是展示卡 | 选源/输Prompt/挂插槽/调参全在底部 FloatingBar,节点内只有徽标+按钮 | **NodeAgentBar 内嵌卡内**:技能Tab+源下拉+模型+插槽(挂载/多选/清除)+Prompt textarea+参数抽屉(DynamicControl)+生成↑+agent_state 行 | `client/src/components/canvas/NodeAgentBar.tsx`(新建) `nodes/MinimalNodes.tsx` |
| 双轨执行 | Bar 走 HTTP `generateShot*`,节点走 MCP,视频无轮询永不出片 | **唯一入口 `executeAgentNode`**:`provider_<id>` MCP Tool → 视频 task_id 轮询(前端双保险 + 后端 provider_ 分支已补轮询)→ 回写结果+`agent_state`;Bar 与节点同路径 | `hooks/nodeAgentExecutor.ts`(新建) `hooks/useNodeExecution.ts`(重写) `CreativeCanvas.tsx:264` `server/app/mcp/server.py:1049` |
| 技能=标签 | 点技能只换文案;`prompt_expansion` 空壳 | `SKILL_PRESETS`(必需插槽/禁用插槽/默认参数/forceMode)接进 AgentBar;`inferSkillForKind` 自动推荐;扩写走新后端 `/api/v1/llm/expand`(真 LLM) | `providerSkills.ts:216+` `server/app/api/routes.py` |
| 假 Agent 模式 | Bar"智能体"=规则式 dispatch-skill;导演Prompt 不认 provider_* | Bar 降权为**全局编排栏**:自然语言 GO → `/agent/chat`(LangChain 真 LLM,canvas_* 建链+执行,完成后 `agent-canvas-updated` 重载);`get_agent_system_prompt()` 动态拼全部 provider_* 工具清单+编排指引 | `FloatingAgentPromptBar.tsx`(重写) `routes.py:867+` `pipelines/agent/langchain_engine.py` |

## 二、结构决策

- **写穿透**:AgentBar 不持本地副本,所有输入直接 `updateNodeData(nodeId, …)`,旧 Bar 的 4 组 useEffect 同步/防回环逻辑整体删除,竞态根除。
- **agent_state 数据模型落地**:`{status: idle|running|completed|failed, tool, provider_id, error, elapsed_ms, updated_at}`;执行前 running(节点头像叠 spinner 遮罩),失败红字直接印在卡上,不再 `catch(()=>{})` 吞错。
- **降级策略**:MCP Tool `not found` 才回落旧 HTTP 通道;业务错误直接上抛进 agent_state。
- **视频轮询双保险**:后端 `provider_*` video 分支轮询 140×3s;前端 executor 仍检测 `task_id` 兜底轮询。
- **Prompt 节点/Director3D**:prompt 卡内 textarea+技能+执行(走 handleNodeExecute prompt 分支);director3d 卡内景别/运镜下拉+生成机位 Prompt 按钮。
- **FloatingBar 保留全局职责**:快速建 4 类核心节点、素材库、导出剪映;选中节点时仅提示"用卡内控制台",不再注入任何节点状态。

## 三、验证

- `npm run build`:2023 modules → `CreativeCanvas 162.7k` ✓
- `python -m compileall -q app` ✓
- `get_agent_system_prompt()` 含 13 个 `provider_*` 工具清单(dev 环境;生产 48 源)✓
- 未做端到端(需真实 ComfyUI/LLM key),冒烟建议见下

## 四、待办/风险

1. **冒烟清单**:图节点卡内选 `comfyui_wf_*`→挂参考→生成出图;连线视频→卡内生成(异步排队→spinner→出片);全局 GO 一句话长出 prompt→image→video 链;配音节点 `audio_clone` 挂参考音频。
2. `skill_id` 已从 MCP args 剔除,后端 `execute_node` 仍从 node.data 读取(未动)。
3. 导演 Agent 单次 GO 走 HTTP `/agent/chat`(无流式),长任务期间 Bar 显示"编排中";如需进度条可改 `/agent/chat/stream`(SSE 已有)。
4. 旧 `dispatch-skill` 路由保留为无 LLM 降级,但前端 Bar 已不再调用。
5. 08-28/09-01 接力文档中的 `FloatingBar 双模(手动/智能体)` 描述已过时,以本文为准。

## 五、回滚

- 全部改动在 5 个前端文件 + 3 个后端文件;删除 `NodeAgentBar.tsx`/`nodeAgentExecutor.ts` 并还原 `MinimalNodes.tsx`/`FloatingAgentPromptBar.tsx`/`useNodeExecution.ts`/`CreativeCanvas.tsx` + `git checkout` 后端三文件即可回到 13:11 构建水位。

*— 2026-09-01 重构组(晚) —*
