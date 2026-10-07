# 后端接口清单（API Reference）· MiniMax AI 漫剧 Studio

> 版本：v1 ｜ 更新日期：2026-10-07 ｜ 后端 App 版本：`2.1.0`
> 数据来源：`server/app/main.py` + `server/app/api/*.py` 全量扫描（装饰器逐模块核对）
> 关联：[`产品需求文档_PRD_v1.md`](产品需求文档_PRD_v1.md)、[`plugin-dev.md`](plugin-dev.md)、[`自定义源标准_参数与输入暴露规范_v1.md`](自定义源标准_参数与输入暴露规范_v1.md)

---

## 0. 全局约定

| 项 | 值 |
|---|---|
| App title | `MiniMax AI Comic Drama Studio` |
| App version | `2.1.0`（`server/app/main.py`；注意 `GET /api/status` 仍报 `2.0.0`，见 PRD T1） |
| 全局路由前缀 | **`/api/v1`**（`settings.API_V1_STR`，所有 `include_router` 统一带此前缀） |
| 模块级 prefix | **20 个路由模块的 `APIRouter()` 均无 path 前缀**，端点内自带完整子路径 |
| 交互文档 | `/docs`（Swagger UI，开放）、`/redoc`（开放）、`/openapi.json`（开放） |
| MCP 服务 | 挂载于 **`/mcp-server`**（FastMCP Streamable HTTP） |
| WebSocket | **`/api/v1/ws/agent`**（全项目唯一 WS，导演 Agent 实时通道） |
| 静态挂载 | `/storage`、`/exports`、`/assets` |
| SPA 兜底 | `GET /{full_path:path}`（跳过 api / docs / openapi.json / mcp-server / storage 等） |
| 安全 | `POST /api/v1/mcp/call`、`POST /api/v1/extensions/execute` 有 **Origin 白名单**（非本机 Origin → 403） |
| 页面/功能门控 | 部分模块带 `Depends(pages.require(...))` / `Depends(features.require(...))`；对应页/功能关闭时**该族端点整体返回 404**（下表表头已标注） |

**端点总数**：`app/api/` 合计 **205** + `main.py` App 级 **4** = **209**。

---

## 1. `api/routes.py` — 核心业务（74 个，含 1 个 WS）

### 1.1 Skills 技能工坊

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/skills` | 技能列表（默认仅可执行，`all=true` 含停用） |
| POST | `/api/v1/skills/execute` | 执行指定 Skill 并触发其 MCP 工具链 |
| GET | `/api/v1/skills/{skill_name}/raw` | 读取 SKILL.md 原文（编辑器无损往返） |
| POST | `/api/v1/skills/import` | 导入/覆盖 Skill（文件或文本） |
| DELETE | `/api/v1/skills/{skill_name}` | 删除 Skill 文件 |
| POST | `/api/v1/skills/reload` | 重载全部 Skills |
| GET | `/api/v1/skills/{skill_name}/versions` | Skill 版本历史 |
| GET | `/api/v1/skills/{skill_name}/versions/{vid}` | 读取指定 Skill 版本内容 |

### 1.2 剧本拆解 / 剪映导出

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/v1/projects/parse-script` | 调 MiniMax LLM 将小说拆解为角色 + 分镜剧本（未配 Key 返回 503） |
| GET | `/api/v1/projects/export-jianyin/engine` | 剪映导出引擎状态自检 |
| POST | `/api/v1/projects/export-jianyin` | 导出 pyJianYingDraft 剪映草稿工程 |

