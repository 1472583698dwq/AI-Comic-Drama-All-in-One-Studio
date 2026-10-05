# 插件开发指南（Plugin / Extension Dev Guide）

> **适用版本**：Studio 2.x（2026-09）
> **读者**：想为工作台增加生成源 / 技能 / 节点 / 主题 / 导出器 / 扩展 MCP 工具的开发者
> **一句话**：写一个 `plugin.json` + 几个 JSON/Python 文件，打成 zip 安装启用，就能在画布、分镜、导演台、导出中心出现你的能力。

- 后端入口：`server/app/plugins/`（包管理与生命周期）、`server/app/extensions/`（统一扩展注册表与治理）
- 前端消费：声明式 DSL 由通用宿主渲染（`storyboard/slots/`、`canvas/nodes/ExtNode.tsx`、`ExportModal`、`Director3DStage`、`useThemeStore`）
- 存储：`storage/plugins/<id>/`、`storage/plugins/index.json`、`storage/extensions/state.json`

---

## 0. 5 分钟快速开始

**目标**：做一个插件包，给工作台加 1 个主题 + 1 个技能。

```
hello-pack/
  plugin.json
  themes/ink.json
  skills/hello-skill/SKILL.md
```

1）`plugin.json`

```json
{
  "id": "hello-pack",
  "name": "Hello 插件包",
  "version": "1.0.0",
  "description": "入门示例：主题 + 技能",
  "author": "you",
  "extensionPoints": {
    "themes": ["themes/*.json"],
    "skills": ["skills/*/SKILL.md"]
  }
}
```

2）`themes/ink.json`

```json
{
  "id": "ink",
  "name": "水墨",
  "mode": "all",
  "vars": { "--color-brand": "#0f766e", "--color-brand-light": "#14b8a6" }
}
```

3）`skills/hello-skill/SKILL.md`

```markdown
---
name: hello-skill
description: 把一句话扩写成镜头感描述
version: 1.0.0
author: you
category: prompt_optimization
tools: []
---

# 镜头感扩写
将用户输入扩写为包含景别、光影、构图的描述，直接输出结果。
```

4）打包安装

```powershell
Compress-Archive -Path hello-pack\* -DestinationPath hello-pack.zip
```

前端「设置 → 插件中心 → 安装 zip 包」→ 点「启用」；然后：
- 主题：设置 → 扩展中心 → 主题包条目 → 「应用主题」
- 技能：技能工坊列表出现（命名空间化为 `hello_pack__hello_skill`）

> 想加画布节点 / 导出器 / 分镜槽等，继续看第 4 节对应小节（都有完整可复制示例）。
> 提示：安装后不启用不会有任何效果；启用失败时接口会返回 `warnings` 数组，逐条看原因。

---

## 1. 概念与架构

插件体系分三层：

```
① 包管理层  server/app/plugins/manager.py
   discover → validate → install → enable ⇄ disable → uninstall / reload
   贡献落盘、产物追踪、精确回滚、热重载

② 统一门面  server/app/extensions/registry.py
   11 个 kind 聚合为 Extension；统一 查看 / 执行 / 启停 / 审计 / 遥测

③ 宿主层    前端各宿主消费声明
   分镜槽 / 画布节点 / 主题 / 导出器 / 导演台 / 生成源 / 技能 / 工作流 / 代码节点 / MCP 工具
```

### 1.1 扩展点全景

| 扩展点 | 包内文件 | 携带代码 | 宿主/UI 落点 | 执行方式 |
|---|---|---|---|---|
| `providers` | `providers/*.json` | ✅ Python/JS | 生成源管理、画布节点、分镜参数面板 | 受限沙箱（`trusted` 可越） |
| `skills` | `skills/*/SKILL.md` | ❌（提示词） | 技能工坊/Agent | LLM 分支 / 工具编排 |
| `workflows` | `workflows/*.json` | ❌（图） | ComfyUI 工作流库 + 自动生成 `comfyui_wf_*` 源 | ComfyUI 进程 |
| `custom_nodes` | `custom_nodes/*.json` | ✅ Python/JS（内联或 `code_file`） | 画布「自定义节点」 | 受限沙箱（`trusted` 可越） |
| `canvas_nodes` | `canvas_nodes/*.json` | ❌ 声明式 | 画布「扩展节点」 | 调可执行扩展 |
| `storyboard_slots` | `slots/*.json` | ❌ 声明式 | 分镜检查器 Tab/锚点/动作/模式 | 本地动作或调扩展 |
| `themes` | `themes/*.json` | ❌ | 扩展中心「应用主题」 | CSS 变量注入 |
| `exporters` | `exporters/*.json` | ❌ 声明式 | 导出中心 | 载荷装配 + 调扩展 |
| `director_packs` | `director_packs/*.json` | ❌ | 3D 导演台预设/背景/道具 | 纯前端消费 |
| `agent_profiles` | `agent_profiles/*.json` | ❌ 声明式 | 扩展中心「导演组成员」+ 子代理集群 | LLM 子代理（工具白名单） |
| `agent_teams` | `agent_teams/*.json` | ❌ 声明式 | 扩展中心「导演组」+ 一键成片导演组选择器 | 总导演编排脚本（playbook） |
| `mcp_tools` | `tools/*.py` | ✅ Python | Agent / MCP 工具面板 | **进程内直执行**（trusted 闸） |
| （plugin 本身） | `plugin.json` | — | 插件中心 | 包生命周期 |

### 1.2 "可执行扩展"与引用规则

`canvas_nodes` / `exporters` / `storyboard_slots` 的 `run.extension` 只能指向**可执行 kind**：

```
provider:<id>      生成源（entry 可传 image|video|audio 显式指定类型）
skill:<name>       技能
custom_node:<id>   代码节点（沙箱）
mcp_tool:<name>    插件查壳工具（trusted 闸）
```

扩展 id 规则：内置/裸件为 `kind:local_id`，插件来源为 `kind:publisher/local_id`（见第 6 节）。

---

## 2. 包结构与 plugin.json

### 2.1 目录规范

```
my-pack/
  plugin.json                # 必需，manifest
  providers/*.json           # 生成源
  skills/<name>/SKILL.md     # 技能
  workflows/*.json           # ComfyUI 工作流
  custom_nodes/*.json        # 代码节点
  canvas_nodes/*.json        # 声明式画布节点
  themes/*.json              # 主题变量包
  exporters/*.json           # 导出器
  director_packs/*.json      # 导演包
  agent_profiles/*.json      # 导演组成员（自定义专家角色）
  agent_teams/*.json         # 导演组（成员名单 + 编排脚本）
  slots/*.json               # 分镜槽
  tools/*.py                 # MCP 工具（Python）
  code/*.py                  # 真实代码文件（custom_nodes / providers 用 code_file 引用，推荐）
```

glob 支持子目录（如 `slots/**/*.json`）；包内路径**禁止** `..`、绝对路径、盘符。

