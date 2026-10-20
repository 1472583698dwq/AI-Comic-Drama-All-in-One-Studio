# -*- coding: utf-8 -*-
"""3D 导演台 Agent 控制内核 — 纯数据操作（不做 IO），供 MCP 工具与测试共用。

设计：
- `stage_state(content, ...)`：只读侦察（实体/关节/机位/走位/灯光/可选枚举），不修改内容；
- `apply_stage_control(content, args)`：写操作（姿势/关节/位姿/运镜/走位/道具/灯光/演员阵），
  **就地修改** content 并返回 {shot_id, shot_index, stage_patch}；
  调用方（MCP 处理器）负责 project_manager.save_content 与前端实时应用。

关节与前端 `Director3DStage.createPoseMannequin` 的 rig 同名同限位（单一口径）：
had 对应 group 的局部欧拉角 XYZ（弧度），肘/膝为铰链限位。
"""
from typing import Any, Dict, List, Optional, Tuple

JOINTS = (
    "waist", "neck",
    "shoulder_L", "shoulder_R", "elbow_L", "elbow_R",
    "hip_L", "hip_R", "knee_L", "knee_R",
)

JOINT_LIMITS: Dict[str, Dict[str, Tuple[float, float]]] = {
    "waist": {"x": (-0.6, 0.6), "y": (-1.0, 1.0), "z": (-0.5, 0.5)},
    "neck": {"x": (-0.7, 0.7), "y": (-1.4, 1.4), "z": (-0.5, 0.5)},
    "shoulder_L": {"x": (-2.6, 0.9), "y": (-1.0, 1.0), "z": (-0.5, 1.8)},
    "shoulder_R": {"x": (-2.6, 0.9), "y": (-1.0, 1.0), "z": (-1.8, 0.5)},
    "elbow_L": {"x": (-2.6, 0.1), "y": (-0.25, 0.25), "z": (-0.6, 0.6)},
    "elbow_R": {"x": (-2.6, 0.1), "y": (-0.25, 0.25), "z": (-0.6, 0.6)},
    "hip_L": {"x": (-1.7, 1.2), "y": (-0.7, 0.7), "z": (-0.8, 0.8)},
    "hip_R": {"x": (-1.7, 1.2), "y": (-0.7, 0.7), "z": (-0.8, 0.8)},
    "knee_L": {"x": (0.0, 2.2), "y": (-0.1, 0.1), "z": (-0.1, 0.1)},
    "knee_R": {"x": (0.0, 2.2), "y": (-0.1, 0.1), "z": (-0.1, 0.1)},
}

POSE_PRESETS = ("stand", "fight", "look_back", "run", "cast_spell", "kneel", "defend", "fly", "injured")
FRAMING_PRESETS = (
    "extreme_close_up", "close_up", "medium", "full", "long",
    "bird_eye", "low_angle", "over_shoulder", "dutch_angle", "high_angle",
)
MOTION_PRESETS = (
    "static", "push_in", "pull_out", "pan_left", "pan_right", "tilt_up", "tilt_down",
    "orbit", "orbit_ccw", "truck_left", "truck_right", "boom_up", "boom_down",
    "roll_left", "roll_right", "tracking", "shake", "dolly_zoom", "orbit_boom_up",
    "pan_left_crane_down", "fast_push_shake", "low_angle_truck_right",
)
CAST_LAYOUTS = ("solo", "duel", "ots", "surrounded")
STAGE_PROPS = ("sword", "shield", "magic_circle", "spirit_particles", "chair", "helmet", "camera", "avocado", "boombox")
MOTION_SPEEDS = ("0.5x", "1.0x", "1.5x", "2.0x")

_ENTITY_KEYS = ("entity_protagonist", "entity_antagonist", "entity_supporting")


class StageControlError(ValueError):
    """入参非法（工具层转成明错返回，不静默吞）。"""


def _all_shots(content: Any) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    if not isinstance(content, dict):
        return out
    for sc in content.get("scenes") or []:
        if isinstance(sc, dict):
            for sh in sc.get("shots") or []:
                if isinstance(sh, dict):
                    out.append(sh)
    return out


