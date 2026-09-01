# 接力文档 — 无限画布 Per-Node Agent · MCP 统一 · ComfyUI 工作流单源化

> **日期**：2026-09-01 13:20  
> **分支**：`main`（已全量构建 `dist/Studio/Studio.exe 85.7M 2026-09-01 13:11`）  
> **目标**：彻底解决“全局 FloatingBar 硬控选中节点 + Provider 异构参数硬编码 + 工作流未单源化 + 节点 Agent 空壳”四宗罪，达到友商（MiniMax Design / LibTV / RunningHub RHTV）`每节点一Agent`水位

---

## 一、本次重构总览

| 维度 | 重构前 | 重构后 | 关键文件 |
|---|---|---|---|
| 控制归属 | 单一全局 `FloatingAgentPromptBar` 控选中节点，状态竞态 | **Per-Node Agent**：每节点自带 `Prompt+技能Tab+Provider徽标+插槽缩略+生成↑`，全局 Bar 降权为 `+建节点/全局自然语言GO/保存导出` | `client/src/components/canvas/nodes/MinimalNodes.tsx:1` `hooks/useNodeExecution.ts:1` `FloatingAgentPromptBar.tsx:1` |
| 调度 | `CreativeCanvas.handleNodeExecute` 直调 `apiService.generateShotImage` 与 `engine.py` 双轨分叉，未复用 Provider | **统一 MCP**：所有生成源即 `MCP Tool provider_<id>`，`input= input_schema ∪ params_schema`，节点 Agent 按 Tool 动态调用 | `server/app/mcp/server.py:140` `server/app/canvas/engine.py:367` |
| 工作流 | `ComfyUI` 仅 `provider=comfyui + workflow_id 参数`，未单源化；外部 `ext_*` 也被误同步为 Provider | **一工作流一生成源**：仅 `source=internal` 已导出工作流 → `ProviderDefinition{provider_type=comfyui, workflow_id, workflow_exposed}` → `comfyui_wf_*` 独立源 | `server/app/providers/workflow/manager.py:2742` `models/provider_definition.py:100` `providers/init_providers.py:4` |
| 资产 | `CanvasResourcePicker` 按 `category===acceptType` 误筛掉 `character/scene` | 解耦：`image` 槽接受所有带图资产（`character/scene/prop`） | `CanvasResourcePickerModal.tsx:86` |
| 句柄 | `video` 缺 `last_frame`，`image` 缺 `reference_images` | `nodeRegistry.ts:22` 补齐 | `nodeRegistry.ts:22` |

---

## 二、核心设计

### 2.1 Per-Node Agent 公式（替代全局 Bar）
```
AgentNode = 沉浸视图(90%) + 嵌入式Agent条(模型|技能|参数|插槽|Prompt↑) + 4层上下文 + 独立执行器(useNodeExecution)
画布 = Agent DAG + 轻量全局编排(小地图/保存/全局Agent对话)
```
对标：`MiniMax Design` 01 Idea Intake Agent Mode + 02 Canvas Flow Node Graph + RHTV 原生画布智能体常驻 `rhtv.runninghub.cn`。

### 2.2 MCP 统一异构参数
```
ProviderDefinition{input_schema, params_schema, models}
  ↓ _provider_to_tool()  // server/app/mcp/server.py:801
MCP Tool provider_<id>{ input: prompt/first_frame/reference_images + aspect_ratio/768P-2K/4-15s/hasSound + model }
  ↓ 节点Agent
mcp_registry.execute_tool(provider_<id>, args) → _ensure_provider_registered → image/video/audio_registry.generate
  ↓ 热更新
init_all_providers() → sync_all_workflow_providers() → refresh_provider_tools() // main.py:12
register_single → refresh
```
用户仅选 `生成源`，余下异构枚举由节点 Agent 按 Tool 动态填参（`validate_user_params` 护栏）。

