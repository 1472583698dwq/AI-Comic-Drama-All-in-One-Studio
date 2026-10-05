---
name: comfyui-provider
description: ComfyUI 系生成源三路径工厂（一律纯代码模式）：本地 ComfyUI 工作流系统派生源（comfyui_* 零代码，系统能力非自定义）、本地/云端 ComfyUI 纯代码直连源（async def generate 双分支模板，RunningHub v2 契约实装参考「MiniMax H3 双采参考生视频 V3」）、AutoDL 等 ComfyUI 网关（转 provider-factory）。含 nodeInfoList 节点映射、媒体上传、UI/API 格式转换与坑位表。
version: 1.1.0
author: MiniMax Studio
category: ai_generation
tools:
  - list_custom_providers
  - register_custom_provider
  - get_provider_code
  - update_custom_provider
  - test_custom_provider
  - list_comfyui_workflows
  - read_skill
  - fs_read
---

# ComfyUI 系生成源工厂 (ComfyUI Provider)

## 定位与边界
用户说「接一个 ComfyUI 工作流当生成源 / 用 RunningHub 的 AI 应用出片 / 这个云 ComfyUI 源接进 Studio」时走本技能。
- **纯代码铁律（现行，后面一律遵守）**：自定义生成源**唯一形态是纯代码** `async def generate(ctx, api)`；非代码 JSON/transport 模式已删除（legacy 字段不再接受更新，`_make_provider` 对无代码定义直接拒绝注册）。本技能所有自定义源模板均为纯代码，**禁止**再建 JSON 模板/transport 源，也禁止把已有源按 legacy 字段修补。
- **通用规范不重复**：input/params_schema 的 x-* 分组、异步视频铁律（提交即返、查询分支、task_id 双路取）见 `read_skill {name:"provider-factory"}`；直写/改码 SOP 见 `read_skill {name:"provider-author"}`。本技能只讲 **ComfyUI 系特有**的三条路径与契约。
- **先查重**：`list_custom_providers {kind, q}` + `list_comfyui_workflows`，已存在同工作流/同 appId 的源不重建。

## 路径决策表（先选路径再动手）
| 部署形态 | 路径 | 代码量 | 关键点 |
|---|---|---|---|
| 本机/局域网 ComfyUI（`COMFYUI_SERVER_URL`），无自定义逻辑 | **A 工作流派生源** | 零代码 | **系统派生的机制源（非自定义）**：导入即成源 `comfyui_*`，schema 由暴露参数生成；自定义需求不要改它，走 A-code |
| 本机/局域网 ComfyUI，要自定义逻辑/参数 | **A-code 纯代码直连** | 模板改节点号 | 纯代码内嵌 API 格式工作流，`/prompt` → `/history` → `/view` 双分支（见下方模板） |
| RunningHub 云 ComfyUI（AI 应用/工作流） | **B 纯代码源** | 模板改 URL/节点 | `/openapi/v2` 提交/查询双分支 + nodeInfoList + 媒体上传 |
| AutoDL / 任意「ComfyUI 工作流 HTTP 网关」 | **C → provider-factory** | 引用其纯代码模板 | `POST .../comfyui_workflow/{id}` + `GET .../result/{tid}`，直接套其异步模板 |
| 其他云 ComfyUI 托管（RunComfy 等） | **B 同款** | 模板改 URL | 各家提交/查询端点不同，双分支骨架与 B 相同 |

判别：用户给了 **本机 ComfyUI 地址或工作流 JSON 且无特殊需求** → A；**要自定义** → A-code；给了 **runninghub.cn / AI 应用 ID** → B；给了 **autodl 等网关 + workflow_id** → C。凡自定义，一律纯代码。

---

## 路径 A：本地 ComfyUI 工作流自动成源（零代码）

