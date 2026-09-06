---
name: provider-factory
description: 生成源工厂 v2.1（对齐 2026-09-02 自定义源标准 + H3 异步实战坑位）。按导演需求一键生成带 x-category/x-visibility/x-agent 分组的生成源，自动处理文件插槽、版式、人机分工与长任务异步契约。
version: 2.1.0
author: MiniMax Studio
category: ai_generation
tools:
  - register_custom_provider
  - list_custom_providers
  - get_provider_code
  - update_custom_provider
  - test_custom_provider
---

# 生成源工厂 v2 (Provider Factory — 对齐新标准)

## 技能定位
为导演台 Agent 提供“生成一个生成源”的标准化能力（v2 对齐 `docs/自定义源标准_参数与输入暴露规范_v1.md`）。用户说“给我建一个支持 3 张参考图 + 首帧的视频源”或“做一个 720p竖屏的生图源”，本技能负责把口语翻译成带 **分组与人机分工** 的 `ProviderDefinition`，并通过 `register_custom_provider` 落库，确保在**画布节点 Agent 控制台**与**分镜工作台**两端一致暴露。

## 核心变更（v1 → v2）
| 维度 | v1 | v2（现行） |
|---|---|---|
| 参数分组 | 扁平 `properties` | `x-category: layout/motion/quality/audio/advanced` 决定画布二级分组与分镜 Tab 过滤 |
| 暴露级别 | 全显 | `x-visibility: basic(常显)/advanced(需点⚙)/hidden(不渲)` |
| 人机分工 | 隐含 | `x-agent: auto(可自动代填)/suggest(建议需确认)/manual(仅手填)` + 前端徽标 `Agent可填/建议/手填` |
| 排序 | 字典序 | `x-priority 数值越小越靠前` |
| 文件插槽 | `input_schema` | 不变，仍 `format:uri + x-handle`，与 `params_schema` 严格分离 |

## 调用条件
- 用户意图含 `新建/生成/创建/注册 + 生成源|Provider|模型|源`，或 `支持几张图/几段音频/首尾帧`，或 `版式/分辨率/时长`，或 `让 Agent 按文件路径调用` 时**必须**走本技能。
- 已有源需改参时走 `get_provider_code` → `update_custom_provider` 增量补丁，而非重建。
- 禁止跳过 `list_custom_providers` 直接猜 `provider_id`。
- `kind=video` 且 API 为异步任务制（提交返 `task_id`、另有结果查询接口，如 AutoDL H3）时，**必须**同时执行本文 `异步视频源铁律` 章节（提交即返 + 查询分支 + 首帧映射），否则任务必然石沉大海。

## 输入参数（导演需收集/推断）
| 参数 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `kind` | enum `image/video/audio/llm` | 是 | 生成源类型 | `video` |
| `name` | string | 是 | 展示名，含 H3 等关键词便于检索 | `我的 H3 多图视频` |
| `description` | string | 否 | 一句话用途 | `支持首帧必选+3参考图` |
| `language` | enum `python/javascript` | 否 | 默认 `python` | `python` |
| `input_schema` | object | 是 | 文件插槽（prompt 与媒体） | 见下 |
| `params_schema` | object | 是 | 非文件参数（版式/运动/画质/声音）**必须带 x-* ** | 见下 |
| `code` | string | 否 | 完整 `async def generate(ctx, api)`，不填则由导演按文档生成 | - |
| `api_key` | string | 否 | 需鉴权时透传 | `sk-...` |

### input_schema 模板（严格分离，不放 steps/resolution 等）
```json
{
  "type": "object",
  "properties": {
    "prompt": {"type": "string", "description": "画面/台词", "x-handle": "text", "x-role": "prompt"},
    "first_frame": {"type": "string", "format": "uri", "x-handle": "image", "x-slot": "first_frame", "description": "首帧 1张", "maxItems": 1},
    "reference_images": {"type": "array", "items": {"type": "string", "format": "uri"}, "x-handle": "image", "x-slot": "reference_images", "description": "参考图 0-4张", "maxItems": 4, "minItems": 0},
    "ref_audio": {"type": "array", "items": {"type": "string", "format": "uri"}, "x-handle": "audio", "x-slot": "ref_audio", "description": "参考音频 0-2段", "maxItems": 2}
  },
  "required": ["prompt"]
}
```
- 单文件：`type: string, format: uri`；多文件：`type: array, items.format: uri, maxItems: N`
- `x-handle` 必须为 `text/image/audio/video`，前端据此渲染“几张/几段”徽标
- `prompt/text` 以外的**所有可量化参数禁止放入此**，应进 `params_schema`