### 2.2 manifest 字段

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
  "extensionPoints": { "...": ["..."] }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | `^[a-z0-9][a-z0-9-]{1,63}$`，全仓库唯一，决定安装目录名 |
| `name` | ✅ | 展示名 |
| `version` | ✅ | semver：`1.0.0`、`1.0.0-beta.1`、`1.0.0+build` |
| `publisher` | ❌ | 命名空间；缺省取 `author`，再缺省取 `id` |
| `dependsOn` | ❌ | 插件依赖 → 版本约束，支持 `* = > >= < <= ^ ~` |
| `extensionPoints` | ❌ | 各扩展点的包内相对路径 glob |
| `min_app_version` / `license` / `description` | ❌ | 元信息 |

**校验规则**（`validate_manifest_dict`）：
- 未知字段直接报错（`extra=forbid`），拼错字段名不会静默忽略
- 所有 extensionPoints 路径过统一围栏（`_safe_rel`）
- 单文件 ≤ 1MB；整包 ≤ 20MB；每类贡献 ≤ 20 项
- zip 解压逐条防路径穿越；`plugin.json` 允许在根或**单层子目录**

版本约束示例：

```json
"dependsOn": {
  "base-pack":   ">=1.0.0",
  "style-pack":  "^2.1.0",
  "util-pack":   "~0.3.2"
}
```

安装时要求依赖已安装且版本满足；启用时额外要求依赖已启用。

---

## 3. 生命周期、作用域与热重载

```
discover → validate → install → enable ⇄ disable → uninstall
                          └────── reload（热重载）──────┘
```

- **install**：先复制到 `.staging-*` 再原子 `rename` 落位；失败自动清理。
- **enable**：按扩展点逐类落地（见第 4 节），同时记录 `provider_ids / skill_names / workflow_ids / mcp_tools / custom_nodes / canvas_nodes / theme_ids / exporter_ids / director_pack_ids / agent_profile_ids / agent_team_ids / installed_files`。
- **disable**：**精确回滚**上述追踪产物（反注册源、删定义、删命名空间技能目录、反注册 MCP 工具），不留残留。
- **uninstall**：disable + 删除包目录与索引记录。
- **reload**：启用中插件 disable→enable 重读全部贡献；未启用仅重扫。

### 3.1 启停模型：原生 vs 覆盖层

| kind | 全局启停 | 项目级启停 |
|---|---|---|
| `plugin` | 原生（真实注册/反注册） | 覆盖层软停用（不动全局） |
| 自定义 `provider` | 原生（registry 注册/反注册） | 覆盖层软停用 |
| `skill/workflow/custom_node/canvas_node/theme/exporter/director_pack/agent_profile/agent_team/storyboard_slot/mcp_tool` | 覆盖层（`extensions/state.json`） | 覆盖层 |

生效停用集 = **全局 ∪ 项目**。内置常驻项不可全局停用（可项目级软停用）。

### 3.2 强制执行（不是只改 UI）

停用与项目作用域下沉到引擎入口（`app/extensions/guard.py`）：

| 引擎入口 | 覆盖 |
|---|---|
| `image/video/audio_registry.generate` | 生图/视频/配音 |
| `skill_engine.execute_skill` | 技能 |
| `run_custom_node` | 代码节点 |
| `run_plugin_tool` / 统一执行口 | 插件 MCP 工具（含 trusted 闸） |
| `workflow` 停用 | 连带其同步出的 `comfyui_*` 源 |
| `storyboard.slots.list_effective_slots` | 分镜槽聚合过滤 |
| `canvas_nodes.list_effective_nodes` | 画布节点工具栏过滤 |
| `themes/exporters/director_packs` | 运行时列表过滤 |
| `agent_profiles/agent_teams` | 运行时角色合并过滤（`list_effective_profiles/teams`） |

项目上下文传播：HTTP 中间件读 `?project_id=` / `X-Project-Id`，canvas/统一执行口显式注入。

### 3.3 热重载与存储

- 服务启动后台线程每 3s 扫描插件目录 mtime，变化自动 reload 启用中插件
- `STUDIO_PLUGIN_WATCH=0` 关闭监听；也可 `POST /api/v1/plugins/{id}/reload`
- 目录布局：

```
storage/plugins/<plugin_id>/            # 插件包实体
storage/plugins/index.json              # 生命周期索引（产物追踪）
storage/extensions/state.json           # 覆盖层启停（global/projects）
storage/{providers,custom_nodes,canvas_nodes,themes,exporters,director_packs,storyboard_slots,agent_profiles,agent_teams}/  # 各 kind 落盘
server/skills/.plugins/<plugin_id>/     # 命名空间化技能目录
```

---

## 4. 扩展点详解（含完整示例）

### 4.0 代码的两种写法（先读这一节）

涉及代码的扩展点（`providers` / `custom_nodes`）支持两种写法：

| 写法 | 字段 | 适用场景 | 说明 |
|---|---|---|---|
| 内联代码 | `"code": "async def ..."` | UI 表单创建、Agent 生成、API 直传、存量数据 | 整条定义是一条 JSON 数据，便于程序读写/回滚 |
| 真实文件 | `"code_file": "code/upscale.py"` | **插件包推荐** | JSON 只留元信息；代码是真文件，可 lint/diff/语法高亮；启用时读入，热重载时重读 |

规则：
- `code_file` 为**相对 `plugin.json`** 的包内路径，统一过路径围栏（禁 `..` / 绝对路径 / 盘符）
- 文件不存在、超过 1MB、扩展名与 `language` 不匹配 → 该条贡献告警跳过（不影响包内其他贡献）
- 两者同时存在：**内联 `code` 优先**，`code_file` 忽略并返回 warning
- 修改代码文件后：等待插件目录监听自动重载，或 `POST /api/v1/plugins/{id}/reload`
- 扩展名约定：`python` → `.py`；`javascript` → `.js` / `.mjs`

### 4.1 providers — 生成源（代码模式，唯一执行方式）

`ProviderDefinition` 关键字段：

| 字段 | 说明 |
|---|---|
| `id` / `name` | id 建议 `prov_xxx`；名称展示 |
| `kind` | `image` / `video` / `audio` / `llm` |
| `provider_type` | 代码模式建议 `"code"`（存在 `code` 即走代码执行器） |
| `language` | `python` / `javascript` |
| `code` | 完整源码，入口 `async def generate(ctx, api)`（JS：`async function generate(ctx, api)` + `module.exports = { generate };`） |
| `code_file` | 插件包推荐：包内真实代码文件路径（相对 `plugin.json`），启用时读入 `code` |
| `code_entry` | 入口函数名，默认 `generate` |
| `code_timeout` | 单次超时秒，默认 1200 |
| `trusted` | 是否申请跳出沙箱（须同时 `STUDIO_TRUSTED_MODE=1`） |
| `input_schema` | "连什么"：媒体插槽，`x-handle`/`x-slot`/`maxItems` |
| `params_schema` | "怎么生"：参数表单，`x-category`/`x-visibility`/`x-agent`/`x-priority` |
| `output_schema` | 产出句柄声明（画布连线校验用） |
| `default_params` | 参数默认值 |
| `capabilities` | 能力细分 `t2i/i2i/reference/t2v/i2v/r2v/start_end/tts/clone/chat` |

