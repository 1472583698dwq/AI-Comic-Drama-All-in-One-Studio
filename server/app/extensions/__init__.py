# -*- coding: utf-8 -*-
"""统一扩展注册表 (Unified Extension Registry) —— Step 1/2/3/4。

万物皆 Extension，只是 kind 不同。后端各管家（providers/skills/workflows/
custom_nodes/plugins）保留存储与实现，本包只做统一门面：

- Step 1 只读聚合：list / get / search（本文件 + adapters.py，不碰写口）
- Step 2 统一执行：POST /extensions/execute 按 kind 路由到既有执行器
- Step 3 统一写口：install/enable/disable/uninstall 状态机 + 跨 kind 去重
- Step 4 新 kind 转正：storyboard_slot 等只新增 kind 适配器，不改核心
"""
from .models import (
    ExtensionKind,
    ExtensionStatus,
    ExtensionSource,
    ExtensionInfo,
    KIND_LABELS,
    EXECUTABLE_KINDS,
    LIFECYCLE_KINDS,
    OVERLAY_LIFECYCLE_KINDS,
    PLACEHOLDER_KINDS,
)
from .registry import extension_registry, ExtensionRegistry

__all__ = [
    "ExtensionKind",
    "ExtensionStatus",
    "ExtensionSource",
    "ExtensionInfo",
    "KIND_LABELS",
    "EXECUTABLE_KINDS",
    "LIFECYCLE_KINDS",
    "OVERLAY_LIFECYCLE_KINDS",
    "PLACEHOLDER_KINDS",
    "extension_registry",
    "ExtensionRegistry",
]