### 1.3 TTS 配音

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/tts/providers` | 音频 Provider 及健康状态 |
| GET | `/api/v1/tts/voices` | 音色库（可按 provider 过滤） |
| GET | `/api/v1/tts/voices/{provider_id}` | 指定 Provider 的音色库 |
| POST | `/api/v1/tts/generate` | 生成配音（返回可播放 mp3 URL） |

### 1.4 生图与 ComfyUI 工作流

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/images/providers` | 图片 Provider 及健康状态 |
| GET | `/api/v1/images/health` | 图片服务可用性检测 |
| POST | `/api/v1/images/generate` | 生成分镜图，返回本地图片 URL |
| POST | `/api/v1/images/character-3views` | 生成角色三视图（一致性提示词引擎） |
| GET | `/api/v1/images/workflows` | 工作流列表（all/internal/external） |
| GET | `/api/v1/images/workflows/external/dir` | 外部工作流目录路径 |
| GET | `/api/v1/images/workflows/{workflow_id}` | 工作流 JSON + 元数据 |
| DELETE | `/api/v1/images/workflows/{workflow_id}` | 删除内部工作流（外部只读） |
| POST | `/api/v1/images/workflows/import/{external_id}` | 外部工作流导入为内部 |
| POST | `/api/v1/images/workflows/{workflow_id}/refresh-app-contract` | 重读 ComfyUI App Mode 契约 |
| POST | `/api/v1/images/workflows/upload` | 上传工作流 JSON |
| PUT | `/api/v1/images/workflows/{workflow_id}/mapping` | 更新工作流槽位映射 |
| GET | `/api/v1/images/workflows/{workflow_id}/inspect` | 解析可配置节点/参数类型/可用模型 |
| POST | `/api/v1/images/workflows/{workflow_id}/preview` | 预览参数注入后最终 JSON（不提交） |
| POST | `/api/v1/images/workflows/{workflow_id}/overrides` | 保存槽位映射/节点覆写/暴露字段 |
| POST | `/api/v1/images/comfyui/upload` | 上传本地图片到 ComfyUI input 目录 |
| POST | `/api/v1/images/workflows/{workflow_id}/validate` | 向 ComfyUI 发起真实校验探测 |
| GET | `/api/v1/images/workflows/{workflow_id}/slots` | 列出工作流文件/参数槽位 |
| PUT | `/api/v1/images/workflows/{workflow_id}/node/{node_id}/{param_name}` | 设置单节点单参数覆写值 |
| POST | `/api/v1/images/workflows/compose` | 由片段拼接组合工作流 |

### 1.5 视频生成

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/videos/providers` | 视频 Provider 及健康状态 |
| GET | `/api/v1/videos/health` | 视频服务可用性检测 |
| GET | `/api/v1/videos/status/{task_id}` | 查询视频生成任务状态 |
| POST | `/api/v1/videos/generate` | 生成视频 |

### 1.6 MCP 工具

| 方法 | 路径 | 用途 | 安全 |
|---|---|---|---|
| GET | `/api/v1/mcp/tools` | 列出所有 MCP Tool 定义 | — |
| POST | `/api/v1/mcp/call` | 调用 MCP Tool | **Origin 白名单** |

### 1.7 LLM / 配置

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/v1/llm/expand` | LLM 提示词扩写 |
| GET | `/api/v1/config` | 读取全局配置（`unmask=false` 打码） |
| PUT | `/api/v1/config` | 保存配置并热重载 |
| POST | `/api/v1/config/test` | 测试配置连通性 |