**完整示例（Python 生图，含参数注释契约）**：

```json
{
  "id": "prov_flux_demo",
  "name": "FLUX Demo",
  "kind": "image",
  "provider_type": "code",
  "language": "python",
  "code_entry": "generate",
  "code_timeout": 1200,
  "trusted": false,
  "code": "import httpx\n\nasync def generate(ctx, api):\n    headers = {\n        \"Authorization\": f\"Bearer {ctx['api_key']}\",\n        \"Content-Type\": \"application/json\",\n        **(ctx.get('headers') or {}),\n    }\n    payload = {\n        \"model\": ctx.get('model') or 'flux-schnell',\n        \"prompt\": ctx['prompt'],\n        \"image_size\": f\"{ctx.get('width', 720)}x{ctx.get('height', 1280)}\",\n        \"seed\": ctx.get('seed'),\n    }\n    async with httpx.AsyncClient(timeout=1200) as client:\n        resp = await client.post('https://api.example.com/v1/images', headers=headers, json=payload)\n        resp.raise_for_status()\n        data = resp.json()\n    image_url = (data.get('data') or [{}])[0].get('url') or data.get('image_url')\n    if not image_url:\n        raise RuntimeError(f'未找到 image_url: {str(data)[:500]}')\n    return {\"image_url\": image_url}\n# PARAMS_SCHEMA: {\"type\":\"object\",\"properties\":{\"resolution\":{\"type\":\"string\",\"title\":\"分辨率\",\"enum\":[\"480p竖\",\"720p竖\",\"1080p竖\"],\"default\":\"720p竖\",\"x-category\":\"layout\",\"x-visibility\":\"basic\",\"x-agent\":\"auto\",\"x-priority\":20},\"steps\":{\"type\":\"integer\",\"title\":\"采样步数\",\"default\":28,\"minimum\":8,\"maximum\":50,\"x-category\":\"quality\",\"x-visibility\":\"advanced\",\"x-agent\":\"suggest\"}}}",
  "input_schema": {
    "type": "object",
    "properties": {
      "prompt": {"type": "string", "description": "画面提示词", "x-handle": "text", "x-role": "prompt"},
      "negative_prompt": {"type": "string", "description": "负向提示词", "x-handle": "text", "x-role": "prompt_aux"},
      "reference_images": {"type": "array", "items": {"type": "string", "format": "uri"}, "description": "参考图", "x-handle": "image", "x-slot": "reference_images", "maxItems": 2}
    },
    "required": ["prompt"]
  },
  "output_schema": {"type": "object", "properties": {"image_url": {"type": "string", "format": "uri", "x-handle": "image"}}}
}
```

**同一份源的"真实文件"写法（插件包推荐）**：

`providers/flux_demo.json` 只留元信息：

```json
{
  "id": "prov_flux_demo",
  "name": "FLUX Demo",
  "kind": "image",
  "provider_type": "code",
  "language": "python",
  "code_file": "code/flux_demo.py",
  "code_entry": "generate",
  "trusted": false,
  "input_schema": { "...": "同上" },
  "output_schema": { "...": "同上" }
}
```

`code/flux_demo.py` 是真实 Python 文件，内容就是上面的 `async def generate(ctx, api)` 函数体（含末尾 `# PARAMS_SCHEMA` 注释行）。

**ctx 字段（按 kind）**：

| kind | ctx 可用键 |
|---|---|
| image | `prompt` `negative_prompt` `width` `height` `size` `aspect_ratio` `resolution` `seed` `model` `style_preset` `reference_images` `dynamic_inputs` `headers` `api_key` |
| video | `prompt` `mode` `first_frame_url` `last_frame_url` `reference_images` `reference_videos` `reference_audios` `duration` `resolution` `aspect_ratio` `fps` `model` `dynamic_inputs` `headers` `api_key` |
| audio | `text` `voice_id` `emotion` `speed` `pitch` `model` `ref_audio_path` `headers` `api_key` |

**返回值契约**：
- image：`{"image_url": "https://..."}` 或 `{"b64_json": "..."}`（框架自动落盘）
- video：`{"video_url": "..."}` 或 `{"task_id": "..."}`（框架会经 TaskCenter 轮询，也允许代码内自行轮询）
- audio：`{"audio_url": "..."}` 或二进制响应直存 `/storage/`

**`api` 沙箱对象**：

| 键 | 说明 |
|---|---|
| `api.httpx` / `api.aiohttp` / `api.requests` | HTTP 客户端（沙箱内唯一网络通道） |
| `api.asyncio` / `api.json` / `api.re` / `api.time` / `api.uuid` | 常用标准库 |
| `api.download(url, prefix="gen")` | 下载到 `storage/` 并返回 `(url, path)` |
| `api.get_api_key()` | 取该源配置的 Key |
| `api.storage_dir` | `storage/generated` |

沙箱限制：
- 禁止导入 `os / subprocess / shutil / sys / socket / ctypes / signal / importlib / builtins / pickle / pathlib`
- 禁止源码模式 `os.system` / `subprocess.` / `shutil.` / `os._exit` / `sys.exit` / `ctypes` / `multiprocessing`（**trusted 可跳过**，但必须 `STUDIO_TRUSTED_MODE=1`）
- `x-agent` 缺省：`layout/motion→auto`、`quality→suggest`、`seed/api_key→manual`

**参数枚举与代码不一致时**：在代码最后一行加 `# PARAMS_SCHEMA: {...}` 合法 JSON 注释（优先级高于内置默认枚举）。

> 现成模板可直接取：`GET /api/v1/providers/code/templates?kind=image|video|audio&language=python|javascript`；也可在「设置 → 生成源 → 新建代码源」里生成后导出。

### 4.2 skills — 技能（提示词包）

`SKILL.md` frontmatter：

| 字段 | 说明 |
|---|---|
| `name` | 技能名（插件启用时会被重写为 `<插件id>__<原名>`） |
| `description` | 一句话说明（列表与 Agent 选择用） |
| `version` / `author` / `category` | 元信息 |
| `tools` | 可选，声明依赖的 MCP 工具名（如 `generate_image`） |

完整示例（`skills/prompt-cyberpunk/SKILL.md`）：

```markdown
---
name: prompt-cyberpunk
description: 赛博朋克风格提示词优化
version: 1.0.0
author: acme
category: prompt_optimization
tools: []
---

# 赛博朋克润色
## 定位
把用户描述改写为赛博朋克视觉提示词。
## 执行 SOP
1. 提取主体/动作/环境
2. 注入 `neon lights, cyberpunk, rain, hologram, chromatic aberration`
3. 保留原意，直接输出优化后的提示词
```