### 2.3 一工作流一源
- **判定**：`_detect_workflow_kind()` 含 `VHS/Wan/Video` → `video` else `image`
- **标准化输入**：`prompt/reference_images/first_frame/last_frame`（`x-handle` 标准），参数 `steps/cfg/seed/sampler...` 归一 `aspect_ratio/resolution/steps...`
- **映射**：`workflow_exposed: List[{id,node_id,param_name,type}]` 存 `ProviderDefinition.workflow_exposed`，`init_providers._make_provider` 的 `comfyui` 分支在 `generate` 时将标准 `reference_images[]` → `img_12`、`aspect_ratio` → `49_aspect_ratio` 等回填 `dynamic_inputs`
- **约束**：仅 `source=internal` 可成源，`ext_*` 需先 `WorkflowInspector → 导出为内部`；`sync_all` 启动时仅扫 `internal`，删除工作流同步 `remove_workflow_provider`

---

## 三、文件级变更清单

### 前端 `client/src/components/canvas/`
- `providerSkills.ts:37` 修复 `extractSlotsFromProvider`：`x-handle=image` 泛型 + `required` 数组 + `reference_images` 去重，新增 `IMAGE/VIDEO/AUDIO/DIRECTOR_AGENT_SKILLS` + `getSkillsForKind`
- `nodes/MinimalNodes.tsx:1` 重写 `Image/Video/Audio/Director` 为 Per-Node Agent：`AgentShell` + 技能 Tab + `provider:model` 徽标 + 插槽状态 + `useNodeExecution` 的 `生成↑/Agent重生` 独立按钮；`AgentShell` 右侧 `+` 衍生菜单保留
- `hooks/useNodeExecution.ts:1` **新建**：`execute()` 读 `node.data{provider_id, prompt, slots, params}` → `callMcpTool(provider_<id>, args)` → 回写 `image/video/audio_url`
- `hooks/useCanvasSync.ts` 保留
- `utils/dynamicHandles.ts` 保留
- `nodeRegistry.ts:22` 补 `video.last_frame`、`image.reference_images`、`audio.ref_audio`
- `FloatingAgentPromptBar.tsx:1` 降权：新增 `isAgentMode` 双模（`手动/智能体`），手动显 `Provider/Model/DynamicControl`，智能体显 `Agent自主选源` + `canvas_dispatch_skill` 调度，`handleExecute` 分流，`isAgentMode` 时隐藏 `params_schema` 区；`isSlotMulti` 支持 `reference_images` 多选
- `CanvasResourcePickerModal.tsx:86` 资产过滤解耦 + 上传按 `image→ComfyUI / audio/video→createAsset` 分流
- `CreativeCanvas.tsx:174` `edgesRef/nodesRef` 消陈旧闭包；`handleNodeUpdate` 4槽（首/尾/参考/音频 + params 透传）；`handleNodeExecute` 全量 `aspect_ratio/resolution/steps/cfg...` 透传 + 视频轮询 `FAILED` 不吞错 + 音频 `ref_audio`；`onConnect` 精准 `first/last/reference_images/ref_audio/provider`；`addTemplate` 修复 `video→audio` 非法边为 `prompt→audio` 分叉；`agent-canvas-updated` 监听重载

### 后端 `server/app/`
- `models/provider_definition.py:100` 新增 `workflow_id, workflow_hash, workflow_exposed: List[Dict]`，`to_provider_info` 暴露
- `providers/workflow/manager.py:2742` 新增 `_workflow_provider_id, _detect_workflow_kind, _build_provider_schemas_from_workflow(标准化), sync_workflow_provider(仅internal), sync_all_workflow_providers(internal), remove_workflow_provider`；钩 `save_workflow / save_workflow_overrides / delete_workflow` 自动同步
- `providers/init_providers.py:4` 新增 `comfyui+workflow_id` 分支（`ComfyUIProvider/ComfyUIVideoProvider` 包装 + 标准→具体 `img_12` 映射），`register_single/unregister` 后 `mcp.refresh_provider_tools()`，`init_all_providers` 末尾 `sync_all_workflow_providers`
- `mcp/server.py:140` `__init__` 后 `refresh_provider_tools()`；新增 `_provider_to_tool, _register_provider_dynamic_tools, refresh_provider_tools`（13→48 provider_* Tool）；`execute_tool` 首分支 `provider_*` 按三表探 `kind` 构造 `Image/Video/AudioGenerateRequest`（含 `reference_images` → `dynamic_inputs`）
- `canvas/engine.py:46` 重写 `collect_upstream_data`（空句柄推断 + `first/last/reference` 精准 + `reference_images` 去重）；`_ensure_provider_registered:192` 跨表探测；`execute_node:367` `image/video/audio` 分支 `extra/dyn` 统一 + 优先 `mcp provider_*` 再回退 `registry`；`execute_dag:516` 祖先+下游双向闭包；`comfy-workflow` 分支 `workflow_id` 透传
- `main.py:12` `init_all_providers()` 后 `mcp_registry.refresh_provider_tools()`
- `api/canvas_routes.py` 保持 `POST /canvas/dispatch-skill` 供全局 Agent 批量建链