### params_schema 模板（v2 必须带 x-*）
```json
{
  "type": "object",
  "properties": {
    "aspect_ratio": {"type": "string", "title": "画面比例", "enum": ["9:16","16:9","1:1"], "default": "9:16", "description": "输出比例", "x-category": "layout", "x-visibility": "basic", "x-agent": "auto", "x-priority": 10},
    "resolution": {"type": "string", "title": "分辨率", "enum": ["720p","1080p"], "default": "720p", "description": "分辨率档位", "x-category": "layout", "x-visibility": "basic", "x-agent": "auto", "x-priority": 20},
    "duration": {"type": "integer", "title": "时长", "default": 5, "minimum": 3, "maximum": 15, "x-category": "motion", "x-visibility": "basic", "x-agent": "auto", "x-priority": 30},
    "steps": {"type": "integer", "title": "采样步数", "default": 20, "minimum": 4, "maximum": 60, "x-category": "quality", "x-visibility": "advanced", "x-agent": "suggest", "x-priority": 40},
    "cfg": {"type": "number", "title": "CFG", "default": 7, "minimum": 1, "maximum": 15, "x-category": "quality", "x-visibility": "advanced", "x-agent": "suggest", "x-priority": 41},
    "voice_id": {"type": "string", "title": "音色", "x-category": "audio", "x-visibility": "basic", "x-agent": "auto", "x-priority": 5}
  }
}
```
- `x-category`: `layout(版式)/motion(运动时长)/quality(画质采样)/audio(声音)/advanced(兜底)` — 决定**画布二级分组标题**与**分镜 Tab 过滤**（`visual→layout+quality` `motion→motion` `dialogue→audio`）
- `x-visibility`: `basic` 常显（画布基础区/分镜首屏） `advanced` 需点⚙ `hidden` 仅代码可见
- `x-agent`: `auto` 可自动代填（用户改后不再覆盖） `suggest` 仅建议 `manual` 仅手填（seed/锁定项）
- `x-priority`: 同组内越小越靠前（保证 `aspect_ratio` 在 `resolution` 前）
- 若真实 API 枚举与此不同（如 `480p竖`），必须在 `register_custom_provider` 的 `params_schema` 中按真实枚举重写，框架不再猜测

## 执行 SOP（导演必循 v2）
1. **探查**：`list_custom_providers {kind, q}` 看是否已存在同名/同类源，避免重建。
2. **定参**：
   - 文件侧：按口语确定 `kind` + `多文件数量` → 组 `input_schema`（含 `maxItems`，`first_frame` 是否 `required`）。
   - 参数侧：按口语/项目画幅推断版式参数（`aspect_ratio/resolution` 必为 `layout/basic/auto`），按 API 文档确定枚举；画质类（`steps/cfg`）一律 `quality/advanced/suggest`；时长运动类一律 `motion/basic/auto`；音色 `audio/basic/auto`。缺省时用 `_default_params_schema` 的 v2 模板。
   - **video 异步 API**：`params_schema` 必须按该 API 真实枚举手写（如 H3 的 `480p竖/768p竖`），**禁止**套通用 `480p/720p` 模板（出网前护栏会直接拦截，见坑位 6）。