- **通用分支**：技能引擎把 `instructions` 作为 system prompt，调 `llm_service` 执行（零代码）。
- **工具编排分支**：内置特定名字（如 `novel-climax-enhancer`、`character-3view-consistency`、`jianyin-auto-assembly`）有硬编码工具链；插件技能一般走通用分支。
- **命名空间**：插件技能复制到 `server/skills/.plugins/<pid>/<pid>__<name>/`，可与同名内置技能并存。
- 调用方式：Agent、技能工坊、或 `skill:<name>` 作为扩展被节点/槽引用。

### 4.3 workflows — ComfyUI 工作流

直接把 ComfyUI 工作流 JSON 放进 `workflows/`。启用时：

1. `save_workflow` 校验入库（含 UI "Save" 格式 → API 格式自动转换）
2. 自动 sync 为独立生成源 `comfyui_wf_<workflow_id>`（出现在生成源列表/画布节点）
3. 自动探测暴露槽（`auto_detect_exposed_inputs`）；标准参数（prompt/aspect_ratio/steps/seed…）自动映射
4. 插件禁用时工作流与派生源一起回滚

> 工作流 JSON 体积容易超 1MB 限制？拆分 widget 或精简；必要时压缩 JSON。

### 4.4 custom_nodes — 代码节点（画布）

**与 4.5 `canvas_nodes` 的关系**（一句话：前者是"代码"，后者是"声明"）：

| | `custom_nodes` | `canvas_nodes` |
|---|---|---|
| 本质 | 一段可执行代码（Python/JS） | 一份 JSON 声明，**无代码** |
| 能力来源 | 自己的 `run(inputs, params, ctx)` | `run.extension` 指向可执行扩展（`custom_node:` / `provider:` / `skill:` / `mcp_tool:`） |
| 画布落点 | 工具栏「自定义节点」区 | 工具栏「扩展节点」区 |
| 典型用途 | 写一个真实算子（超分、特定模型调用） | 换皮/编排/预设（包装算子、拼参数映射） |
| 复用 | 一个 custom_node 可被多个 canvas_node 包装 | canvas_node 之间互不复用，只编排 |

示例包正是这套配合：`canvas_nodes/upscale_ext.json` 包装 `custom_nodes/upscale_demo.json`。

JSON 字段：

| 字段 | 说明 |
|---|---|
| `id` / `name` / `kind` | kind ∈ `image/video/audio/utility` |
| `language` | `python` / `javascript` |
| `code` | 内联源码，入口 `async def run(inputs, params, ctx)` / `async function run(inputs, params, ctx)` |
| `code_file` | 插件包推荐：包内真实代码文件路径（相对 `plugin.json`），启用时读入 `code`；与内联同时存在时**内联优先** |
| `code_entry` / `code_timeout` / `trusted` | 同 provider |
| `input_schema` | 输入槽（`x-handle` 决定句柄类型） |
| `params_schema` / `default_params` | 参数表单（同 provider 的 `x-*` 规范） |

Python 完整示例（**真实文件写法**）：

```json
{
  "id": "video_upscale_demo",
  "name": "视频超分（示例）",
  "kind": "video",
  "language": "python",
  "code_file": "code/video_upscale_demo.py",
  "code_entry": "run",
  "code_timeout": 1200,
  "trusted": false,
  "input_schema": {
    "type": "object",
    "properties": {
      "video": {"type": "string", "format": "uri", "x-handle": "video", "description": "输入视频"},
      "prompt": {"type": "string", "x-handle": "text", "description": "文本输入"}
    }
  },
  "params_schema": {
    "type": "object",
    "properties": {"scale": {"type": "integer", "default": 2, "description": "放大倍数"}}
  },
  "default_params": {"scale": 2}
}
```

`code/video_upscale_demo.py`：

```python
# 契约：async def run(inputs, params, ctx) -> dict
# ctx['api'] 为沙箱 api（httpx / download / storage_dir ...）

async def run(inputs: dict, params: dict, ctx: dict) -> dict:
    video = inputs.get("video") or inputs.get("video_url") or ""
    if not video:
        raise ValueError("缺少输入视频（请连入 video 句柄）")
    scale = params.get("scale", 2)
    # 真实实现（沙箱内网络请走 ctx['api']['httpx']）：
    # httpx = ctx["api"]["httpx"]
    # async with httpx.AsyncClient(timeout=1200) as client:
    #     resp = await client.post("https://api.example.com/upscale", json={"url": video, "scale": scale})
    #     data = resp.json()
    # return {"video_url": data["url"], "text": f"upscaled x{scale}"}
    return {"video_url": video, "text": f"upscaled x{scale}"}
```

> 也可以内联：把整个函数写成 `"code": "...\\n..."`（UI/Agent 生成与 API 直传走这条）。两者同时存在时内联优先。

JavaScript 示例（关键差异）：

```javascript
async function run(inputs, params, ctx) {
  const video = inputs.video || inputs.video_url || "";
  if (!video) throw new Error("缺少输入视频");
  const res = await fetch("https://api.example.com/upscale", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: video, scale: params.scale || 2 }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return { video_url: data.url };
}
```

- 返回统一为 `image_url / video_url / audio_url / text`，可在画布节点卡片内预览
- 同时注册 MCP 工具 `customnode_<id>`，Agent 可调用
- 沙箱/trusted 规则与 provider code 模式一致

### 4.5 canvas_nodes — 声明式画布节点

字段：

| 字段 | 说明 |
|---|---|
| `id` / `name` / `description` / `icon` / `color` / `kind` | 卡片外观；kind ∈ `image/video/audio/utility/text` |
| `inputs` | `{id,label,type,required,description}`，type ∈ `image/video/audio/text/any`，≤12 |
| `outputs` | 同上 + `from`：结果字段名（缺省同 id），≤8 |
| `params_schema` | 参数表单（复用 DynamicControl，支持 `x-*`） |
| `run` | `{extension, entry, args, map}` |

完整示例（包装同包代码节点 + provider 两种目标）：

```json
{
  "id": "flux_with_upscale",
  "name": "出图并超分",
  "description": "示例：声明式编排（生图 → 超分）",
  "icon": "Wand2",
  "color": "text-cyan-400",
  "kind": "image",
  "inputs": [
    {"id": "prompt", "label": "提示词", "type": "text", "required": true},
    {"id": "reference_images", "label": "参考图", "type": "image"}
  ],
  "outputs": [
    {"id": "image", "label": "图像", "type": "image", "from": "image_url"},
    {"id": "text", "label": "说明", "type": "text", "from": "text"}
  ],
  "params_schema": {
    "type": "object",
    "properties": {
      "scale": {"type": "integer", "title": "放大倍数", "default": 2, "minimum": 1, "maximum": 4}
    }
  },
  "run": {
    "extension": "custom_node:video_upscale_demo",
    "args": {"mode": "fast"},
    "map": {
      "prompt": "$in.prompt",
      "reference_images": "$in.reference_images",
      "scale": "$param.scale"
    }
  }
}
```

