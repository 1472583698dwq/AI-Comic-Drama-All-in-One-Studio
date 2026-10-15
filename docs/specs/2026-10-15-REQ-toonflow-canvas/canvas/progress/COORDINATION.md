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