3. **生成**：若用户已给 `code`/`definition` 则 `register_custom_provider {kind,name,language,code,input_schema,params_schema}` 直建；否则 `register_custom_provider {kind,name,doc_text/curl,language,input_schema,params_schema}` 让 LLM 按本文模板生成。**禁止**把文件插槽塞进 `params_schema`。video 异步源的 `code` 必须套用下文异步模板（含查询分支），不可用同步模板。
4. **校验**：`get_provider_code {name/q}` 检视 `input_schema/params_schema` 是否含预期 `maxItems` 与 `x-*`；`test_custom_provider` 试连（仅语法+配置检查，零配额）。video 异步源加一步：**用一个历史真实 `task_id` 调查询分支验链路**（`shell_exec` 单次 GET 结果接口，或 provider 工具传 `task_id`+空 prompt），链路通后再花配额提交新任务。
5. **修复**：参数未暴露或分组错误则 `update_custom_provider {provider_id, params_schema/input_schema}` 增量补丁；`x-visibility:hidden` 的内部参数不会在两端显示但仍会透传。收不到结果类问题先查下文坑位表再改码。
6. **告知**：回复中明确“已生成 `id`，`input: 首帧必选 1张 / 参考图 0-3张`，`params: 基础 2项常显(比例/分辨率·Agent可填) 高级 2项需展开(步数/CFG·建议)`，已可在节点 Agent 下拉中选中”。video 异步源须加一句“提交后返 `task_id`，后台轮询约 N 分钟，经分镜/画布状态轮询取片”。

## 异步视频源铁律（H3 实战坑位，kind=video 且 API 为任务制时必读）

> 背景：AutoDL H3 类接口分两步 —— `POST .../comfyui_workflow/{workflow_id}` 提交返 `task_id`，
> `GET .../comfyui_workflow/result/{task_id}` 查询终态（约 100s）。以下 7 条是拿真实配额踩出来的，
> 违反任意一条都会“提交成功但永远收不到片”。

1. **提交即返，绝不在代码里阻塞等终态**。单工具 40s 即超时（`langchain_engine._exec_one`），
   代码里 `for _ in range(300): sleep(2)` 这类 10 分钟轮询必被掐死，任务在服务端跑完了结果也回不来。
   正确契约：提交成功立刻 `return {"video_url": None, "task_id": task_id, "status": "SUBMITTED"}`。
   框架侧（`GenericCodeVideoProvider`→代码任务表→后台轮询→`/videos/status`）会接管后半程，
   前端分镜/画布本来就会轮询状态接口。
2. **查询分支是另一条命，必须有且必须可达**。触发条件统一为 `task_id 非空且 prompt 为空` →
   单次 GET 结果接口（秒回，内部不许 sleep 循环）。框架后台轮询与调用方复查都走它。
   注意框架会把 `task_id` 放进 `ctx` 顶层，代码里要 `ctx.get("task_id") or (ctx.get("dynamic_inputs") or {}).get("task_id")` 双路取，
   只读其一就是死代码（2026-09-03 真实踩坑：查询分支写了但永远进不去）。
3. **首帧/尾帧必须显式装进 body**。框架传 `first_frame/first_frame_url/last_frame/last_frame_url`，
   只读 `reference_images` 的代码会把 i2v 的首帧整个丢掉。按下例把首帧放 `ref_image_0`，
   参考图顺延，尾帧追加（保序去重，上限按 API 来，H3 是 9 张）。
4. **本地 `/storage/...` 由框架自动内联为 `data:` URI 后再发出**（`GenericCodeVideoProvider` 经
   `media_refs` 转换，单文件上限 20MB，超限/缺失才跳过并在 `media_warnings` 中明示）。
   代码侧只需同时接受两种形态：`v.startswith(("http://", "https://", "data:"))`。
   只有纯公网 URL 场景才可只判 `http`；禁止把 `data:` 当非法值丢掉，否则节点上传的参考图永远发不出去。
5. **音频兼容三种形态**：`reference_audios`（数组）/ `ref_audio`（数组或单字符串）/`reference_audio`，
   目标键按 API 来（H3 是 `ref_audio_0..2`，上限 3 条）。
6. **数值钳位**：`duration` 按 API 范围钳（如 H3 为 1–15），`seed` 仅 `>0` 才传，`resolution` 无条件信任
   `ctx`（出网前护栏已按 `params_schema` 枚举校验过，代码里不要二次改写枚举）。