def find_shot(content: Any, shot_id: str = "", shot_index: Any = None) -> Optional[Dict[str, Any]]:
    shots = _all_shots(content)
    if not shots:
        return None
    sid = str(shot_id or "").strip()
    if sid:
        for sh in shots:
            if str(sh.get("id") or "") == sid:
                return sh
        return None
    if shot_index is not None:
        try:
            idx = int(shot_index)
        except Exception:
            idx = None
        if idx is not None:
            for sh in shots:
                try:
                    if int(sh.get("shot_index") or -1) == idx:
                        return sh
                except Exception:
                    continue
            return None
    return shots[0]


def _clamp(v: Any, lo: float, hi: float, default: float = 0.0) -> float:
    try:
        f = float(v)
    except Exception:
        return default
    return max(lo, min(hi, f))


def _num3(raw: Any, lo: float = -6.0, hi: float = 6.0) -> List[float]:
    seq = raw if isinstance(raw, (list, tuple)) else []
    out: List[float] = []
    for i in range(3):
        out.append(_clamp(seq[i] if i < len(seq) else 0.0, lo, hi))
    return out


def _ensure_pose(content: Any, shot: Dict[str, Any]) -> Dict[str, Any]:
    pose = shot.get("mannequin_pose")
    if not isinstance(pose, dict) or int(pose.get("v") or 0) < 1:
        pose = {"v": 1, "entities": {}}
        shot["mannequin_pose"] = pose
    if not isinstance(pose.get("entities"), dict):
        pose["entities"] = {}
    return pose


def _check_entity(entity: str, joints: bool = False) -> str:
    ent = str(entity or "").strip() or "entity_protagonist"
    if not ent.startswith(("entity_", "prop_", "custom_")):
        raise StageControlError(f"实体名非法: {ent}（应形如 entity_protagonist / prop_sword / custom_xxx）")
    if joints and not ent.startswith("entity_"):
        raise StageControlError(f"只有角色布偶可设关节，收到: {ent}")
    return ent


def stage_state(content: Any, shot_id: str = "", shot_index: Any = None) -> Dict[str, Any]:
    """只读侦察：返回当前镜头的 3D 舞台状态 + 智能体可用的枚举（单一口径）。

    项目暂无分镜时不报错：返回 shots_total=0 + 行动指引（先 split_novel_script 或 create_shot），
    避免 Agent 被"没有分镜"直接卡死。
    """
    shots = _all_shots(content)
    available = {
        "entities": list(_ENTITY_KEYS),
        "joints": list(JOINTS),
        "joint_limits": {k: {ax: list(rng) for ax, rng in v.items()} for k, v in JOINT_LIMITS.items()},
        "pose_presets": list(POSE_PRESETS),
        "framings": list(FRAMING_PRESETS),
        "motions": list(MOTION_PRESETS),
        "cast_layouts": list(CAST_LAYOUTS),
        "props": list(STAGE_PROPS),
        "motion_speeds": list(MOTION_SPEEDS),
    }
    if not shots:
        scenes = (content or {}).get("scenes") if isinstance(content, dict) else []
        return {
            "shots_total": 0,
            "scenes_total": len(scenes or []),
            "title": (content or {}).get("title") if isinstance(content, dict) else "",
            "hint": ("项目暂无分镜：画布节点不是分镜，不会出现这里。两条路："
                     "① split_novel_script(novel_text=...) 拆解剧本（会自动落盘本项目的角色与分镜）；"
                     "② stage_control(action='create_shot', payload={action_desc:'...'}) 直接建一个分镜后再控制。"),
            "available": available,
        }
    shot = find_shot(content, shot_id=shot_id, shot_index=shot_index)
    if shot is None:
        raise StageControlError(f"未找到指定分镜（shot_id={shot_id or '-'} shot_index={shot_index}），"
                                f"当前共 {len(shots)} 镜；不传这两个参数则默认取第一镜")
    return {
        "shots_total": len(shots),
        "shot_id": shot.get("id"),
        "shot_index": shot.get("shot_index"),
        "action_desc": (shot.get("action_desc") or "")[:160],
        "pose_preset": shot.get("pose_preset") or "stand",
        "mannequin_pose": shot.get("mannequin_pose") or {"v": 1, "entities": {}},
        "stage_layout": shot.get("stage_layout") or {},
        "stage_cameras": shot.get("stage_cameras") or [],
        "walk_path": shot.get("walk_path") or [],
        "camera_framing": shot.get("camera_framing") or "medium",
        "camera_motion": shot.get("camera_motion") or "push_in",
        "focal_length_mm": shot.get("focal_length_mm") or 35,
        "camera_roll_deg": shot.get("camera_roll_deg") or 0,
        "cast_layout": shot.get("cast_layout") or "solo",
        "props_config": shot.get("props_config") or [],
        "lighting_config": shot.get("lighting_config") or {},
        "previz_video_url": shot.get("previz_video_url") or "",
        "clay_video_url": shot.get("clay_video_url") or "",
        "clay_prompt": shot.get("clay_prompt") or "",
        "clay_first_frame_url": shot.get("clay_first_frame_url") or "",
        "clay_last_frame_url": shot.get("clay_last_frame_url") or "",
        "available": available,
    }