**参数装配顺序**：静态 `run.args` → 同名输入/参数默认透传 → `run.map` 显式覆盖。
`map` 表达式：`$in.<端口id>`、`$param.<参数键>`、其它按字面量。

**执行链**：画布「运行节点/DAG」→ 引擎 `ext-node` 分支 → 统一执行口（停用审计 + 沙箱/trusted）→ 输出端口按 `from` 映射，同时把 `image_url/video_url/audio_url/text` 回写节点。若目标是视频源，`task_id` 会经 TaskCenter 阻塞到终态。

**引用 provider 的写法**：

```json
"run": {"extension": "provider:prov_flux_demo", "entry": "image",
        "map": {"prompt": "$in.prompt", "reference_images": "$in.reference_images"}}
```

### 4.6 storyboard_slots — 分镜工作台槽

四个容器：`shot.modes | shot.tabs | shot.anchors | shot.actions`。公共字段：

| 字段 | 说明 |
|---|---|
| `slot` / `id` / `label` / `icon` / `color` / `order` | 定位与外观；id `^[a-z0-9][a-z0-9_-]{1,47}$` |
| `when` | `{ "mode": [...], "not_mode": [...] }`，mode ∈ `comic/motion_comic/image_to_video` |
| `description` | 悬浮提示 |

**① shot.tabs（检查器 Tab）**

```json
{
  "slot": "shot.tabs",
  "id": "note-tab",
  "label": "批注",
  "icon": "📝",
  "order": 50,
  "when": {"mode": ["image_to_video", "motion_comic"]},
  "blocks": [
    {"kind": "info", "text": "镜头 {{shot.shot_index}} · {{shot.camera_framing}}"},
    {"kind": "shot_field", "field": "action_desc", "label": "动作描述"},
    {"kind": "buttons", "buttons": [
      {"label": "全要素合成", "run": {"store_action": "synthesizeShotPrompt"}},
      {"label": "镜头感润色", "run": {"extension": "skill:acme__prompt-cinematic-boost",
        "args": {"original_prompt": "{{shot.image_prompt}}"}}}
    ]}
  ]
}
```

**② shot.anchors（素材锚点卡片，写回分镜字段）**

```json
{
  "slot": "shot.anchors",
  "id": "lighting-anchor",
  "label": "灯光参考",
  "icon": "💡",
  "order": 40,
  "field": "lighting_prompt",
  "category": "scene"
}
```

`field` 必填；`category` 用于素材选择弹窗过滤（`character/scene/prop/effect/previz/all`）。

**③ shot.actions（批量操作按钮）**

```json
{
  "slot": "shot.actions",
  "id": "one-key-enhance",
  "label": "一键润色",
  "order": 40,
  "run": {"extension": "custom_node:prompt_polish", "args": {"prompt": "{{shot.image_prompt}}"}}
}
```

**④ shot.modes（新增制作模式，复用内置渲染）**

```json
{
  "slot": "shot.modes",
  "id": "fast_comic",
  "label": "⚡ 快速漫剧",
  "order": 40,
  "caps": {"canImage": true, "canVideo": true, "canTts": false,
           "direct": false, "needsFirstFrame": true, "lockPreview": null},
  "inherit_render": "image_to_video"
}
```

`caps` 必填且全布尔；`inherit_render` 指向内置模式（复用其状态块/动作栏）。

**模板变量**：`{{shot.<字段>}}`、`{{project.id}}`（递归替换进 `run.args`）。
**白名单本地动作**：`synthesizeShotPrompt`、`autoFitShotDuration`、`autoFitAllDurations`、`selectCandidate`（`selectCandidate` 需 `args.candidate_index`）。
**结果展示**：tab 内按钮执行成功后会显示 JSON 摘要 + 「写入首帧/视频/配音」回写按钮；锚点卡片选择素材即写回字段。

### 4.7 themes — 主题变量包

```json
{
  "id": "ink-drama",
  "name": "水墨漫剧",
  "description": "墨绿主色",
  "icon": "Palette",
  "mode": "all",
  "vars": {
    "--color-brand": "#0f766e",
    "--color-brand-light": "#14b8a6",
    "--color-brand-glow": "#2dd4bf"
  }
}
```

- `vars` 键必须是 `--xxx`（覆盖 `client/src/index.css @theme` 的同名令牌，直接影响 `bg-brand` 等工具类）
- `mode=dark|light` 时仅对应明暗模式生效；`all` 始终生效
- 应用/取消：设置 → 扩展中心 → 主题包条目；选择持久化在 `localStorage['ai_manju_plugin_theme']`
- 变量上限 200 个，值 ≤300 字符

### 4.8 exporters — 声明式导出器

```json
{
  "id": "srt_exporter",
  "name": "SRT 字幕导出",
  "description": "把全片台词导出为 SRT",
  "icon": "FileOutput",
  "accepts": ["project", "shots", "meta"],
  "run": {
    "extension": "mcp_tool:plugin_acme_srt_export",
    "map": {
      "project": "$project",
      "shots": "$shots",
      "title": "$meta"
    }
  }
}
```

- `accepts` ∈ `project | shots | characters | assets | meta`，只声明你需要的载荷
- `map` 目标键 → `$project/$shots/$characters/$assets/$meta` 或字面量；缺省按 accepts 同名注入
- 执行：前端导出中心按钮 → `POST /api/v1/exporters/run` → 载荷装配 → 统一执行口
- 结果展示优先级：`file_url`（下载/预览）→ `url` → `export_dir`（打开目录）→ 其余 JSON 摘要
- 适配 MCP 工具示例（`tools/srt_export.py`）：

```python
PLUGIN_TOOLS = [{
    "name": "srt_export",
    "description": "全片台词导出 SRT",
    "input_schema": {"type": "object",
                     "properties": {"project": {"type": "object"}, "shots": {"type": "array"}},
                     "required": ["project"]},
    "entry": "srt_export",
}]

def srt_export(args: dict, ctx: dict) -> dict:
    shots = args.get("shots") or (args.get("project", {}).get("scenes") or [])
    lines, idx = [], 1
    for sh in shots:
        text = (sh.get("dialogue") or sh.get("subtitle_text") or "").strip()
        if not text:
            continue
        start = float(sh.get("start_time") or 0)
        dur = float(sh.get("duration") or 3)
        lines.append(f"{idx}\n{_ts(start)} --> {_ts(start + dur)}\n{text}\n")
        idx += 1
    # 写文件到 storage/exports 并返回 file_url
    ...
    return {"file_url": "/exports/demo.srt", "count": idx - 1}

def _ts(sec: float) -> str:
    h, rem = divmod(int(sec), 3600); m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d},000"
```

### 4.9 director_packs — 导演台扩展包