7. **返回契约**：成功 `{"video_url": url}`；排队 `{"video_url": None, "task_id": ..., "status": ...}`；
   终态失败 `raise RuntimeError` 把服务端 `code/msg` 带出来。框架 `extract_result_media` 只认
   `video_url/url/output` 与 `task_id/id` 键，别自创键名。查询到 `results` 时优先取 `type==video` 项，
   无类型标记则取首项 `url` 兜底。
8. **纯 HTTP 源不需要可信模式**。以上全部在默认沙箱（`httpx`）内可完成；只有要调本机
   `curl/ffmpeg/文件` 才开 `trusted`（总闸 + 逐源双开）。不要为省事默认 `trusted:true`。
9. **错误归因顺序**：先看提交响应 `code/msg`（参数非法类问题占八成，如分辨率档位写错），
   再看查询 `status`（`FAILED` 读 `data` 前 300 字符），最后才怀疑链路。

### 异步视频源代码模板（python，照抄再改 URL/键名）

```python
import httpx

async def generate(ctx, api):
    BASE = "https://autodl.art/api/v1"  # 改成你的网关
    WORKFLOW_ID = "minimax_h3_image_audio_to_video_v2_15s"  # 改成你的工作流
    API_KEY = ctx.get("api_key") or "YOUR_KEY"  # 优先走 Provider 配置的 Key，禁止长期硬编码
    headers = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}

    dyn = ctx.get("dynamic_inputs") or {}
    prompt = (ctx.get("prompt") or "").strip()
    task_id = (ctx.get("task_id") or dyn.get("task_id") or "").strip()

    # —— 查询模式（秒回，不许 sleep）——
    if task_id and not prompt:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(f"{BASE}/comfyui/comfyui_workflow/result/{task_id}", headers=headers)
            r.raise_for_status()
            data = (r.json() or {}).get("data", {}) or {}
            status = str(data.get("status") or "").upper()
            url = None
            for item in (data.get("results") or []):
                if isinstance(item, dict) and item.get("type") == "video" and item.get("url"):
                    url = item["url"]; break
            if not url and data.get("results"):
                first = data["results"][0]
                url = first.get("url") if isinstance(first, dict) else first
            if url:
                return {"video_url": url, "status": data.get("status"), "task_id": task_id}
            if status in ("FAILED", "ERROR", "FAIL", "CANCELLED"):
                raise RuntimeError(f"任务失败 task_id={task_id}: {str(data)[:300]}")
            return {"video_url": None, "status": data.get("status") or "QUEUED", "task_id": task_id}

    if not prompt:
        raise ValueError("缺少 prompt")

    try:
        duration = max(1, min(15, int(ctx.get("duration") or 5)))  # 上下限按 API 改
    except (ValueError, TypeError):
        duration = 5
    body = {"prompt": prompt, "duration": duration, "resolution": ctx.get("resolution") or "768p竖"}

    images = []
    _ok = lambda v: isinstance(v, str) and v.startswith(("http://", "https://", "data:"))
    for k in ("first_frame", "first_frame_url"):
        v = ctx.get(k) or dyn.get(k)
        if _ok(v): images.append(v); break
    for u in (ctx.get("reference_images") or dyn.get("reference_images") or []):
        if _ok(u): images.append(u)
    for k in ("last_frame", "last_frame_url"):
        v = ctx.get(k) or dyn.get(k)
        if _ok(v): images.append(v); break
    seen, uniq = set(), []
    for u in images:
        if u not in seen: seen.add(u); uniq.append(u)
    for i, u in enumerate(uniq[:9]):
        body[f"ref_image_{i}"] = u

    audios = []
    for k in ("reference_audios", "ref_audio", "reference_audio"):
        v = ctx.get(k) if ctx.get(k) is not None else dyn.get(k)
        if isinstance(v, str) and v: audios.append(v)
        elif isinstance(v, list): audios.extend(v)
    n = 0
    for u in audios:
        if isinstance(u, str) and u.startswith(("http://", "https://", "data:")):
            body[f"ref_audio_{n}"] = u; n += 1
        if n >= 3: break

    # —— 提交即返（不许轮询）——
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(f"{BASE}/comfyui/comfyui_workflow/{WORKFLOW_ID}", json=body, headers=headers)
        r.raise_for_status()
        resp = r.json() or {}
        if resp.get("code") not in (None, "Success", "success"):
            raise RuntimeError(f"提交失败: {str(resp)[:400]}")
        new_id = (resp.get("data") or {}).get("task_id")
        if not new_id:
            raise RuntimeError(f"未返回 task_id: {str(resp)[:400]}")
        return {"video_url": None, "task_id": new_id, "status": "SUBMITTED"}
# PARAMS_SCHEMA: 按该 API 真实枚举手写（ manifestation 见 SOP 第 2 条），此处从略
```