### 1.8 Agent（导演 Agent 会话）

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/v1/agent/chat` | Agent HTTP 问答 |
| POST | `/api/v1/agent/chat/stream` | Agent 流式问答（SSE） |
| GET | `/api/v1/agent/history` | 会话历史 |
| POST | `/api/v1/agent/session/{session_id}/steer` | 运行中插话（v2） |
| POST | `/api/v1/agent/session/{session_id}/run_mode` | 运行模式热切换（HTTP 兜底） |
| POST | `/api/v1/agent/upload` | 附件上传（feature 门控 `agent_multimodal`） |
| GET | `/api/v1/agent/session/{session_id}/snapshot` | 一致性快照（断线续播） |
| POST | `/api/v1/agent/approve` | 审批回执入口 |
| POST | `/api/v1/agent/session/{session_id}/goal` | 设定长期目标 |
| GET | `/api/v1/agent/session/{session_id}/goal` | 获取长期目标 |
| DELETE | `/api/v1/agent/session/{session_id}/goal` | 清除长期目标 |
| POST | `/api/v1/agent/clear` | 清空会话记忆 |
| POST | `/api/v1/agent/creator/propose` | Creator 能力提案 |
| POST | `/api/v1/agent/creator/{proposal_id}/start` | 启动 Creator 测试 |
| POST | `/api/v1/agent/creator/{proposal_id}/finalize` | Creator 落地/丢弃/回滚 |
| GET | `/api/v1/agent/creator/proposals` | Creator 提案列表 |
| GET | `/api/v1/agent/creator/templates` | Creator 画布模板列表 |
| GET | `/api/v1/agent/creator/templates/{tid}` | 画布模板详情 |
| GET | `/api/v1/agent/mode/policy` | 运行模式/预算/工具风险策略 |
| GET | `/api/v1/agent/traces` | run 级审计列表 |
| GET | `/api/v1/agent/traces/{run_id}` | 单次 run 审计事件 |
| GET | `/api/v1/agent/runs` | 会话执行日志列表 |
| GET | `/api/v1/agent/runs/{session_id}/events` | 会话逐事件日志 |

### 1.9 WebSocket / 系统 / 云端同步

| 方法 | 路径 | 用途 |
|---|---|---|
| WS | `/api/v1/ws/agent` | Agent 实时 WebSocket 通道 |
| POST | `/api/v1/system/browse-folder` | 系统原生文件夹选择框 |
| POST | `/api/v1/system/open-folder` | 在资源管理器中打开目录 |
| GET | `/api/v1/storage-sync/status` | 云端同步状态 |
| POST | `/api/v1/storage-sync/scan` | 立即扫描本地 storage 入队 |
| POST | `/api/v1/storage-sync/pull` | 从云端拉齐工程/素材元数据 |

---

## 2. `provider_routes.py` — 生成源（14）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/providers` | 生成源列表（kind/scope/include_builtin/project_id/production_only 过滤） |
| GET | `/api/v1/providers/{provider_id}` | 单个生成源定义 |
| POST | `/api/v1/providers` | 新建生成源 |
| PUT | `/api/v1/providers/{provider_id}` | 更新生成源 |
| DELETE | `/api/v1/providers/{provider_id}` | 删除生成源 |
| POST | `/api/v1/providers/{provider_id}/test` | 测试连通性 |
| POST | `/api/v1/providers/import` | 从文档/cURL/OpenAPI 自动注册生成源 |
| GET | `/api/v1/providers/import/tasks/{task_id}` | 导入任务状态 |
| POST | `/api/v1/providers/{provider_id}/api-key` | 设置 API Key |
| GET | `/api/v1/providers/{provider_id}/effective-config` | 生效配置（合并不落盘项） |
| POST | `/api/v1/providers/{provider_id}/migrate-inline-key` | 内联 Key 迁移到独立存储 |
| GET | `/api/v1/providers/custom/stats` | 自定义生成源统计 |
| GET | `/api/v1/providers/code/templates` | 代码模板列表 |
| POST | `/api/v1/providers/{provider_id}/upgrade-to-code` | 存量 JSON 模板升级为代码 |

---

