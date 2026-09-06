// -*- coding: utf-8 -*-
/**
 * 导演台预设同源常量 — 3D 舞台与画布 director3d 节点共用，避免两边各写各的导致选项断层。
 * 纯数据模块（不依赖 three），舞台与节点均从此 import。
 */
import type { CameraFraming, CameraMotion, PosePreset, CastLayout } from '../../types';

export const FRAMING_PRESETS: Array<{ id: CameraFraming; label: string; fl: number; desc: string }> = [
  { id: 'extreme_close_up', label: '大特写 (ECU)', fl: 85, desc: '眼神/微表情震撼特写' },
  { id: 'close_up', label: '特写 (CU)', fl: 50, desc: '面部与半身情绪聚焦' },
  { id: 'medium', label: '中景 (MS)', fl: 35, desc: '胸部以上经典叙事' },
  { id: 'full', label: '全景 (FS)', fl: 28, desc: '全身与站位动作展示' },
  { id: 'long', label: '远景 (LS)', fl: 24, desc: '宏大环境与场景纵深' },
  { id: 'bird_eye', label: '鸟瞰俯冲', fl: 20, desc: '高空俯视压迫视角' },
  { id: 'low_angle', label: '贴地仰角', fl: 28, desc: '低机位霸气英雄感' },
  { id: 'over_shoulder', label: '过肩对峙', fl: 40, desc: '双人对决纵深机位' },
  { id: 'dutch_angle', label: '荷兰角倾斜', fl: 32, desc: '悬疑与心理压迫' },
  { id: 'high_angle', label: '高角度俯视', fl: 28, desc: '俯视弱化视点' },
];

export const MOTION_PRESETS: Array<{
  id: CameraMotion;
  label: string;
  category: 'single' | 'combo';
  desc: string;
  minimaxCode: string;
}> = [
  { id: 'static', label: '固定镜头 (Static)', category: 'single', desc: '机位静止固定', minimaxCode: 'Static Camera' },
  { id: 'push_in', label: '急进推镜 (Dolly In)', category: 'single', desc: '镜头逼近主角', minimaxCode: 'Dolly In' },
  { id: 'pull_out', label: '渐远拉出 (Dolly Out)', category: 'single', desc: '由近及远展示环境', minimaxCode: 'Dolly Out' },
  { id: 'pan_left', label: '左摇镜头 (Pan Left)', category: 'single', desc: '水平向左平滑扫视', minimaxCode: 'Pan Left' },
  { id: 'pan_right', label: '右摇镜头 (Pan Right)', category: 'single', desc: '水平向右平滑扫视', minimaxCode: 'Pan Right' },
  { id: 'tilt_up', label: '上仰升镜 (Tilt Up)', category: 'single', desc: '由下向上仰视扫视', minimaxCode: 'Tilt Up' },
  { id: 'tilt_down', label: '下俯摇镜 (Tilt Down)', category: 'single', desc: '由上向下俯视扫视', minimaxCode: 'Tilt Down' },
  { id: 'orbit', label: '360° 顺时针环绕 (Orbit)', category: 'single', desc: '英雄弧形环拍', minimaxCode: 'Orbit Clockwise' },
  { id: 'orbit_ccw', label: '逆时针环绕 (Orbit CCW)', category: 'single', desc: '逆向弧形环拍', minimaxCode: 'Orbit Counter-Clockwise' },
  { id: 'truck_left', label: '左横移 (Truck Left)', category: 'single', desc: '机位平行向左平移', minimaxCode: 'Truck Left' },
  { id: 'truck_right', label: '右横移 (Truck Right)', category: 'single', desc: '机位平行向右平移', minimaxCode: 'Truck Right' },
  { id: 'boom_up', label: '升降机升 (Boom Up)', category: 'single', desc: '垂直升起镜头', minimaxCode: 'Boom Up' },
  { id: 'boom_down', label: '升降机降 (Boom Down)', category: 'single', desc: '垂直下降镜头', minimaxCode: 'Boom Down' },
  { id: 'roll_left', label: '左滚转 (Roll Left)', category: 'single', desc: '镜头逆时针翻滚', minimaxCode: 'Roll Left' },
  { id: 'roll_right', label: '右滚转 (Roll Right)', category: 'single', desc: '镜头顺时针翻滚', minimaxCode: 'Roll Right' },
  { id: 'tracking', label: '前向跟随 (Tracking)', category: 'single', desc: '跟随主体向前推进', minimaxCode: 'Forward Tracking' },
  { id: 'shake', label: '战斗震颤 (Shake)', category: 'single', desc: '冲击感手持震动', minimaxCode: 'Handheld Camera Shake' },
  { id: 'dolly_zoom', label: '希区柯克变焦 (Vertigo Zoom)', category: 'combo', desc: '推镜反向变焦，空间扭曲', minimaxCode: 'Dolly Zoom (Vertigo)' },
  { id: 'orbit_boom_up', label: '弧旋升镜 (Orbit + Boom Up)', category: 'combo', desc: '环绕+垂直升起，英雄登场', minimaxCode: 'Orbit + Boom Up' },
  { id: 'pan_left_crane_down', label: '全景俯切 (Pan Left + Crane Down)', category: 'combo', desc: '左扫同时俯冲，战场切入', minimaxCode: 'Pan Left + Crane Down' },
  { id: 'fast_push_shake', label: '极速推镜+冲击 (Explosive Push)', category: 'combo', desc: '爆点推进带震颤，招式命中', minimaxCode: 'Explosive Push + Shake' },
  { id: 'low_angle_truck_right', label: '贴地侧滑 (Low Truck Right)', category: 'combo', desc: '低机位右横移，霸气侧身', minimaxCode: 'Low Angle + Truck Right' },
];

export const POSE_PRESETS: Array<{ id: PosePreset; label: string; icon: string }> = [
  { id: 'stand', label: '傲然站立', icon: '🧍' },
  { id: 'fight', label: '武道架势', icon: '🥋' },
  { id: 'look_back', label: '回眸凝视', icon: '👀' },
  { id: 'run', label: '极速突进', icon: '🏃' },
  { id: 'cast_spell', label: '御剑施法', icon: '⚡' },
  { id: 'kneel', label: '受创半跪', icon: '🧎' },
  { id: 'defend', label: '横刀格挡', icon: '🛡️' },
  { id: 'fly', label: '凌空御风', icon: '🦅' },
  { id: 'injured', label: '战损踉跄', icon: '💥' },
];

export const CAST_LAYOUTS: Array<{ id: CastLayout; label: string; desc: string }> = [
  { id: 'solo', label: '单人焦点', desc: '主角独奏，聚焦核心' },
  { id: 'duel', label: '双人对峙', desc: '主角 VS 宿敌双向对抗' },
  { id: 'ots', label: '过肩纵深', desc: '前景肩景 + 背景对手' },
  { id: 'surrounded', label: '群戏包围', desc: '四方包围阵形' },
];

/** 景别/运镜 id → 中文短标签（画布节点非选中态展示用，与舞台同源） */
export function framingShortLabel(id?: string): string {
  return FRAMING_PRESETS.find((f) => f.id === id)?.label || id || '中景 (MS)';
}

export function motionShortLabel(id?: string): string {
  return MOTION_PRESETS.find((m) => m.id === id)?.label || id || '急进推镜 (Dolly In)';
}
