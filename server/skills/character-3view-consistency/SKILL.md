---
name: character-3view-consistency
description: 角色全生命周期三视图与服饰一致性锚定技能。为主角自动组装 0°正面、90°侧面与 45°动态视角提示词，并调用 ComfyUI / IP-Adapter 锁定面部特征。
version: 1.0.0
author: Alibaba LumenX & MiniMax
category: character_design
tools:
  - comfyui_render_node
---

# 角色全生命周期三视图与服饰一致性技能 (Character 3-View Consistency)

## 技能定位与核心目标
解决漫剧生产中最棘手的“角色跨镜头变脸、服饰穿帮”痛点，基于小云雀 Seedance 2.0 与 IP-Adapter 机制自动化生成标准化角色三视图并锁定特征。

## 技能执行 SOP 与工具调用链
1. **角色特征提炼**：
   - 提取角色的固定外貌锚点：发色、眼眸特征（如“金色神辉眼眸”）、标志性服饰（如“玄黑古风战袍”）、性格体态。
2. **三视图 Prompt 组装**：
   - 正面视图 (Front 0°): `character sheet, full body front view, standing pose, clean neutral background`
   - 侧面视图 (Side 90°): `character sheet, full body side profile view, clean neutral background`
   - 3/4 动态视角 (Dynamic 45°): `character sheet, dynamic heroic combat stance, volumetric lighting`
3. **调用外部生图 MCP (`comfyui_render_node`)**：
   - 触发本地/远程 ComfyUI 流程，导出三视图与特征向量，并同步至系统角色资产库。