---

## 四、数据模型

```ts
// ProviderDefinition (workflow 单源示例)
{
  id:"comfyui_wf_4a19b2a2", kind:"image", provider_type:"comfyui",
  workflow_id:"wf_4a19b2a2", workflow_hash:"a1b2c3d4",
  workflow_exposed:[{id:"img_12",node_id:"12",param_name:"image",type:"image"}, {id:"49_aspect_ratio",node_id:"49",param_name:"aspect_ratio",type:"combo"}],
  input_schema:{properties:{prompt:{x-handle:text}, reference_images:{x-handle:image}}, required:["prompt"]},
  params_schema:{properties:{aspect_ratio:{enum:["9:16","16:9"]}, steps:{type:integer}}},
  output_schema:{properties:{image_url:{x-handle:image}}}
}
// NodeAgentData
{
  provider_id:"comfyui_wf_4a19b2a2", mcp_tool:"provider_comfyui_wf_4a19b2a2",
  skill_id:"text_to_image", prompt:"a cat",
  slots:{reference_images:["/storage/..."]},
  params:{aspect_ratio:"16:9", steps:20},
  agent_state:{status:"completed", reasoning:"调用 provider_comfyui_wf_4a19b2a2"}
}
```

---

## 五、交互流

- **手动单节点**：点 `Image Agent` → 技能 `文生图` → 底部卡选 `ComfyUI·image_krea2_turbo` → 挂 `参考图` → 输 Prompt → 节点内 `生成↑` → `useNodeExecution → provider_comfyui_wf_4a19b2a2{prompt, reference_images[]}` → 沉浸视图
- **Agent批量**：全局输入 `根据李逍遥...生成首尾帧视频` → `canvas_dispatch_skill` → 自动 `list_providers` + 读 `角色库` → 批量 `canvas_create_node/connect/execute` → 画布长出 `prompt→image→video` 白盒链

---

## 六、验证

- `npm run build` 2021 modules → `CreativeCanvas 168.9k` ✓
- `python -m compileall -q app` ✓
- `init_all_providers()` → `19 image / 25 video`（含 `1` 内部工作流 `comfyui_wf_4a19b2a2`，外部 35 已清理）→ `MCP 48 provider_*`
- `mcp.execute_tool(provider_comfyui_wf_4a19b2a2, {prompt, reference_images:[]}) → {image_url:/storage/generated/...}` 成功

---

## 七、待办/风险

- 2 条外部工作流含 `▶` 特殊字符 `gbk` 编码失败已跳过，需改名后重导入
- `Wan` 视频工作流 `duration→length` 帧数换算已做 `*16+1`，需针对 `LTX/CogVideo` 再压测
- `FloatingBar` 仍保留全局 `手动/智能体` 切换，后续可按 RHTV 完全常驻画布内 Agent 进一步收敛

---

## 八、回滚点

- 本次涉及 `provider_definition` 新增 `workflow_*` 字段，向下兼容（`Optional`），旧 `custom/*.json` 无该字段自动为 `None`
- 如需回滚，仅内部工作流单源化：注释 `manager.py: sync_workflow_provider` 调用 + `init_providers.py: sync_all` 即可恢复为通用 `comfyui` 单源

*— 2026-09-01 重构组 —*