## 3. `project_routes.py` — 项目（19）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/projects` | 项目列表（关键词搜索） |
| POST | `/api/v1/projects` | 新建项目 |
| POST | `/api/v1/projects/import` | 导入项目 |
| GET | `/api/v1/projects/{project_id}` | 项目详情（元数据 + 内容合并） |
| PUT | `/api/v1/projects/{project_id}` | 更新项目元数据 |
| DELETE | `/api/v1/projects/{project_id}` | 删除项目 |
| POST | `/api/v1/projects/{project_id}/duplicate` | 复制项目 |
| POST | `/api/v1/projects/{project_id}/open` | 打开项目 |
| GET | `/api/v1/projects/{project_id}/export` | 导出项目（流式下载） |
| GET | `/api/v1/projects/{project_id}/content` | 获取项目内容 |
| PUT | `/api/v1/projects/{project_id}/content` | 保存项目内容 |
| GET | `/api/v1/projects/{project_id}/canvas` | 获取项目画布 |
| PUT | `/api/v1/projects/{project_id}/canvas` | 保存项目画布 |
| GET | `/api/v1/projects/{project_id}/canvases` | 列出项目所有画布 |
| PUT | `/api/v1/projects/{project_id}/canvases/{canvas_id}` | 重命名画布 |
| DELETE | `/api/v1/projects/{project_id}/canvases/{canvas_id}` | 删除画布 |
| GET | `/api/v1/projects/{project_id}/agent-sessions` | 项目 Agent 会话 |
| PUT | `/api/v1/projects/{project_id}/agent-sessions` | 保存 Agent 会话 |
| DELETE | `/api/v1/projects/{project_id}/agent-sessions/{session_id}` | 删除 Agent 会话 |

---

## 4. `asset_routes.py` — 素材（14，挂载于 `/api/v1/assets`）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/assets/stats` | 素材库统计 |
| GET | `/api/v1/assets/tags` | 标签搜索 |
| GET | `/api/v1/assets` | 素材列表（category 过滤；`scope=project/global/all`） |
| POST | `/api/v1/assets/batch` | 批量创建素材 |
| POST | `/api/v1/assets/clean-missing` | 清理悬空素材（先备份清单） |
| POST | `/api/v1/assets/generate` | 生成素材 |
| GET | `/api/v1/assets/{asset_id}` | 获取素材 |
| POST | `/api/v1/assets` | 创建素材 |
| PUT | `/api/v1/assets/{asset_id}` | 更新素材 |
| POST | `/api/v1/assets/{asset_id}/share` | 设为全局/共享到项目 |
| POST | `/api/v1/assets/{asset_id}/copy` | 复制素材到目标项目 |
| DELETE | `/api/v1/assets/{asset_id}` | 删除素材 |
| POST | `/api/v1/assets/{asset_id}/duplicate` | 原地复制素材 |
| POST | `/api/v1/assets/migrate/characters` | 迁移角色素材 |

---

## 5. `extension_routes.py` — 统一扩展注册表（11）

| 方法 | 路径 | 用途 | 安全 |
|---|---|---|---|
| GET | `/api/v1/extensions` | 扩展列表（kind/source 过滤） | — |
| GET | `/api/v1/extensions/counts` | 扩展计数（项目范围） | — |
| GET | `/api/v1/extensions/health` | 扩展健康 | — |
| GET | `/api/v1/extensions/stats` | 扩展统计 | — |
| GET | `/api/v1/extensions/recent` | 最近扩展事件 | — |
| GET | `/api/v1/extensions/check-id` | 校验扩展 ID 是否可用 | — |
| GET | `/api/v1/extensions/{ext_id:path}` | 扩展详情 | — |
| POST | `/api/v1/extensions/execute` | 统一执行扩展 | **Origin 白名单** |
| POST | `/api/v1/extensions/{ext_id:path}/enable` | 启用扩展 | — |
| POST | `/api/v1/extensions/{ext_id:path}/disable` | 停用扩展 | — |
| DELETE | `/api/v1/extensions/{ext_id:path}` | 卸载扩展 | — |

---