## 传入参数兼容（与 NodeAgentConsole / 新标准对齐）
- 前端 `buildSlotsPayload` 会双写别名（`reference_images`↔`reference`、`first_frame`↔`first_frame_url`、`ref_audio`↔`ref_audio_path`），**code 取任意其一**：`ctx.get("reference_images") or ctx.get("reference")`
- `params` 侧：前端 `NodeAgentConsole` 仅打包 `basic` 常显 + 用户显式改过的 `advanced`，`hidden` 不打包但后端 `ctx` 仍会注入默认值；`code` 内用 `ctx.get("aspect_ratio") or "9:16"` 读取即可
- `x-agent: manual` 的 `seed` 等锁定项，Agent 绝不代填，需用户手填

## 失败自检
- 工具报 `provider_id 不能为空` → 先 `list` 再 `get`
- 生成后 `params_schema` 无 `x-category` → 本技能未按 v2 模板声明，需重调
- 调用时 `reference_images` 丢失 → 检查前端双写别名，后端 `canvasAgentGenerate` 已兼容
- 画布高级抽屉空 → 说明全被标 `basic`，需至少保留 `steps/cfg` 为 `advanced`
- 提交成功但永远收不到片（video 异步源）→ 按序查：① 代码里有没有阻塞轮询（有就删，改提交即返）② 查询分支能否进（`ctx task_id` 双路取值了吗）③ 首帧进 body 了吗（`ref_image_0`）④ 发出去的是公网 URL 或 `data:` 内联吗（框架已自动内联本地 `/storage`，若 `media_warnings` 报超限/缺失则换公网链接或压缩后重传）⑤ 提交响应的 `code/msg` 说了什么（八成是参数枚举不对，如 `720p` vs `480p竖`）
- `参数校验失败（未发送请求）` → 用户选的值不在 `params_schema.enum` 里，说明 schema 枚举与 API 真实枚举不一致，重写 schema，不要改代码硬凑
- Agent 调视频源 40s 超时 → 代码里一定有阻塞等待，改异步模板；不要让用户去本地跑 curl（截图事故）
- `data:null` 崩溃类报错 → 代码用了 `data["data"]["task_id"]` 硬下标，改 `.get()` 链 + 失败 `raise RuntimeError` 带出 `code/msg`

## 示例
**用户**：做一个视频源，要首帧必选 + 3张参考图 + 2段音频，比例竖屏，分辨率 720p，步数 28  
**导演**：`list_custom_providers {kind:video, q:"my"}` → 无 → `register_custom_provider {
  kind:video, name:"我的多参视频",
  input_schema:{prompt:{type:string,x-handle:text}, first_frame:{type:string,format:uri,x-handle:image,required:true}, reference_images:{type:array,items:{format:uri},maxItems:3}, ref_audio:{type:array,items:{format:uri},maxItems:2}},
  params_schema:{aspect_ratio:{enum:[9:16,16:9],default:9:16,x-category:layout,x-visibility:basic,x-agent:auto,x-priority:10}, resolution:{enum:[720p,1080p],default:720p,x-category:layout,x-visibility:basic,x-agent:auto,x-priority:20}, steps:{default:28,x-category:quality,x-visibility:advanced,x-agent:suggest,x-priority:40}}
}`
**结果**：画布 `基础 2项(比例/分辨率) 高级 1项(步数)`，分镜 `motion Tab` 首帧必选红星，参考图 0-3 张多选。