```json
{
  "id": "wuxia-lite",
  "name": "武侠轻量导演包",
  "icon": "Clapperboard",
  "presets": {
    "framing": [{"id": "hero_low", "label": "英雄仰拍", "fl": 28, "desc": "低机位仰拍"}],
    "motion":  [{"id": "sword_dash", "label": "御剑突进", "category": "combo",
                 "desc": "低机位+前推", "minimaxCode": "Low Angle + Forward Tracking"}],
    "pose":    [{"id": "sword_pose", "label": "持剑式", "icon": "🗡️"}],
    "cast":    [{"id": "trio", "label": "三人成阵", "desc": "三角站位纵深"}]
  },
  "environments": [
    {"id": "bamboo", "label": "竹林", "icon": "🎋",
     "desc": "青翠竹海远景", "background_url": "/storage/scenes/bamboo.jpg"}
  ],
  "props": [
    {"id": "spirit_fruit", "label": "灵果", "icon": "🥑",
     "glb_url": "/models/Avocado.glb", "scale": 1.0}
  ]
}
```

- `presets` 四类：`framing`（需 `fl` 焦距）、`motion`（`category ∈ single|combo`，`minimaxCode` 供提示词）、`pose`（`icon`）、`cast`
- 预设合并进 `directorPresets.ts` 同源数组：**3D 舞台与画布 director3d 节点同时生效**
- `environments` 以远景背景板挂载（分镜 `scene_ref_image` 优先于包背景）
- `props` 直接按 GLB URL 加载，可选中/拖拽/持久化
- 注意：自定义预设 id 属本地语义；需要 MCP 精确控制时建议沿用内置 id（如 `medium/push_in/fight/solo`）

### 4.10 agent_profiles — 导演组成员（自定义专家子代理）

插件包内的角色画像，启用后进入运行时角色表，可被总导演/任意会话通过 `subagent_run(agent="<id>")` 委派。

```json
{
  "id": "colorist",
  "name": "上色师",
  "description": "分镜上色专家：何时委派我（给编排者看的一句话）",
  "icon": "Palette",
  "color": "pink",
  "system_prompt": "你是上色子代理：调用 onekey_shot_image(...) 完成上色，只输出结论。",
  "allow_tools": ["onekey_shot_image", "onekey_summary", "fs_read", "todo_write"],
  "deny_tools": [],
  "max_steps": 30,
  "background_default": false
}
```

字段与约束：

| 字段 | 说明 |
|---|---|
| `id` | 角色名（`subagent_run.agent` 取值），小写字母数字 `_` `-`，2~64 字符 |
| `name` / `description` | 展示名 / whenToUse（编排者据此决定是否委派） |
| `icon` / `color` | 前端集群 chip 样式；icon ∈ 白名单（Bot/Palette/Film/…），color ∈ purple/blue/green/pink/amber/cyan/orange/red/gray |
| `system_prompt` | 子代理系统提示（≤4000 字符） |
| `allow_tools` | **显式白名单且非空**；工具名必须在注册表内；**禁止 `subagent_*` 委派类工具**（代码强制，防无限套娃编排） |
| `deny_tools` | 额外拒绝项（在 allow 基础上叠加） |
| `max_steps` | 1~120，默认 40 |
| `background_default` | true=该角色默认后台化（适合长耗时角色） |
| `override` | 与内置角色重名时需显式 `true` 才允许替换（默认拒绝并在 `/agent-profiles` 的 `errors` 上报） |

- 生效链路：storage 落盘 → 运行时按 mtime 签名热重建 → `subagent_run` schema 的角色名单动态更新 → 集群面板显示自定义 icon/color
- 越权双闸：绑定层裁剪模型可见工具 + 执行口二次拒绝（`工具 X 不在子代理角色（Y）的能力范围内，已拒绝`）
- 手动管理 API：`GET/POST /api/v1/agent-profiles`、`GET/DELETE /api/v1/agent-profiles/{id}`、`GET /api/v1/agent-profiles/spec`（模板）

### 4.11 agent_teams — 导演组（成员名单 + 编排脚本）

声明一个可在一键成片中选择的导演组：成员约束 + 总导演 playbook + 默认参数 + 质检门。

```json
{
  "id": "quality-first",
  "name": "质量优先组",
  "description": "加双质检：导出前连贯性检查 + 导出后完整性复核",
  "icon": "Target",
  "color": "amber",
  "members": ["screenwriter", "storyboard_artist", "video_operator", "continuity_checker", "qa_reviewer"],
  "playbook": "执行一键成片任务。draft_id={draft_id}；标题：{title}；画幅 {aspect}。\n1. 调用 onekey_split(draft_id=\"{draft_id}\") 拆解；\n2. subagent_run(agent=\"storyboard_artist\", batch=[每镜一项]) 并行生图；\n3. subagent_wait(batch_id=视频批次) 收口后导出；\n4. onekey_summary 核对并输出总结。",
  "defaults": {"gen_roles": true, "enable_video": true, "max_images": 12},
  "qa_gate": true
}
```

- `members`：允许委派的角色 id 列表（内置或自定义画像）；非空时导演提示词注入「只能委派上述成员」硬约束；空数组 = 全员可用
- `playbook`：总导演编排脚本模板，占位符 `{draft_id}` `{title}` `{aspect}` `{max_images}` `{max_videos}`（未知占位符原样保留）；留空则用内置默认 6 阶段脚本
- `qa_gate: true`：在导出后追加一步**强制委派 `qa_reviewer` 质检**并把缺失/失败镜头清单纳入总结（需 `qa_reviewer` 在 members 内）
- `defaults`：仅前端弹窗选中该组时用于预填表单（可再手改）
- 停用/启用：扩展中心统一覆盖层（`agent_team:<id>`），项目作用域可用 `?project_id=`
- 手动管理 API：`GET/POST /api/v1/agent-teams`、`GET/DELETE /api/v1/agent-teams/{id}`、`GET /api/v1/agent-teams/spec`（模板）

### 4.12 mcp_tools — 插件 MCP 工具（Python）

契约：模块级 `PLUGIN_TOOLS` 声明列表 + 同模块入口函数。

```python
# tools/text_tools.py
PLUGIN_TOOLS = [
    {
        "name": "text_stats",
        "description": "统计文本字数/词数/行数",
        "input_schema": {
            "type": "object",
            "properties": {"text": {"type": "string", "description": "待统计文本"}},
            "required": ["text"],
        },
        "entry": "text_stats",
    },
    {
        "name": "text_slice",
        "description": "按字数截断文本",
        "input_schema": {
            "type": "object",
            "properties": {"text": {"type": "string"}, "limit": {"type": "integer", "default": 100}},
            "required": ["text"],
        },
        "entry": "text_slice",
    },
]

def text_stats(args: dict, ctx: dict) -> dict:
    text = str(args.get("text") or "")
    return {"chars": len(text), "words": len(text.split()), "lines": len(text.splitlines()) or 1}

def text_slice(args: dict, ctx: dict) -> dict:
    limit = int(args.get("limit") or 100)
    return {"text": str(args.get("text") or "")[:limit]}
```