## 6. `agent_team_routes.py` — 导演组（10）｜门控 features.require("agent_teams")

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/agent-profiles` | 角色画像列表 |
| GET | `/api/v1/agent-profiles/spec` | 画像模板/契约 |
| POST | `/api/v1/agent-profiles` | 保存角色画像 |
| DELETE | `/api/v1/agent-profiles/{pid}` | 删除角色画像 |
| GET | `/api/v1/agent-profiles/{pid}` | 获取角色画像 |
| GET | `/api/v1/agent-teams` | 导演组列表 |
| GET | `/api/v1/agent-teams/spec` | 导演组模板/契约 |
| POST | `/api/v1/agent-teams` | 保存导演组 |
| DELETE | `/api/v1/agent-teams/{tid}` | 删除导演组 |
| GET | `/api/v1/agent-teams/{tid}` | 获取导演组 |

---

## 7. `plugin_routes.py` — 插件（9）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/plugins` | 插件列表 |
| GET | `/api/v1/plugins/spec` | 插件清单模板 + 扩展点文档 |
| POST | `/api/v1/plugins/install` | 安装插件（上传包） |
| POST | `/api/v1/plugins/reload` | 重载全部插件 |
| GET | `/api/v1/plugins/health` | 插件可观测（执行/错误/超时） |
| POST | `/api/v1/plugins/{pid}/reload` | 重载指定插件 |
| POST | `/api/v1/plugins/{pid}/enable` | 启用插件 |
| POST | `/api/v1/plugins/{pid}/disable` | 停用插件 |
| DELETE | `/api/v1/plugins/{pid}` | 卸载插件 |

---

## 8. `canvas_routes.py` — 画布（6）｜门控 pages.require("canvas")

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/v1/canvas/agent/generate` | 画布内 Agent 生成 |
| POST | `/api/v1/canvas/execute` | 执行画布 DAG |
| POST | `/api/v1/canvas/node/execute` | 执行画布单节点 |
| POST | `/api/v1/canvas/dispatch-skill` | 画布派发 Skill |
| GET | `/api/v1/canvas/assets` | 查询画布可用素材 |
| POST | `/api/v1/projects/{project_id}/canvas/execute` | 按项目维度执行画布（兼容） |

---

## 9. `canvas_node_routes.py` — 声明式画布节点（6）｜门控 pages.require("canvas")

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/canvas-nodes` | 声明式画布节点列表 |
| GET | `/api/v1/canvas-nodes/spec` | 节点声明模板/契约 |
| POST | `/api/v1/canvas-nodes` | 保存节点声明 |
| DELETE | `/api/v1/canvas-nodes/{nid}` | 删除节点声明 |
| GET | `/api/v1/canvas-nodes/{nid}` | 获取节点声明 |
| POST | `/api/v1/canvas-nodes/run` | 单次执行声明节点 |

---

## 10. `custom_node_routes.py` — 自定义代码节点（4）｜门控 pages.require("canvas")

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/custom-nodes` | 自定义代码节点列表 |
| GET | `/api/v1/custom-nodes/templates` | 代码节点模板 |
| GET | `/api/v1/custom-nodes/{nid}` | 获取自定义节点 |
| POST | `/api/v1/custom-nodes/run` | 单次执行自定义节点 |

---

## 11. `timeline_routes.py` — 时间线合片（4）｜门控 pages.require_any(["canvas","timeline"])

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/timeline/engine` | 引擎自检（ffmpeg 合片 + 剪映降级出口） |
| POST | `/api/v1/timeline/merge` | 提交合片任务（同步校验后返回 task_id） |
| GET | `/api/v1/timeline/tasks/{task_id}` | 查询合片任务 |
| POST | `/api/v1/timeline/draft` | 降级出口：导出剪映/CapCut 草稿 |

---

## 12. `storyboard_slot_routes.py` — 分镜槽（5）｜门控 pages.require("studio")

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/storyboard/slots` | 分镜槽生效清单 |
| GET | `/api/v1/storyboard/slots/catalog` | 内置槽位目录 |
| PUT | `/api/v1/storyboard/slots/project` | 保存项目级槽位覆盖 |
| POST | `/api/v1/storyboard/slots/custom` | 新建自定义槽 |
| DELETE | `/api/v1/storyboard/slots/custom/{slot}/{sid}` | 删除自定义槽 |

---

## 13. `theme_routes.py` — 主题包（5）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/themes` | 主题包列表 |
| GET | `/api/v1/themes/spec` | 主题模板/契约 |
| POST | `/api/v1/themes` | 保存主题包 |
| DELETE | `/api/v1/themes/{tid}` | 删除主题包 |
| GET | `/api/v1/themes/{tid}` | 获取主题包 |