### 机制（代码事实，`providers/workflow/manager.py` + `init_providers.py`）
1. 工作流两处可入：`COMFYUI_WORKFLOWS_DIR`（ComfyUI 自带 workflows 目录，经 `GET /images/workflows/external/dir` + `POST /images/workflows/import/{external_id}` 导入）或 `POST /images/workflows/upload` 上传；存为 `storage/workflows/wf_<hash>.json` + `.meta.json`。
2. **仅 `source=internal` 的工作流能成源**（`ext_*` 直读永远不自动成源，需先导入）。导入/改映射/保存白名单后自动 `sync_workflow_provider()`，启动时 `sync_all_workflow_providers()` 兜底。
3. 同步产物：ProviderDefinition `id=comfyui_<wf_id>`（如 `comfyui_wf_3d96b356`）、`provider_type=comfyui`、`code=None`、`workflow_exposed`（暴露槽清单）、自动 kind（按节点类名 VHS_/Video→video 等）、自动 input/params_schema。
4. 执行包装（`_make_provider`）：标准槽 → 暴露槽位置映射（`reference_images` 按 img 槽顺序灌、`reference_videos/reference_audios` 同理；用户已显式挂载的独立槽优先不覆盖）；标准参数（aspect_ratio/steps/cfg/seed/duration/resolution/fps/denoise/sampler/scheduler/width/height）→ 对应 `exp_*` 槽；prompt 经 `_inject_workflow_prompt` 注入工作流真实文本入口。
5. 真实执行（`comfyui.py` / `comfyui_video.py`）：`get_workflow_with_meta` → 参考图经 `POST /upload/image` 传本机 ComfyUI → `inject_video_params`/`inject_params` 注入 → `strip_unsupported_nodes` → `POST /prompt` → 轮询 `GET /history/{prompt_id}` → `GET /view` 落盘。**视频失败会降级 Mock**（看后端日志 `[ComfyUIVideo]`，别把 mock 当成功）。

### SOP
1. 确认链路：`GET {COMFYUI_SERVER_URL}/system_stats` 或 `/object_info` 可达；配置在 `config_store.json`（`COMFYUI_SERVER_URL` 等）。
2. 导入工作流 → 检查 `GET /images/workflows` 列表与 meta（`mapping.save_node`、`exposed_inputs`、`warnings`）。
3. **开白名单**：暴露参数默认受控，经 `PUT /images/workflows/{id}/node/{node_id}/{param_name}`（或 overrides）白名单放行，保存会自动 force 重建源。
4. UI 格式（含 nodes/links）自动转 API 格式（官方 CLI 转换器 + legacy 兜底）；转换失败按提示在 ComfyUI 里 **File → Export (API Format)** 另存再导。
5. `list_comfyui_workflows` / `list_custom_providers` 复核成源结果；试跑一次图/视频，视频看是否走了真流（非 mock）。