- 注册名：`plugin_<插件id下划线化>_<name>`（工具名 `^[a-z0-9_]{2,48}$`）
- `ctx`：`{"plugin_id": ..., "tool": ...}`
- 执行闸门：**必须** `STUDIO_TRUSTED_MODE=1`（与 `fs_file/shell_exec` 同闸）；20 分钟超时；返回 JSON 超 20000 字符截断
- 无沙箱（与 provider 代码不同）：只安装可信来源的插件；不能在工具里做本地文件/命令操作时不建议直接写
- 多插件工具重名冲突会被跳过并写入 warnings

---

## 5. 执行与统一入口

`POST /api/v1/extensions/execute`

```json
{ "id": "provider:prov_flux_demo", "entry": "image",
  "args": {"prompt": "rainy street", "aspect_ratio": "9:16"},
  "project_id": "proj_xxx" }
```

| 参数 | 说明 |
|---|---|
| `id` | 扩展 id（`kind:local` / `kind:publisher/local`） |
| `entry` | 默认 `generate`；provider 可传 `image/video/audio` 显式指定类型 |
| `args` | 目标扩展的执行参数（provider 按请求字段拼装） |
| `project_id` | 项目作用域：覆盖层停用校验 + 引擎级 guard contextvar 同步生效 |

按 kind 路由：`skill` → 技能引擎；`custom_node` → 沙箱；`mcp_tool` → 查壳执行（trusted 闸）；`provider` → image/video/audio registry。

**返回结构**：至少 `{ status, extension, elapsed_ms }`，其余字段由执行器决定：
- provider image：`image_url/provider/engine/seed`
- provider video：`video_url/task_id/provider`
- provider audio：`audio_url/voice_id`
- custom_node：用户返回 dict + `custom_node_id/kind`
- skill：`SkillExecutionResult`（`status/result_message/tool_calls`）
- mcp_tool：结果 dict（超长截断）

可观测：`GET /extensions/health`（调用/错误/超时/错误率/unhealthy）、`/extensions/stats`、`/extensions/recent`。

---

## 6. 命名空间与去重

去重粒度：**(kind, publisher, local_id)** —— `provider:kling` 与 `skill:kling` 可共存。

| kind | 插件贡献的扩展 id |
|---|---|
| `provider` | `provider:<publisher>/<id>` |
| `workflow` | `workflow:<publisher>/<id>` |
| `custom_node` | `custom_node:<publisher>/<id>` |
| `canvas_node` | `canvas_node:<publisher>/<id>` |
| `storyboard_slot` | `storyboard_slot:<publisher>/<slot>:<id>` |
| `theme` / `exporter` / `director_pack` / `agent_profile` / `agent_team` | `<kind>:<publisher>/<id>` |
| `skill` | `skill:<插件id>/<插件id>__<原名>`（文件也物理隔离） |
| `mcp_tool` | `mcp_tool:plugin_<插件id>_<name>`（自带前缀） |
| `plugin` | `plugin:<插件id>` |

内置/裸件保持 `kind:local_id`。查询去重：`GET /extensions/check-id?kind=&local_id=&publisher=`
卸载插件会精确回滚命名空间化后的技能目录与全部贡献。

---

## 7. HTTP API 参考

**插件包**（`/api/v1/plugins`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/plugins` | 列表（含贡献摘要、依赖、启用态） |
| GET | `/plugins/spec` | manifest 模板 + 扩展点说明 |
| POST | `/plugins/install` | 上传 zip 安装（multipart `file`） |
| POST | `/plugins/{id}/enable` / `disable` / `reload` | 生命周期 |
| DELETE | `/plugins/{id}` | 卸载 |
| GET | `/plugins/health` | 执行健康 |

**统一扩展**（`/api/v1/extensions`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/extensions?kind=&source=&q=&project_id=` | 聚合列表 + kinds 元信息 |
| GET | `/extensions/counts` / `health` / `stats` / `recent` | 统计 |
| GET | `/extensions/check-id?kind=&local_id=&publisher=` | 命名空间去重检查 |
| GET | `/extensions/{id}` | 详情 |
| POST | `/extensions/execute` | 统一执行 |
| POST | `/extensions/{id}/enable` / `disable?project_id=` | 统一启停 |
| DELETE | `/extensions/{id}` | 统一卸载（plugin/自定义 provider） |

**各 kind 内容管理**

| kind | 路径 | 说明 |
|---|---|---|
| 生成源 | `/providers`（CRUD/test/模板/导入） | 代码源模板 `GET /providers/code/templates` |
| 代码节点 | `/custom-nodes`（list/get/run/templates） | 执行 `/custom-nodes/run` |
| 画布节点 | `/canvas-nodes`（list/spec/get/save/delete/run） | 面板用 `include_disabled=1` |
| 主题 | `/themes`（list/spec/get/save/delete） | |
| 导出器 | `/exporters`（list/spec/get/save/delete/run） | |
| 导演包 | `/director-packs`（list/spec/get/save/delete） | |
| 导演组成员 | `/agent-profiles`（list/spec/get/save/delete） | list 附带 `catalog`（含内置）与重名 `errors` |
| 导演组 | `/agent-teams`（list/spec/get/save/delete） | 保存时校验成员必须存在 |
| 分镜槽 | `/storyboard/slots`、`/storyboard/slots/catalog`、`PUT /storyboard/slots/project`、`POST/DELETE /storyboard/slots/custom` | 项目覆盖 disabled/order |

---

## 8. 调试与排错

**日志**：后端控制台会打印 `[Providers] Loaded N custom providers`、`[Main] Plugin routes mounted`、`[Main] Plugin file watcher started` 等；插件启用返回的 `warnings` 是首要线索。

**常见错误**：

| 现象 | 原因 | 处理 |
|---|---|---|
| 安装失败：缺少 plugin.json | zip 内是嵌套多层目录 | 保证 `plugin.json` 在根或单层子目录 |
| manifest 校验失败：字段非法 | 拼错字段/路径越界/id 或 semver 不合法 | 按报错逐条修正 |
| 启用报「缺少依赖插件」 | `dependsOn` 未安装/未启用 | 先安装并启用依赖 |
| 运行时「扩展不存在」 | id 拼错、未启用、命名空间不对 | `GET /extensions/check-id` 或扩展中心搜索 |
| 执行报「扩展已被停用」 | 全局或项目停用 | 扩展中心启用；注意项目级作用域 |
| 执行报「可信模式未开启」 | 调了 `mcp_tool` 或 `trusted: true` 源 | 在 `.env` 设置 `STUDIO_TRUSTED_MODE=1` 并重启 |
| provider 报 forbidden pattern | 沙箱禁用词命中 | 改用 `api.httpx`；或确需越权时设 `trusted` |
| 参数被拦截「未定义的参数」 | 参数不在 `params_schema` | 把参数加进 schema，或在代码尾 `# PARAMS_SCHEMA` 覆盖 |
| 工作流节点不生效 | 未同步/源未启用/暴露槽未探测 | Infra 页同步工作流；查看 `comfyui_wf_*` 源 |
| 修改文件不生效 | 监听被关/未启用 | 检查 `STUDIO_PLUGIN_WATCH`；`POST /plugins/{id}/reload` |

