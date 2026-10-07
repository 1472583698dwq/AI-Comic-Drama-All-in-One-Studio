# AI 视频生成平台 — 完整测试用例集

> **生成日期：2026-10-05（今天生成）**
> 覆盖版本：`multi_ai_simpleuse` 分支（merge `origin/master` @ `79c0945` 之后）
> 评估总目标：**视频生成的使用体验（易用性、流畅度、可预期性）与视频质量（画面、连贯性、音画同步）**

---

## 一、项目概览

本平台是"MiniMax AI 短剧/视频生成工作台"：

- **后端**：FastAPI（`server/app/`），所有业务路由挂载于 `/api/v1`，MCP 服务挂载于 `/mcp-server`
- **前端**：React（`client/`）
- **核心能力**：
  - 视频生成：7 个 provider（comfyui_video 本地兜底、minimax_h3、seedance、kling、wan3、openai_video/sora、minimax_video 旧版），支持 i2v/r2v/t2v 三种模式
  - 生图（首帧/角色三视图）：comfyui、siliconflow、dashscope、openai_compat
  - 配音 TTS：minimax、elevenlabs、cosyvoice、gptsovits、indextts
  - 一键成片 pipeline：剧本拆解 → 角色/场景图 → 分镜首帧 → 分镜视频 → 配音 → 导出
  - 时间线合片（MP4）、剪映草稿导出、资产管理、项目管理
  - Agent 对话/审批/SSE/WS、MCP 工具（约 40 个）、扩展/插件体系

## 二、文档结构

| 文件 | 内容 | 用例数 |
|---|---|---|
| `01-核心接口功能测试用例.md` | 视频/生图/TTS/Provider/配置等 API 功能与边界用例 | 40 |
| `02-端到端链路测试用例.md` | 生图→视频→配音→合片→导出的 E2E 与一键成片用例 | 20 |
| `03-视频质量与使用体验评估用例.md` | 最终交付维度的主观/客观质量与体验评估 | 25 |

## 三、优先级与类型定义

- **优先级**：P0（核心链路，阻塞发布）/ P1（重要功能）/ P2（次要/增强）
- **类型**：功能 / 边界 / 异常 / 兼容 / 性能 / 体验 / 质量
- **执行环境**：后端启动后访问 `http://127.0.0.1:<port>/api/v1/health` 确认就绪；测试前在 `PUT /config` 中配置至少一个真实视频 provider 的 API Key（如 MiniMax 或 Seedance），保留 `comfyui_video` 作为 Mock 兜底。

## 四、与已有自动化测试的关系

`server/tests/` 已覆盖 Agent 运行时、Provider 校验、时间线合并、剪映导出、一键成片默认链路等单元/集成逻辑。本用例集**聚焦以上空白点**：核心 `/videos/generate` 参数矩阵、`/videos/status` 轮询语义、图→视频质量链路、TTS、资产/项目 CRUD、MCP 工具、以及主观体验评估。

---

## 五、执行与证据

- 本用例集**自身不记录执行结果**；执行结果、证据（截图/产物/命令）与缺陷登记统一维护在
  [`../docs/测试用例执行记录_2026-10-07.md`](../docs/测试用例执行记录_2026-10-07.md)。
- 五类上下文文档与维护约定见 [`../docs/文档索引.md`](../docs/文档索引.md)。