---

## 14. `exporter_routes.py` — 导出器（6）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/exporters` | 导出器列表 |
| GET | `/api/v1/exporters/spec` | 导出器模板/契约 |
| POST | `/api/v1/exporters` | 保存导出器 |
| DELETE | `/api/v1/exporters/{eid}` | 删除导出器 |
| GET | `/api/v1/exporters/{eid}` | 获取导出器 |
| POST | `/api/v1/exporters/run` | 单次运行导出器 |

---

## 15. `director_pack_routes.py` — 导演包（5）｜门控 pages.require("director3d")

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/director-packs` | 导演包列表 |
| GET | `/api/v1/director-packs/spec` | 导演包模板/契约 |
| POST | `/api/v1/director-packs` | 保存导演包 |
| DELETE | `/api/v1/director-packs/{pid}` | 删除导演包 |
| GET | `/api/v1/director-packs/{pid}` | 获取导演包 |

---

## 16. `log_routes.py` — 日志（5）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/system/logs/tail` | 读取日志尾部 N 行 |
| GET | `/api/v1/system/logs/files` | 列出日志文件 |
| GET | `/api/v1/system/logs/download` | 下载主日志文件 |
| POST | `/api/v1/system/logs/frontend` | 前端错误上报入同一日志 |
| POST | `/api/v1/system/logs/level` | 运行期切换日志级别 |

---

## 17. `onekey_routes.py` — 一键成片（3）｜门控 pages.require_any(["studio","onekey"])

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/v1/onekey/run` | 一键成片 Agent 任务（异步） |
| GET | `/api/v1/onekey/tasks/{task_id}` | 查询一键任务状态 |
| GET | `/api/v1/onekey/tasks` | 列出最近一键任务 |

---

## 18. `setup_routes.py` — 安装向导（2）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/system/setup-status` | 安装向导状态 |
| POST | `/api/v1/system/setup-complete` | 标记向导完成 |

---

## 19. `feature_routes.py` — 功能开关（2）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/features` | 功能级开关快照 |
| PUT | `/api/v1/features` | 批量写功能开关 |

---

## 20. `page_routes.py` — 页面开关（1）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/pages` | 功能页运行时开关快照（**前端侧栏导航唯一依据**） |

---

## 21. `main.py` App 级端点（4）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/health` | 健康检查，返回图片/音频/视频 Provider 列表与数量 |
| GET | `/api/status` | 系统状态（版本 2.0.0、MCP 开关、docs_url） |
| GET | `/mobile` | 返回移动端 HTML 入口 |
| GET | `/{full_path:path}` | SPA 前端兜底 |

---

## 22. 端点统计

| 模块 | 数量 |
|---|---|
| `routes.py` | 74（含 1 WS） |
| `project_routes.py` | 19 |
| `provider_routes.py` | 14 |
| `asset_routes.py` | 14 |
| `extension_routes.py` | 11 |
| `agent_team_routes.py` | 10 |
| `plugin_routes.py` | 9 |
| `canvas_routes.py` / `canvas_node_routes.py` / `exporter_routes.py` | 各 6 |
| `storyboard_slot_routes.py` / `theme_routes.py` / `director_pack_routes.py` / `log_routes.py` | 各 5 |
| `timeline_routes.py` / `custom_node_routes.py` | 各 4 |
| `onekey_routes.py` | 3 |
| `setup_routes.py` / `feature_routes.py` | 各 2 |
| `page_routes.py` | 1 |
| **`app/api/` 合计** | **205** |
| `main.py` App 级 | 4 |
| **总计** | **209** |

---

## 23. 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-10-07 | v1 | 首次全量扫描生成（装饰器逐模块核对，与 205 处匹配一致） |