**手工调试**：

```python
# 安装/启用/禁用（在 server 目录执行）
from app.plugins import manager as pm
print(pm.install_from_dir("../plugins/example-drama-pack"))
print(pm.enable("example-drama-pack"))
print(pm.disable("example-drama-pack"))
```

```bash
# 扩展聚合与执行
curl http://127.0.0.1:8000/api/v1/extensions?kind=canvas_node
curl -X POST http://127.0.0.1:8000/api/v1/extensions/execute \
  -H "Content-Type: application/json" \
  -d '{"id":"canvas_node:upscale_ext","args":{"video":"/storage/videos/mock_578da233.mp4","scale":2}}'
```

---

## 9. 安全模型

| 贡献类型 | 沙箱 | 闸门 |
|---|---|---|
| provider `code` / custom_node（默认） | ✅ 受限（受控 import + 禁用词 + 超时线程隔离） | 无（可直接用） |
| provider `code` / custom_node（`trusted:true`） | ❌ 完整能力 | 必须 `STUDIO_TRUSTED_MODE=1` |
| `mcp_tools` | ❌ 进程内直执行 | 必须 `STUDIO_TRUSTED_MODE=1` |
| 其余声明式扩展点 | 不执行代码 | 受停用审计约束 |

- 只安装可信来源插件；`trusted` 是本地桌面端的显式"我知道在做什么"开关，默认关闭
- 插件可以读取环境变量中的 Provider Key（通过 `api.get_api_key()`），不要把密钥写进代码/声明
- 插件安装有大小与数量上限、zip 路径穿越防护；manifest 未知字段拒绝

---

## 10. 完整示例包解读（`plugins/example-drama-pack/`）

```
example-drama-pack/
  plugin.json                          # 声明扩展点
  skills/climax-booster/SKILL.md       # 通用技能（零代码）
  mcp_tools/text_stats.py              # 查壳工具 plugin_example_drama_pack_text_stats
  custom_nodes/upscale_demo.json       # 代码节点（code_file 引用真实文件）
  code/upscale_demo.py                 # 真实代码文件（async def run ...）
  canvas_nodes/upscale_ext.json        # 声明式画布节点（包装上面代码节点）
  themes/ink-drama.json                # 主题包
  director_packs/wuxia-lite.json       # 导演包（预设/背景/GLB 道具）
  agent_profiles/continuity_checker.json  # 导演组成员（自定义专家角色）
  agent_teams/quality-first.json       # 导演组（成员名单 + playbook + 质检门）
```

验证全链路步骤：

1. 打包：`Compress-Archive -Path plugins\example-drama-pack\* -DestinationPath example.zip`
2. 插件中心安装 → 启用（无依赖，直接成功）
3. 观察：
   - 技能列表出现 `example_drama_pack__climax_booster`
   - 画布工具栏出现「超分扩展节点」；「自定义节点」出现「视频超分演示」
   - 扩展中心出现 主题「水墨漫剧」/ 导演包「武侠轻量导演包」
   - 扩展中心出现 导演组成员「连贯性检查员」/ 导演组「质量优先组」；一键成片弹窗导演组下拉出现「质量优先组」
   - （开 trusted 后）MCP 工具面板出现 `plugin_example_drama_pack_text_stats`
4. 禁用：以上全部消失且存储无残留（精确回滚）
5. 卸载：包目录与索引记录删除

---

## 11. 本地开发、测试与发布

**后端回归（零依赖 stdlib unittest）**

```bash
python -m unittest discover -s server/tests -p "test_*.py" -v
```

插件相关用例：`test_extensions.py`（生命周期/命名空间/guard/遥测）、`test_canvas_nodes.py`、`test_frontend_extensions.py`。

**前端契约检查**：`cd client && npm run build`（tsc + vite）。

**发布检查清单**：

- [ ] `plugin.json` 字段完整、semver 已递增
- [ ] 所有 JSON 能被对应模型校验通过（安装启用时会逐个校验）
- [ ] 代码类贡献在沙箱内可运行（先 `trusted:false` 测）
- [ ] 名称/ID 不撞内置（`GET /extensions/check-id`）
- [ ] zip 体积 ≤20MB、单文件 ≤1MB、每类 ≤20 项
- [ ] 卸载后无残留（建议在干净 storage 上走一遍 enable → disable → uninstall）

---

## 12. FAQ

**Q：插件能改前端界面吗？**
A：只能通过声明式扩展点（分镜槽/画布节点/主题/导出器/导演包/导演组）间接影响 UI；不能注入 React 组件。

**Q：自定义导演组成员能拿到哪些工具？**
A：只能拿到 `allow_tools` 白名单里的工具，且必须是注册表内的真实工具；委派类 `subagent_*` 一律禁止（定义会被整体拒绝）。运行时绑定层裁剪 + 执行口二次拒绝双闸。

**Q：导演组 playbook 里能写什么？**
A：一段总导演编排脚本（≤8000 字符），可用 `{draft_id}`/`{title}`/`{aspect}`/`{max_images}`/`{max_videos}` 占位符；建议沿用「同步阻塞要结果 + 长耗时后台 + 关键节点 subagent_wait 收口」的既有范式。

**Q：能在插件里加新的模型 API 吗？**
A：能，用 `providers`（代码模式）。写 HTTP 调用 + 声明 schema，启用后自动成为生成源与 MCP 工具。

**Q：插件之间能互相调用吗？**
A：可以，通过扩展 id 引用：`run.extension: "provider:acme/myprov"`。建议在 manifest 里用 `dependsOn` 声明包级依赖；引用不会在安装期校验，执行期报错。

**Q：插件代码能访问本地文件/执行命令吗？**
A：默认不能（沙箱禁用 os/subprocess 等）。`trusted: true` + `STUDIO_TRUSTED_MODE=1` 后可，但等于赋予进程全部权限。

**Q：插件升级怎么做？**
A：当前需卸载后安装新版本（同 id 重复安装会被拒绝）。热重载只适用于直接修改已安装目录的场景。

**Q：为什么 MCP 工具名不是原名？**
A：统一加 `plugin_<插件id>_` 前缀，避免与其他插件/内置工具冲突。

---

*— 对应代码：`server/app/plugins/`、`server/app/extensions/`、`server/app/{canvas_nodes,themes,exporters,director_packs,agent_teams}/`、`client/src/components/storyboard/slots/`、`client/src/components/canvas/`。未落地与路线图见 `docs/未落地清单_2026-09-15.md`。*