### 本地 ComfyUI 原生 API 速查（写代码源直连时用）
- `POST /prompt` `{prompt: <API格式>, client_id}` → `{prompt_id, number}`；校验失败 **400 + `node_errors`**（要 raise 带出）。
- `GET /history/{prompt_id}` → 未完成返回 `{}`；完成为 `{pid:{outputs:{node_id:{images|videos:[{filename,subfolder,type}]}, status:{status_str,...}}}}`。
- `GET /view?filename=&subfolder=&type=input|output|temp` 取文件；`POST /upload/image` multipart 传参考图；`GET /queue`、`POST /interrupt`、`GET /object_info`。
- 所有路由有 `/api` 前缀双路由；进度走 `/ws`（`executing` 的 `node=null` 表示结束；`execution_success/execution_error`）。官方规范：docs.comfy.org/development/comfyui-server/*，Comfy-Org/ComfyUI `openapi.yaml`。
- UI 格式 `{nodes,links,groups}` ≠ API 格式 `{node_id:{class_type,inputs}}`，提交只收 API 格式。

### A-code 模板：本地 ComfyUI 纯代码直连（要自定义时一律用这个）
> 内嵌一份 **API 格式**工作流（ComfyUI 里 File → Export (API Format) 导出），改节点号即可。
> 双分支契约与 B 相同：提交即返 `prompt_id`，框架后台轮询走查询分支；`kind=video` 由框架异步接管，
> `kind=image` 框架不接管 task_id（图像源需在提交分支内自行短轮询 `/history` 到拿到结果再返 `{"url": ...}`）。

```python
import httpx, copy, base64, urllib.parse

SERVER = "http://127.0.0.1:8188"   # 改成你的 ComfyUI 地址
WORKFLOW = {                       # Export (API Format) 得到的 {node_id: {class_type, inputs}}
    # "28": {"class_type": "TextMultiline", "inputs": {"value": ""}},
    # "6":  {"class_type": "LoadImage",     "inputs": {"image": ""}},
}

async def generate(ctx, api):
    dyn = ctx.get("dynamic_inputs") or {}
    task_id = str(ctx.get("task_id") or dyn.get("task_id") or "").strip()   # 双路取
    prompt = str(ctx.get("prompt") or "").strip()
    async with httpx.AsyncClient(timeout=120) as client:
        # 查询分支：单次秒回，history 为 {} = 还没跑完
        if task_id and not prompt:
            h = await client.get(f"{SERVER}/history/{task_id}")
            h.raise_for_status()
            entry = (h.json() or {}).get(task_id)
            if not entry:
                return {"video_url": None, "task_id": task_id, "status": "RUNNING"}
            st = entry.get("status") or {}
            if str(st.get("status_str") or "").lower() == "error":
                raise RuntimeError(f"工作流执行失败: {str(st.get('messages'))[:300]}")  # 特征词→终态
            for node_out in (entry.get("outputs") or {}).values():
                for key in ("videos", "gifs", "images"):        # 视频在 videos/gifs，图在 images
                    for f in node_out.get(key) or []:
                        q = urllib.parse.urlencode({"filename": f.get("filename", ""),
                                                    "subfolder": f.get("subfolder", ""),
                                                    "type": f.get("type", "output")})
                        return {"url": f"{SERVER}/view?{q}", "task_id": task_id}  # url 键通用，框架统一落盘
            return {"video_url": None, "task_id": task_id, "status": "RUNNING"}
        # 提交分支：注入参数 + 传参考图 → POST /prompt → 立即返 prompt_id
        if not prompt:
            raise ValueError("缺少 prompt")
        wf = copy.deepcopy(WORKFLOW)
        wf["28"]["inputs"]["value"] = prompt                    # 改成你工作流的文本节点
        refs = [ctx.get("first_frame_url") or ctx.get("first_frame"),
                *list(ctx.get("reference_images") or [])]       # 三态：data:/http/已上传文件名
        i = 0
        for v in refs:
            if not (isinstance(v, str) and v and v.startswith(("data:", "http"))):
                continue
            raw = base64.b64decode(v.split(",", 1)[1]) if v.startswith("data:") \
                  else (await client.get(v, timeout=60)).content
            up = await client.post(f"{SERVER}/upload/image",
                                   files={"image": (f"ref{i}.png", raw, "image/png")})  # 不要手写 Content-Type
            up.raise_for_status()
            name = (up.json() or {}).get("name")
            if name:
                wf["6"]["inputs"]["image"] = name               # 改成你工作流的 LoadImage 节点
                i += 1
        r = await client.post(f"{SERVER}/prompt", json={"prompt": wf, "client_id": "studio"})
        if r.status_code >= 400:
            raise RuntimeError(f"提交失败: {str(r.text)[:300]}")  # 400 的 node_errors 在此带出→终态
        pid = str((r.json() or {}).get("prompt_id") or "")
        if not pid:
            raise RuntimeError(f"未返回 prompt_id: {str(r.text)[:300]}")
        return {"video_url": None, "task_id": pid, "status": "SUBMITTED"}
```
- 参数暴露照旧走 `params_schema`（x-* 四件套），代码里 `ctx.get("duration")` 等读取后注入 `wf` 对应节点。
- `SERVER` 硬编码与 provider-factory 模板的 `BASE` 同一惯例（代码源无 settings 访问；要可配就把地址做成 `params_schema` 的 `advanced/manual` 参数）。
- 本地生成快也**不要**在代码里 `while sleep` 等终态（视频源铁律）；图像源的短轮询是唯一例外且限本地秒级。


---

## 路径 B：RunningHub 云 ComfyUI 代码源（实装参考 prov_d76c351f）

### v2 契约速查（base = `https://www.runninghub.cn/openapi/v2`，官方文档核实）
| 动作 | 端点 | 要点 |
|---|---|---|
| 提交 | `POST {base}/run/ai-app/{aiAppId}` | Header `Authorization: Bearer KEY`；body `{nodeInfoList, instanceType?, webhookUrl?}`；回 `{taskId}`（兼容 `task_id`/`data.taskId` 包裹） |
| 查询 | `POST {base}/query` | body `{taskId}`；回 `{taskId, status, errorCode, errorMessage, results:[{url, outputType}], promptTips}` |
| 上传 | `POST {base}/media/upload/binary` | **只能 Bearer 头**，multipart `file`；回 `data.download_url 或 data.fileName`（拿 fileName 回填 fieldValue） |
| 状态 | `status` | `CREATE/QUEUED/RUNNING` 非终态；`SUCCESS/FAILED/CANCEL` 终态 |
| 机型 | `instanceType` | `default`=24G / `plus`=48G / `ultra`=84G |
- 业务限制：**需会员（免费用户无 API）**；被调工作流/应用**必须先手动跑成功一次**（否则 `APIKEY_INVALID_NODE_INFO`）；多保存节点 → `results` 多项。
- `promptTips` 是 JSON 字符串，`node_errors` 非空说明有节点问题（提交仍可能返回 taskId，失败在查询阶段暴露 `errorCode/errorMessage`）。
- 旧版 v1 族（`/task/openapi/ai-app/run` + `/task/openapi/outputs`，code 804 运行/813 排队/805 失败）文档仍在，新源一律用 v2。

### 参考实现解剖（「MiniMax H3 双采参考生视频 V3」= prov_d76c351f，照此骨架改）
- **双分支单入口**：`if task_id and not prompt: 查询分支（单次秒回）` else `提交分支`。查询终态 SUCCESS 时遍历 `results`，**优先 `outputType in (mp4,webm,mov)`** → 再兜底首项 url；FAILED → `raise RuntimeError(f"任务失败({status}): {errorMessage}")`（含框架失败特征词，走终态不空转）。
- **参考图三态归一**：已是 RunningHub 文件名 → 原样透传；`data:` URI → base64 解码上传；`http(s)` → GET 取字节上传。去重保序、上限 9（first_frame→nodeId `6`，参考图顺延 `35..42`）。
- **nodeInfoList 就是工作流参数表**：`{nodeId, fieldName, fieldValue, description}` 逐项映射（prompt→节点28、aspect→29、duration→27、index 开关 64/69），枚举值必须与工作流下拉一致（`ASPECT_OPTIONS` 白名单 + 默认回退）。
- **提交即返**：`return {"video_url": None, "task_id": new_id, "status": "SUBMITTED"}`；后台轮询与 `/videos/status` 由框架接管（铁律见 provider-factory，勿重复实现）。

### 模板（python，照抄改 URL/节点即可）
```python
import httpx, base64
API_BASE = "https://www.runninghub.cn/openapi/v2"
RUN_URL = API_BASE + "/run/ai-app/<AI_APP_ID>"   # AI应用详情页的 ID
QUERY_URL = API_BASE + "/query"
UPLOAD_URL = API_BASE + "/media/upload/binary"

async def _upload(client, api_key, value, idx):
    v = str(value or "").strip()
    if not v or v == "None": return None
    if not (v.startswith("data:") or v.startswith("http")): return v   # 已是文件名则透传
    raw = base64.b64decode(v.split(",", 1)[1]) if v.startswith("data:") else (await client.get(v, timeout=120)).content
    # 上传只能 Bearer 头：带 Content-Type: application/json 会破坏 multipart 边界
    r = await client.post(UPLOAD_URL, headers={"Authorization": f"Bearer {api_key}"},
                          files={"file": (f"image{idx}.png", raw, "image/png")}, timeout=300)
    j = r.json()
    if j.get("code") != 0: raise RuntimeError(f"参考图{idx}上传失败: {j.get('message') or str(j)[:300]}")
    d = j.get("data") or {}
    return d.get("download_url") or d.get("fileName")

async def generate(ctx, api):
    dyn = ctx.get("dynamic_inputs") or {}
    api_key = (ctx.get("api_key") or "")
    if not api_key and isinstance(api, dict) and callable(api.get("get_api_key")):
        api_key = api["get_api_key"]()
    api_key = str(api_key or "").strip()
    if not api_key: raise RuntimeError("缺少 RunningHub API Key（请在生成源里配置 Key 后重试）")
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    task_id = str(ctx.get("task_id") or dyn.get("task_id") or "").strip()   # task_id 双路取
    prompt = str(ctx.get("prompt") or "").strip()
    async with httpx.AsyncClient(timeout=600) as client:
        # 查询分支：单次秒回，绝不 sleep 轮询
        if task_id and not prompt:
            q = await client.post(QUERY_URL, headers=headers, json={"taskId": task_id})
            q.raise_for_status()
            qj = q.json()
            status = str(qj.get("status") or "").upper()
            if status in ("CREATE", "QUEUED", "RUNNING", "PENDING"):
                return {"video_url": None, "task_id": task_id, "status": status}
            if status == "SUCCESS":
                for item in (qj.get("results") or []):
                    if isinstance(item, dict):
                        url, ot = str(item.get("url") or ""), str(item.get("outputType") or "").lower()
                        if url and (ot in ("mp4", "webm", "mov") or ot == "" or "mp4" in url.lower()):
                            return {"video_url": url}
                raise RuntimeError(f"任务成功但无结果URL: {str(qj)[:300]}")
            if status == "CANCEL": status = "CANCELLED"   # RunningHub 的 CANCEL 要映射成框架认的 CANCELLED
            raise RuntimeError(f"任务失败({status or 'UNKNOWN'}): {qj.get('errorMessage') or str(qj)[:300]}")
        # 提交分支：上传参考图 → nodeInfoList → 立即返回 task_id
        first = ctx.get("first_frame_url") or ctx.get("first_frame") or dyn.get("first_frame")
        refs = ctx.get("reference_images") or dyn.get("reference_images") or []
        if isinstance(refs, str): refs = [refs]
        values, seen = [], set()
        for v in [first] + list(refs):
            if not v: continue
            s = str(v)
            if s not in seen: seen.add(s); values.append(s)
        if not values: raise RuntimeError("至少需要一张参考图（first_frame 或 reference_images）")
        rh_files = [await _upload(client, api_key, v, i + 1) for i, v in enumerate(values[:9])]
        duration = max(3, min(15, int(ctx.get("duration") or dyn.get("duration") or 5)))
        aspect = ctx.get("aspect_ratio") or dyn.get("aspect_ratio") or "9:16 (Portrait Widescreen)"
        node_info_list = [
            {"nodeId": "28", "fieldName": "prompt",   "fieldValue": prompt, "description": "提示词"},
            {"nodeId": "27", "fieldName": "value",    "fieldValue": str(duration), "description": "时长"},
            {"nodeId": "29", "fieldName": "aspect_ratio", "fieldValue": aspect, "description": "比例"},
        ]
        for i, nid in enumerate(["6", "35", "36", "37", "38", "39", "40", "41", "42"]):
            node_info_list.append({"nodeId": nid, "fieldName": "image",
                                   "fieldValue": rh_files[i] if i < len(rh_files) else "None",
                                   "description": f"image{i + 1}"})
        r = await client.post(RUN_URL, headers=headers,
                              json={"nodeInfoList": node_info_list, "instanceType": "default"})
        r.raise_for_status()
        rj = r.json()
        new_id = str(rj.get("taskId") or ((rj.get("data") or {}).get("taskId") if isinstance(rj.get("data"), dict) else "") or "").strip()
        if not new_id: raise RuntimeError(f"提交未返回 taskId: {str(rj)[:300]}")
        return {"video_url": None, "task_id": new_id, "status": "SUBMITTED"}
# PARAMS_SCHEMA: {"type":"object","properties":{"duration":{"type":"integer","title":"时长(秒)","minimum":3,"maximum":15,"default":5,"x-category":"motion","x-visibility":"basic","x-agent":"auto","x-priority":20},"aspect_ratio":{"type":"string","title":"比例","enum":["1:1 (Square)","9:16 (Portrait Widescreen)","16:9 (Widescreen)"],"default":"9:16 (Portrait Widescreen)","x-category":"layout","x-visibility":"basic","x-agent":"auto","x-priority":10},"instance_type":{"type":"string","title":"实例类型","enum":["default","plus","ultra"],"default":"default","x-category":"advanced","x-visibility":"advanced","x-agent":"suggest","x-priority":30}}}
```
`input_schema`：`prompt`（x-handle:text, x-role:prompt）+ `first_frame`（format:uri, x-handle:image, x-slot:first_frame）+ `reference_images`（array, maxItems:8, x-slot:reference_images）；键名可按实装补 `first_frame_url/reference` 双写别名（前端会双写，code 取任一）。

---

## 坑位表（ComfyUI 系特有，通用异步坑见 provider-factory）
1. **上传 multipart 只带 Bearer**：`files=` 时再手写 `Content-Type: application/json` 会破坏 boundary → 只传 Authorization（参考图上传 99% 挂在这）。
2. **参考图三态都要收**：`data:`/`http(s)`/纯文件名；框架已把本地 `/storage` 内联为 `data:`，把 `data:` 当非法值丢掉 = 节点上传图永远发不出去。
3. **`results` 多项按 outputType 过滤**：多保存节点会混出图片，视频源必须先挑 `mp4/webm/mov`。
4. **`CANCEL` ≠ `CANCELLED`**：查询分支要映射成框架终态词，或直接 `raise RuntimeError("任务已取消...")`（含失败特征词），否则任务不终态空转到超时。
5. **`promptTips.node_errors` 非空**：提交成功≠任务有效，错误通常在查询阶段以 `errorCode/errorMessage` 暴露，别在提交分支提前 return 成功。
6. **RunningHub 业务前置**：会员 + 目标工作流手动跑成功过一次，否则秒失败；先用**历史真实 task_id** 走一遍查询分支验链路，再花配额提交。
7. **本地 `/history/{pid}` 未完成返回 `{}`**：轮询要容忍空对象；`POST /prompt` 400 的 `node_errors` 必须 raise 出来（框架据此判终态）。
8. **UI 格式不能直接提交**：本地直连源要 `ensure_api_format`；子图（subgraph）有转换不支持场景，提示 Export (API Format)。
9. **视频失败降级 Mock**：`comfyui_video` 出错自动 mock，结果里 engine 会露馅（`comfyui_video (wf_xxx)`/mock），排查先看 `[ComfyUIVideo]` 日志再怀疑链路。
10. **暴露槽白名单默认受控**：派生源 params 空 ≠ 失败，先查 `workflow_exposed` 与 node 白名单，再怀疑 sync。

## 质检清单（交付前自检）
- [ ] **纯代码模式**：自定义源 register 带 `code`（`async def generate(ctx, api)`），无 JSON/transport 残留、无 legacy 字段修补；本地自定义走 A-code 模板
- [ ] 路径选对：无自定义的本机工作流走 A（系统派生）、自定义走 A-code/B/C，没有把 A 的活写成代码源、也没把 B/C 降级成 JSON
- [ ] A：导入的是 internal 工作流、白名单已开、meta `save_node` 存在、试跑非 mock
- [ ] B：双分支齐全（task_id 双路取、查询秒回无 sleep）、`nodeInfoList` 节点号/枚举与应用详情页一致、上传只带 Bearer、`CANCEL` 已映射
- [ ] B：`test_custom_provider` ok=true；用历史 task_id 验过查询分支
- [ ] schema：文件槽在 `input_schema`、可量化参数带 x-* 四件套、`# PARAMS_SCHEMA` 与应用真实枚举一致
- [ ] 汇报含「已生成 id、暴露了哪些槽、提交返 task_id 后台轮询取片」一句话

## 现有参考源（本机实装，改前先 `get_provider_code` 通读）
| 源 | id | 形态 | 抄什么 |
|---|---|---|---|
| MiniMax H3 双采参考生视频 V3 | `prov_d76c351f` | RunningHub v2（路径 B） | 双分支+上传+nodeInfoList 全套 |
| AutoDL H3 图音生视频 v2 (15s) | `prov_6131876a` | AutoDL 网关（路径 C） | 网关双分支 |
| AutoDL H3 文生视频 | `prov_e3a19229` | AutoDL 网关（路径 C） | 最小网关骨架 |
| ComfyUI 四试图生成 | `comfyui_wf_3d96b356` | 本地派生（路径 A） | 派生源 schema/暴露槽长什么样 |
| ComfyUI image_krea2_turbo_t2i | `comfyui_wf_4a19b2a2` | 本地派生（路径 A） | 同上 |
