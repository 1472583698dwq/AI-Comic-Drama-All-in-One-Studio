# -*- coding: utf-8 -*-
"""分镜工作台槽（storyboard_slots）存储与聚合。实现见 slots.py。"""
from .slots import (
    SLOT_CONTAINERS,
    BUILTIN_SLOT_CATALOG,
    validate_slot_doc,
    list_effective_slots,
    get_project_overrides,
    set_project_overrides,
    save_custom_slot,
    delete_custom_slot,
)

__all__ = [
    "SLOT_CONTAINERS",
    "BUILTIN_SLOT_CATALOG",
    "validate_slot_doc",
    "list_effective_slots",
    "get_project_overrides",
    "set_project_overrides",
    "save_custom_slot",
    "delete_custom_slot",
]