def _new_shot(scene_index: int, shot_index: int, payload: Dict[str, Any]) -> Dict[str, Any]:
    """新建分镜（默认值照分镜工作台口径）——供 create_shot 与拆解兜底共用。"""
    import uuid as _uuid
    framing = str(payload.get("camera_framing") or "medium")
    if framing not in FRAMING_PRESETS:
        framing = "medium"
    motion = str(payload.get("camera_motion") or "push_in")
    if motion not in MOTION_PRESETS:
        motion = "push_in"
    pose = str(payload.get("pose_preset") or "stand")
    if pose not in POSE_PRESETS:
        pose = "stand"
    action = str(payload.get("action_desc") or payload.get("title") or "新分镜")[:200]
    dialogue = str(payload.get("dialogue") or "")
    props = payload.get("props_config") or []
    walk_path = payload.get("walk_path") or []
    lighting = payload.get("lighting_config") or {}
    cameras = payload.get("stage_cameras") or []
    layout = payload.get("stage_layout") or {}
    pose_raw = payload.get("mannequin_pose") or {"v": 1, "entities": {}}
    return {
        "id": f"shot_{_uuid.uuid4().hex[:10]}",
        "scene_index": scene_index,
        "shot_index": shot_index,
        "camera_framing": framing,
        "camera_motion": motion,
        "pose_preset": pose,
        "action_desc": action,
        "dialogue": dialogue,
        "voiceover": str(payload.get("voiceover") or ""),
        "emotion": "neutral",
        "image_prompt": str(payload.get("image_prompt") or "cinematic anime shot, high quality lighting, masterpiece"),
        "duration": _clamp(payload.get("duration", 3.5), 1.5, 10.0, 3.5),
        "subtitle_text": str(payload.get("subtitle_text") or dialogue or action)[:200],
        "status": "ready",
        # 舞台字段必须随 create_shot 一起落盘：否则后续任何整份保存/远控导出都会按默认值回填
        "focal_length_mm": float(payload.get("focal_length_mm") or 35.0),
        "camera_roll_deg": float(payload.get("camera_roll_deg") or 0.0),
        "cast_layout": str(payload.get("cast_layout") or "solo"),
        "props_config": [str(x) for x in props if str(x).strip()] if isinstance(props, list) else [],
        "walk_path": list(walk_path) if isinstance(walk_path, list) else [],
        "lighting_config": dict(lighting) if isinstance(lighting, dict) else {},
        "stage_cameras": list(cameras) if isinstance(cameras, list) else [],
        "stage_layout": dict(layout) if isinstance(layout, dict) else {},
        "mannequin_pose": dict(pose_raw) if isinstance(pose_raw, dict) else {"v": 1, "entities": {}},
    }


