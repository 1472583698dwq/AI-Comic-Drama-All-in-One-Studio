# 插件开发指南（Plugin / Extension Dev Guide）

本项目的插件系统是 **代码插件 + 声明式扩展点 + 创造模式改/回滚**：
插件可以携带 Python 代码（provider / mcp_tool）、声明式资源（skill / workflow / custom_node / storyboard_slot），
统一收敛到「扩展注册表」对外呈现与执行。

- 后端入口：`server/app/plugins/`（包管理）、`server/app/extensions/`（统一门面）
- 存储：`storage/plugins/<id>/`、`storage/storage/plugins/index.json`、`storage/extensions/state.json`
- 相关 API 前缀：`/api/v1/plugins`、`/api/v1/extensions`

> ⚠️ 安全模型：插件代码在**服务进程内**执行，无沙箱。`mcp_tools` / provider `code` 模式的执行
> 需开启可信总闸（`STUDIO_TRUSTED_MODE=1`），与 `fs_file` / `shell_exec` 同一闸门。
> 只安装可信来源的插件包。

---

## 1. 包结构

```
my-pack/
  plugin.json                # 必需，manifest
  providers/*.json           # ProviderDefinition
  skills/<name>/SKILL.md     # 技能（frontmatter: name/description）
  workflows/*.json           # ComfyUI 工作流
  custom_nodes/*.json        # 代码节点（input_schema + params_schema + run）
  slots/*.json               # 分镜工作台槽（声明式 UI）
  tools/*.py                 # mcp_tools 查壳函数
```

打包为 zip（`plugin.json` 位于根或单层子目录）后，`POST /api/v1/plugins/install`
或前端「插件中心 → 安装 zip 包」安装。

## 2. plugin.json

```json
{
  "id": "my-drama-pack",
  "name": "我的漫剧包",
  "version": "1.0.0",
  "description": "一句话说明",
  "author": "you",
  "publisher": "you",
  "license": "MIT",
  "dependsOn": { "base-pack": ">=1.0.0" },
  "extensionPoints": {
    "providers": ["providers/*.json"],
    "skills": ["skills/*/SKILL.md"],
    "workflows": ["workflows/*.json"],
    "custom_nodes": ["custom_nodes/*.json"],
    "storyboard_slots": ["slots/*.json"],
    "mcp_tools": ["tools/*.py"]
  }
}
```

字段与约束：

| 字段 | 说明 |
|---|---|
| `id` | `^[a-z0-9][a-z0-9-]{1,63}$`，全仓库唯一，决定安装目录名 |
| `version` | semver，如 `1.0.0`（可带 `-beta.1` / `+build`） |
| `publisher` | 命名空间；缺省用 `author`，再缺省用 `id` |
| `dependsOn` | 依赖插件 → 版本约束。支持 `*` `=` `>` `>=` `<` `<=` `^` `~` |
| `extensionPoints.*` | 包内**相对路径** glob；禁止 `..` / 绝对路径 / 盘符 |

安全校验（`validate_manifest_dict`）：所有 extensionPoints 路径统一过 `_safe_rel` 围栏；
单文件 ≤ 1MB、整包 ≤ 20MB、每类贡献 ≤ 20 项。
未知字段会被拒绝（`extra=forbid`），拼写错误会直接报错。

### 版本约束示例

```json
"dependsOn": {
  "base-pack":   ">=1.0.0",   // 至少 1.0.0
  "style-pack":  "^2.1.0",    // 2.x 且 >=2.1.0
  "util-pack":   "~0.3.2"     // 0.3.x 且 >=0.3.2
}
```

安装时校验依赖已安装且版本满足；启用时额外校验依赖已启用。任一不满足即报错。

## 3. 生命周期与作用域

```
discover → validate → install → enable ⇄ disable → uninstall
                          └────── reload（热重载）──────┘
```

- **install**：原子安装（先 staging 复制再 rename 落位），失败自动清理。
- **enable / disable**：`plugin` 与自定义 `provider` 走**原生**启停（真实注册/反注册）；
  `skill / workflow / custom_node / mcp_tool / storyboard_slot` 走**覆盖层**启停
  （`storage/extensions/state.json`，执行时拒绝已停用项）。
- **作用域**：支持全局与项目两级（`project_id`）。
  - 全局：按 kind 走原生或覆盖层（内置常驻不可全局停用）。
  - 项目：**所有 kind** 统一写覆盖层「软停用」，不动全局注册状态；
    原生 kind 若全局本就停用，项目内启用不生效（响应带 `hint`）。
  - 生效停用集 = 全局 ∪ 项目。
- **强制执行（审计切面）**：停用/项目作用域不再只是注册表层，已下沉到引擎入口
  （`app/extensions/guard.py`）：
  - 生图/生视频/配音：`image/video/audio_registry.generate`
  - 技能：`skill_engine.execute_skill`
  - 代码节点：`run_custom_node`
  - 插件 MCP 工具：`run_plugin_tool`
  - 工作流：连带其同步出的 provider（`comfyui_*`）一起校验
  入口显式传 `project_id` 或用 contextvar 传播（HTTP 中间件读 `?project_id=`/`X-Project-Id`，
  canvas 执行注入项目上下文）；命中停用直接短路拒绝。
- **热重载**：服务启动后后台线程监听插件目录 mtime（`STUDIO_PLUGIN_WATCH=0` 可关），
  变化自动重载启用中的插件；也可手动 `POST /api/v1/plugins/{id}/reload`。

## 4. 扩展点

