# REQ-toonflow-canvas · 任务拆分

设计：`design.md`（同目录）。所有提交信息前缀 `REQ-toonflow-canvas`，新增或改动的关键代码注释写 `// REQ-toonflow-canvas <说明>`。
隔离实例：后端 `127.0.0.1:8001`（worktree 的 server/，用主仓库的 `.venv` 解释器），前端 `127.0.0.1:5180`（`VITE_API_ORIGIN=http://127.0.0.1:8001`），storage 用 worktree 自己的。

| 批次 | 任务 | 负责文件（只改这些） | 依赖 |
|---|---|---|---|
| W1 | **T1 节点框架 kit** | `client/src/components/canvas/kit/**`（新建）、`client/src/index.css`（只引入 `kit/theme.css`）、`client/package.json`（新增依赖） | — |
| W1 | **T2 媒体处理接口 + 画布备份接口** | `server/app/media/ops.py`、`server/app/api/media_ops_routes.py`（新建）、路由注册处、`server/app/api/project_routes.py`（只加 backup 路由）、`server/tests/test_media_ops.py`、`client/src/services/mediaOps.ts`（新建） | — |
| W1 | **T3 3D 场景模块抽取** | `Director3DStage.tsx` 拆出共用模块到 `client/src/components/director3d/scene/`（新建），行为不变 | — |
| W1 | **T4 旧画布迁移** | `client/src/components/canvas/migrate.ts` + `__tests__/migrate.test.ts`（新建） | design §2/§4/§7 |
| W1 | **T5 后端执行器与画布 MCP 兼容** | `server/app/canvas/engine.py`、`server/app/mcp/server.py`（只改 `canvas_*` 工具）、`server/tests/test_canvas_in_port.py` | design §4/§8 |
| W2 | N1 文本节点 `prompt` | `client/src/components/canvas/nodes2/text/**` | T1 |
| W2 | N2 图片 `load-image` + 图片生成 `image` | `nodes2/image/**` | T1、T2 |
| W2 | N3 视频 `load-video` + 视频生成 `video` | `nodes2/video/**` | T1、T2 |
| W2 | N4 音频 `load-audio` + 音频生成 `audio` | `nodes2/audio/**` | T1、T2 |
| W2 | N5 3D 导演 `director3d` | `nodes2/director3d/**` | T1、T3 |
| W2 | N6 独有节点换皮 A：shot-card、comfy-workflow、timeline、timeline-export、export | `nodes2/legacy-a/**`（可从 `nodes/` 搬运改写） | T1 |
| W2 | N7 独有节点换皮 B：script-split、brief、custom、ext-node、provider* | `nodes2/legacy-b/**` | T1 |
| W3 | **H1 宿主集成** | `CreativeCanvas.tsx` 及 `client/src/components/canvas/` 下其余宿主文件、`nodes2/index.ts`；删除被替代的旧节点文件 | W1、W2 |
| W4 | **E2E 测试 + 修复** | 按 `testing.md` | W3 |

每个任务完成标准：`cd client && npx tsc -b` 0 错、`npx vitest run` 全绿；后端任务 `pytest` 不新增失败；自测记录写进本目录 `progress/<任务号>.md`（做了什么、怎么验证、遗留问题）。
