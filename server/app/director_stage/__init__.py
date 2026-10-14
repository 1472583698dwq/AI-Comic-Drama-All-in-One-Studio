# -*- coding: utf-8 -*-
"""3D 导演台 Agent 控制内核（纯数据，无 IO）。"""
from .ops import (  # noqa: F401
    JOINTS,
    JOINT_LIMITS,
    POSE_PRESETS,
    FRAMING_PRESETS,
    MOTION_PRESETS,
    CAST_LAYOUTS,
    STAGE_PROPS,
    find_shot,
    stage_state,
    apply_stage_control,
)