def apply_stage_control(content: Any, arguments: Dict[str, Any]) -> Dict[str, Any]:
    """写操作：就地修改 content 的分镜字段，返回 stage_patch（供前端实时应用）。"""
    args = arguments or {}
    action = str(args.get("action") or "").strip()
    if not action:
        raise StageControlError("stage_control 需要 action（create_shot/set_pose/set_joints/clear_joints/set_transform/"
                                "set_camera/set_waypoints/set_props/set_lighting/set_cast_layout/set_shot_text）")
    payload = args.get("payload") if isinstance(args.get("payload"), dict) else {}
    patch: Dict[str, Any] = {}
    note = ""

    # 建镜头是所有其他控制的入口：项目 0 镜时先走这里（画布节点≠分镜，不能作为挂载点）
    if action == "create_shot":
        scenes = content.get("scenes") if isinstance(content, dict) else None
        if not isinstance(scenes, list):
            scenes = []
            content["scenes"] = scenes
        sidx = None
        try:
            if args.get("scene_index") is not None:
                sidx = int(args.get("scene_index"))
            elif payload.get("scene_index") is not None:
                sidx = int(payload.get("scene_index"))
        except Exception:
            sidx = None
        scene = None
        if sidx is not None:
            scene = next((s for s in scenes if isinstance(s, dict) and int(s.get("scene_index") or -1) == sidx), None)
        if scene is None:
            scene = next((s for s in scenes if isinstance(s, dict)), None)
        if scene is None:
            scene = {"id": f"scene_{len(scenes) + 1}", "scene_index": len(scenes) + 1,
                     "title": str(payload.get("scene_title") or "场景 1"),
                     "location": "", "time_of_day": "day", "atmosphere": "epic",
                     "image_prompt": "", "props": [], "shots": []}
            scenes.append(scene)
        shots = scene.get("shots") if isinstance(scene.get("shots"), list) else []
        scene["shots"] = shots
        created = _new_shot(int(scene.get("scene_index") or 1), len(shots) + 1, payload)
        after = payload.get("after_shot_index")
        if after is not None:
            try:
                pos = next((i for i, s in enumerate(shots) if int(s.get("shot_index") or -1) == int(after)), None)
                if pos is not None:
                    shots.insert(pos + 1, created)
                else:
                    shots.append(created)
            except Exception:
                shots.append(created)
        else:
            shots.append(created)
        for i, s in enumerate(shots):
            if isinstance(s, dict):
                s["shot_index"] = i + 1
        created["shot_index"] = shots.index(created) + 1
        return {
            "shot_id": created.get("id"),
            "shot_index": created.get("shot_index"),
            "scene_index": scene.get("scene_index"),
            "created_shot": created,
            "stage_patch": {},
            "note": f"已新建分镜 #{created['shot_index']}（{created['action_desc'][:40]}）；"
                    f"接下来可直接 stage_control(action='set_pose'/'set_joints'/'set_camera', shot_index={created['shot_index']}) 控制它",
            "hint": "前端会刷新项目并切到该分镜；白模链路见 read_skill('seedance-white-model')",
        }

    shot = find_shot(content, shot_id=str(args.get("shot_id") or ""), shot_index=args.get("shot_index"))
    if shot is None:
        raise StageControlError("项目内没有分镜：先 split_novel_script 拆解剧本，或 "
                                "stage_control(action='create_shot', payload={action_desc:'...'}) 新建一个分镜再控制")

    if action == "set_pose":
        pose = str(payload.get("pose_preset") or payload.get("pose") or "").strip()
        if pose not in POSE_PRESETS:
            raise StageControlError(f"未知姿态: {pose or '(空)'}，可选: {list(POSE_PRESETS)}")
        ent = _check_entity(payload.get("entity") or "entity_protagonist")
        shot["pose_preset"] = pose
        mp = _ensure_pose(content, shot)
        mp["entities"].pop(ent, None)
        if not mp["entities"]:
            shot.pop("mannequin_pose", None)
            patch["mannequin_pose"] = None
        else:
            patch["mannequin_pose"] = mp
        patch["pose_preset"] = pose
        note = f"已将 {ent} 设为姿态「{pose}」并清除该角色自定义关节"

    elif action == "set_joints":
        ent = _check_entity(payload.get("entity") or "entity_protagonist", joints=True)
        joints_in = payload.get("joints") or {}
        if not isinstance(joints_in, dict) or not joints_in:
            raise StageControlError("set_joints 需要 joints: {关节名: [x,y,z] 弧度}")
        unknown = [k for k in joints_in.keys() if k not in JOINT_LIMITS]
        if unknown:
            raise StageControlError(f"未知关节: {unknown}，可选: {list(JOINTS)}")
        mp = _ensure_pose(content, shot)
        cur = mp["entities"].setdefault(ent, {"joints": {}}).setdefault("joints", {})
        for jid, rot in joints_in.items():
            lim = JOINT_LIMITS[jid]
            rot3 = rot if isinstance(rot, (list, tuple)) else []
            cur[jid] = [
                round(_clamp(rot3[0] if len(rot3) > 0 else 0.0, *lim.get("x", (-3.2, 3.2))), 4),
                round(_clamp(rot3[1] if len(rot3) > 1 else 0.0, *lim.get("y", (-3.2, 3.2))), 4),
                round(_clamp(rot3[2] if len(rot3) > 2 else 0.0, *lim.get("z", (-3.2, 3.2))), 4),
            ]
        patch["mannequin_pose"] = mp
        note = f"已设置 {ent} 关节: {','.join(joints_in.keys())}"

    elif action == "clear_joints":
        ent = _check_entity(payload.get("entity") or "entity_protagonist", joints=True)
        mp = _ensure_pose(content, shot)
        mp["entities"].pop(ent, None)
        if not mp["entities"]:
            shot.pop("mannequin_pose", None)
            patch["mannequin_pose"] = None
        else:
            patch["mannequin_pose"] = mp
        note = f"已清除 {ent} 自定义关节（回落到姿态预设）"

    elif action == "set_transform":
        ent = _check_entity(payload.get("entity") or "entity_protagonist")
        layout = shot.get("stage_layout") if isinstance(shot.get("stage_layout"), dict) else {}
        cur = layout.get(ent) if isinstance(layout.get(ent), dict) else {}
        p = _num3(payload.get("p") if "p" in payload else cur.get("p"), -8.0, 8.0)
        r = _num3(payload.get("r") if "r" in payload else cur.get("r"), -3.15, 3.15)
        try:
            s = _clamp(payload.get("s", cur.get("s", 1.0)), 0.1, 5.0, 1.0)
        except Exception:
            s = 1.0
        layout[ent] = {"p": p, "r": r, "s": s}
        shot["stage_layout"] = layout
        patch["stage_layout"] = {ent: layout[ent]}
        note = f"已设置 {ent} 位姿 p={p} r={r} s={s}"

    elif action == "set_camera":
        for key in ("camera_framing", "camera_motion", "cast_layout", "motion_speed"):
            val = str(payload.get(key) or "").strip()
            if not val:
                continue
            valid = {
                "camera_framing": FRAMING_PRESETS,
                "camera_motion": MOTION_PRESETS,
                "cast_layout": CAST_LAYOUTS,
                "motion_speed": MOTION_SPEEDS,
            }[key]
            if val not in valid:
                raise StageControlError(f"{key} 取值非法: {val}，可选: {list(valid)}")
            shot[key] = val
            patch[key] = val
        if "focal_length_mm" in payload:
            fl = _clamp(payload.get("focal_length_mm"), 12.0, 135.0, 35.0)
            shot["focal_length_mm"] = fl
            patch["focal_length_mm"] = fl
        if "camera_roll_deg" in payload:
            roll = _clamp(payload.get("camera_roll_deg"), -45.0, 45.0, 0.0)
            shot["camera_roll_deg"] = roll
            patch["camera_roll_deg"] = roll
        cam = payload.get("camera")
        if isinstance(cam, dict) and isinstance(cam.get("pos"), (list, tuple)) and len(cam.get("pos")) >= 3:
            cams = shot.get("stage_cameras") if isinstance(shot.get("stage_cameras"), list) else []
            pos = _num3(cam.get("pos"), -50.0, 50.0)
            quat = cam.get("quat") if isinstance(cam.get("quat"), (list, tuple)) and len(cam.get("quat")) >= 4 else [0, 0, 0, 1]
            fov = _clamp(cam.get("fov", 35), 12.0, 120.0, 35.0)
            cams.append({
                "id": str(cam.get("id") or f"cam_agent_{len(cams) + 1}"),
                "name": str(cam.get("name") or f"Agent机位{len(cams) + 1}"),
                "pos": pos,
                "quat": [float(x) for x in list(quat)[:4]],
                "fov": fov,
            })
            shot["stage_cameras"] = cams
            patch["stage_cameras"] = cams
        if not patch:
            raise StageControlError("set_camera 需要至少一个字段：camera_framing/camera_motion/focal_length_mm/"
                                    "camera_roll_deg/motion_speed/cast_layout/camera{pos,quat,fov,name}")
        note = "已更新机位/运镜: " + ",".join(patch.keys())

    elif action == "set_waypoints":
        pts_in = payload.get("points")
        if not isinstance(pts_in, list):
            raise StageControlError("set_waypoints 需要 points: [{x,z}, ...]（地面路径，≤6 点）")
        pts = []
        for it in pts_in[:6]:
            if not isinstance(it, dict):
                continue
            pts.append({"x": round(_clamp(it.get("x"), -6.0, 6.0, 0.0), 3),
                        "z": round(_clamp(it.get("z"), -6.0, 6.0, 0.0), 3)})
        shot["walk_path"] = pts
        patch["walk_path"] = pts
        note = f"已设置主角走位路径 {len(pts)} 点"

    elif action == "set_props":
        props_in = payload.get("props") if isinstance(payload.get("props"), list) else []
        props = [str(x) for x in props_in if str(x) in STAGE_PROPS]
        shot["props_config"] = props
        patch["props_config"] = props
        note = f"已设置道具: {props or '（清空）'}"

    elif action == "set_lighting":
        cur = shot.get("lighting_config") if isinstance(shot.get("lighting_config"), dict) else {}
        merged = {
            "keyIntensity": _clamp(payload.get("keyIntensity", cur.get("keyIntensity", 3.2)), 0.0, 12.0, 3.2),
            "keyAzimuth": _clamp(payload.get("keyAzimuth", cur.get("keyAzimuth", 40)), -180.0, 180.0, 40.0),
            "keyTemp": str(payload.get("keyTemp") or cur.get("keyTemp") or "neon"),
            "rimIntensity": _clamp(payload.get("rimIntensity", cur.get("rimIntensity", 3.5)), 0.0, 12.0, 3.5),
            "ambientIntensity": _clamp(payload.get("ambientIntensity", cur.get("ambientIntensity", 1.8)), 0.0, 12.0, 1.8),
            "exposure": _clamp(payload.get("exposure", cur.get("exposure", 1.15)), 0.2, 3.0, 1.15),
        }
        if merged["keyTemp"] not in ("neon", "cold", "warm", "moon"):
            merged["keyTemp"] = "neon"
        shot["lighting_config"] = merged
        patch["lighting_config"] = merged
        note = "已更新三点光参数"

    elif action == "set_cast_layout":
        val = str(payload.get("cast_layout") or "").strip()
        if val not in CAST_LAYOUTS:
            raise StageControlError(f"未知站位: {val or '(空)'}，可选: {list(CAST_LAYOUTS)}")
        shot["cast_layout"] = val
        patch["cast_layout"] = val
        note = f"已设置站位阵型「{val}」（Antagonist/Supporting 布偶会自动就位）"

    elif action == "set_shot_text":
        # 文字字段（分镜台手工编辑的同一组）：Agent 能改动作描述/台词/提示词，不再只能改舞台参数
        text_fields = ("action_desc", "dialogue", "voiceover", "speaker_name", "image_prompt", "video_prompt", "subtitle_text")
        for key in text_fields:
            if key not in payload:
                continue
            limit = 500 if key in ("image_prompt", "video_prompt") else 200
            shot[key] = str(payload.get(key) or "")[:limit]
            patch[key] = shot[key]
        if not patch:
            raise StageControlError("set_shot_text 需要至少一个文字字段：" + "/".join(text_fields))
        note = "已更新分镜文字: " + ",".join(patch.keys())

    else:
        raise StageControlError(f"未知 action: {action}")

    return {
        "shot_id": shot.get("id"),
        "shot_index": shot.get("shot_index"),
        "stage_patch": patch,
        "note": note,
        "hint": "前端导演台会实时应用该 patch；白模导出/视频生成走 read_skill('seedance-white-model')",
    }