| 扩展点 | 形态 | 执行 |
|---|---|---|
| `providers` | ProviderDefinition JSON（推荐 `code` 模式 python/javascript） | `provider:*` 生成源 + MCP Tool，经沙箱体检 |
| `skills` | `SKILL.md`（frontmatter: name/description/tools） | 通用技能零代码生效 |
| `workflows` | ComfyUI 工作流 JSON | `save_workflow` 校验入库并 sync 为独立源 |
| `custom_nodes` | `{input_schema, params_schema, run}` JSON | 画布代码节点 + MCP Tool |
| `storyboard_slots` | 分镜槽声明 JSON | 分镜工作台槽宿主 |
| `mcp_tools` | `.py`：`PLUGIN_TOOLS` 列表 + 入口函数 | `plugin_<id>_<name>`，trusted 闸 + 20分钟超时 |
| `canvas_nodes` / `director_packs` / `exporters` / `themes` | — | **未落地（占位）**，声明会被记录但不执行 |

### 4.1 mcp_tools 查壳函数

```python
PLUGIN_TOOLS = [{
    "name": "text_stats",
    "description": "统计文本字数",
    "input_schema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
    "entry": "text_stats",
}]

def text_stats(args: dict, ctx: dict) -> dict:
    return {"chars": len(args.get("text", ""))}
```

注册名为 `plugin_<插件id>_<name>`。执行强制走 `_trusted_gate_or_raise()`，
20分钟超时，结果 20000 字符截断。

### 4.2 storyboard_slots 签名

```json
{
  "slot": "shot.tabs",
  "id": "note-tab",
  "label": "批注",
  "icon": "📝",
  "order": 50,
  "when": { "mode": ["image_to_video"] },
  "blocks": [
    {"kind": "info", "text": "{{shot.image_prompt}}"},
    {"kind": "shot_field", "field": "action_desc", "label": "动作"},
    {"kind": "buttons", "buttons": [{"label": "合成", "run": {"store_action": "synthesizeShotPrompt"}}]}
  ]
}
```

- `slot` ∈ `shot.modes | shot.tabs | shot.anchors | shot.actions`
- `id`：`^[a-z0-9][a-z0-9_-]{1,47}$`
- `when.mode` / `when.not_mode` ∈ `comic | motion_comic | image_to_video`
- `shot.tabs` 需 `blocks`（`info` / `shot_field` / `buttons`）
- `shot.anchors` 需 `field`
- `shot.actions` 需 `run`（`extension` 或白名单 `store_action`）
- `shot.modes` 需 `caps`（canImage/canVideo/canTts/direct/needsFirstFrame/lockPreview）+ `inherit_render`

白名单 `store_action`：`synthesizeShotPrompt`、`autoFitShotDuration`、
`autoFitAllDurations`、`selectCandidate`。
模板变量：`{{shot.<字段>}}`、`{{project.id}}`。

## 5. 扩展注册表 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/extensions?kind=&source=&q=&project_id=` | 聚合列表（含各 kind 元信息） |
| GET | `/api/v1/extensions/counts` | 各 kind 计数 |
| GET | `/api/v1/extensions/check-id?kind=&local_id=&publisher=` | 命名空间去重检查 |
| GET | `/api/v1/extensions/health` | 执行健康（次数/错误/超时/异常项） |
| GET | `/api/v1/extensions/stats` · `/recent` | 统计与最近执行 |
| POST | `/api/v1/extensions/execute` | 统一执行 `{id, args, entry, project_id}` |
| POST | `/api/v1/extensions/{id}/enable` · `/disable?project_id=` | 统一启停 |
| DELETE | `/api/v1/extensions/{id}` | 统一卸载 |

身份规则：全局 id = `kind:local_id`；**插件来源**且含命名空间时为
`kind:publisher/local_id`（物理隔离）。`publisher` 作为命名空间维度，
`check-id` 返回 `qualified = kind:publisher/local_id`。

## 6. 命名与去重

- 去重粒度是 **(kind, publisher, local_id)**：`provider:kling` 与 `skill:kling` 可共存。
- **物理命名空间**（插件来源自动加 publisher 维度）：
  - `provider` / `storyboard_slot` / `workflow` / `custom_node`：扩展 id 变为
    `kind:publisher/local_id`（如 `provider:acme/myprov`、`storyboard_slot:acme/shot.tabs:note`），
    内置/裸件保持 `kind:local_id` 不变。
  - `skill`：启用时把 SKILL.md 的 frontmatter `name` 重写为 `<插件id>__<原名>`
    （如 `acme__my-skill`），从技能引擎层就物理隔离，可与同名内置技能并存；
    扩展 id 为 `skill:<插件id>/<插件id>__<原名>`。
  - 插件包自身 id 与 `plugin_<id>_<name>` MCP 工具名已自带前缀，故不叠加。
- 归属判定：`provider/workflow/custom_node` 查插件索引的贡献列表，
  `skill` 优先按文件路径（`server/skills/.plugins/<pid>/…`）判定。
- 卸载插件会精确回滚其命名空间化后的技能目录与所有贡献，不留残留。

## 7. 本地开发与测试

```bash
# 后端回归（stdlib unittest，零依赖）
python -m unittest discover -s server/tests -p "test_*.py" -v

# 手动安装调试（zip 或目录）
python -c "from app.plugins import manager as pm; print(pm.install_from_dir('path/to/my-pack'))"
```

修改插件目录后，若服务在跑，监听线程会自动热重载；否则 `POST /plugins/{id}/reload`。
