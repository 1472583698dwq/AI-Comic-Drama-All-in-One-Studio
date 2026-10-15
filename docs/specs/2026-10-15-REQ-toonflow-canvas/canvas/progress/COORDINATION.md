# 跨任务约定（协调人维护，W2/W3 agent 必读）

1. **端口 id 以真实数据为准**（T4 盘点了 29 张真实画布）：
   - 文本节点 `prompt` 的输出端口 id 是 **`prompt`**（不是 design 里写的 `text`），18 条现存连线都用它。
   - 生成类节点（`image`/`video`/`audio`/`prompt`/`director3d`）的输入端口统一为 **`in`**；输出端口沿用：`image`→`image`，`video`→`video`，`audio`→`audio`，`director3d`→`camera_prompt`（新增 `image`、`video` 两个输出），`load-image`→`image`，`load-video`→`video`，`load-audio`→`audio`。
   - 没有 sourceHandle 的旧边，迁移时补成源节点的主输出（见 `migrate.ts` 的 `PRIMARY_OUTPUT_PORT`）。
2. **迁移辅助函数**直接复用 `client/src/components/canvas/migrate.ts`：`edgeKey`、`toInPort`、`legacySlotFor`、`NEW_IN_PORT`、`SLOT_PRIORITY`、`PRIMARY_OUTPUT_PORT`。不要重复实现。
3. 迁移后旧视频 `data.mode` 可能是 `i2v`/`r2v`/`t2v`，视频节点读取时要兼容映射：`i2v`→`singleImage`（或首尾帧时 `startEnd`），`r2v`→`multiReference`，`t2v`→`text`。
4. 迁移不删任何旧数据键；转换过的节点带 `_migrated_from`；拆分的批量节点首个保留原 id，其余 `${id}__${i}`。
5. 后端保存画布要保留 `schema_version`（已派给 T2）。
6. 后端的 `in`+`refRoles` 组装规则以 T5 的 `server/app/canvas/inputs.py` 为准，前端 `kit/assembleInputs.ts` 必须与之一致（W3 校对）。

## W2 约定（协调人 2026-10-15 补）

7. **媒体生成统一用 `kit/useGeneration`**：`const gen = useGeneration(id, actions.update)`；`gen.run({nodeType, kind, data, assembled: assembleInputs({...}), providerId, params, smartPlan, intent})`。它负责直接生成 / 智能规划两条路径、视频轮询、`agent_state`、`history` 追加；`gen.cancel()` 停止等待并丢弃结果。不要自己调 `executeAgentNode` / `canvasAgentGenerate`。
8. **生成源列表**用 `kit/useProviderSources(kind)`、定义用 `useProviderDefinition(id)`；槽位用 `providerSkills.extractSlotsFromProvider(def)`，参数控件用 `providerSkills.paramsSchemaToSpecs` + `controls/DynamicControl`（保留 x-agent 徽标）。
9. **宿主能力只经 `useKitNodeActions(id)`**：`update`、`rename`、`remove`、`copy`、`duplicate`、`saveToAssets`、`openFullscreen`、`execute(overrides)`（文本技能 / director3d 规划 / custom / ext-node 等走宿主原有分支）、`createNodes(specs, {placement, connectFrom})`（宫格切分、截帧、分离音轨、截取、变速、3D 导出等产物落成新节点）、`navigate(tab, payload)`、`projectId`。
10. **媒体处理接口**用 `client/src/services/mediaOps.ts`（契约见 progress/T2.md）。上传素材沿用现有 `apiService` 的上传 / 素材接口（看 `nodes/LoaderNodes.tsx` 现在怎么传）。
11. **节点文件只写在自己的 `nodes2/<dir>/` 下**，用 `defineNode` 注册，并在 `nodes2/<dir>/index.ts` 导出；**不要**改 `CreativeCanvas.tsx`、`nodes2/index.ts`、`kit/**`（kit 有缺陷就在 progress 里写清楚，协调人统一改）。
12. **自测**：各自起临时 vite（端口见下）+ `__dev__/*Showcase.tsx` 演示页，`VITE_API_ORIGIN=http://127.0.0.1:8001`（后端 CORS 放行任意 localhost 端口）。测完停掉、删临时 HTML。端口：N1 5191、N2 5192、N3 5193、N4 5194、N5 5195、N6 5196、N7 5197。不要用 5180（集成实例）。
13. 并行期间 `tsc -b` 可能报出别人目录的错误：只修自己目录里的。
