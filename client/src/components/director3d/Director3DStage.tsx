import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as THREE from 'three';
import { 
  Camera, 
  Move, 
  Rotate3d, 
  Eye, 
  Crosshair, 
  Sparkles, 
  Check, 
  Maximize2,
  Video,
  Play,
  Pause,
  Layers,
  RefreshCw,
  Sliders,
  Compass,
  Monitor,
  ChevronDown,
  Shield,
  Sword,
  Wand2,
  Users,
  Grid,
  Sun,
  CameraOff,
  Zap,
  Download,
  Flame,
  ArrowRight,
  Focus,
  Activity,
  Maximize
} from 'lucide-react';
import { useProjectStore } from '../../stores/useProjectStore';
import { useMcpStore } from '../../stores/useMcpStore';
import { 
  CameraFraming, 
  CameraMotion, 
  PosePreset, 
  CastLayout, 
  StagePropType, 
  StageEnvironment,
  StoryboardShot 
} from '../../types';

// ============================================================
// MiniMax 01-Director Camera & Staging Configs
// ============================================================
const FRAMING_PRESETS: Array<{ id: CameraFraming; label: string; fl: number; desc: string }> = [
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

const MOTION_PRESETS: Array<{ 
  id: CameraMotion; 
  label: string; 
  category: 'single' | 'combo'; 
  desc: string;
  minimaxCode: string;
}> = [
  // 15+ 基础单轴运镜
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
  
  // 5 大电影级双轴复合运镜
  { id: 'dolly_zoom', label: '希区柯克变焦 (Vertigo Zoom)', category: 'combo', desc: '推镜反向变焦，空间扭曲', minimaxCode: 'Dolly Zoom (Vertigo)' },
  { id: 'orbit_boom_up', label: '弧旋升镜 (Orbit + Boom Up)', category: 'combo', desc: '环绕+垂直升起，英雄登场', minimaxCode: 'Orbit + Boom Up' },
  { id: 'pan_left_crane_down', label: '全景俯切 (Pan Left + Crane Down)', category: 'combo', desc: '左扫同时俯冲，战场切入', minimaxCode: 'Pan Left + Crane Down' },
  { id: 'fast_push_shake', label: '极速推镜+冲击 (Explosive Push)', category: 'combo', desc: '爆点推进带震颤，招式命中', minimaxCode: 'Explosive Push + Shake' },
  { id: 'low_angle_truck_right', label: '贴地侧滑 (Low Truck Right)', category: 'combo', desc: '低机位右横移，霸气侧身', minimaxCode: 'Low Angle + Truck Right' },
];

const POSE_PRESETS: Array<{ id: PosePreset; label: string; icon: string }> = [
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

const CAST_LAYOUTS: Array<{ id: CastLayout; label: string; desc: string }> = [
  { id: 'solo', label: '单人焦点', desc: '主角独奏，聚焦核心' },
  { id: 'duel', label: '双人对峙', desc: '主角 VS 宿敌双向对抗' },
  { id: 'ots', label: '过肩纵深', desc: '前景肩景 + 背景对手' },
  { id: 'surrounded', label: '群戏包围', desc: '四方包围阵形' },
];

const FOCAL_PRESETS = [16, 24, 35, 50, 85, 135];

export const Director3DStage: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const pipContainerRef = useRef<HTMLDivElement>(null);
  const { project, activeShotId, setActiveShotId, updateShot } = useProjectStore();
  const { invokeTool } = useMcpStore();

  const shots = project?.scenes.flatMap((s) => s.shots) || [];
  const activeShot = shots.find((sh) => sh.id === activeShotId) || shots[0];

  // 1. Stage & Optical States
  const [framing, setFraming] = useState<CameraFraming>(activeShot?.camera_framing || 'medium');
  const [motion, setMotion] = useState<CameraMotion>(activeShot?.camera_motion || 'push_in');
  const [pose, setPose] = useState<PosePreset>(activeShot?.pose_preset || 'stand');
  const [castLayout, setCastLayout] = useState<CastLayout>(activeShot?.cast_layout || 'solo');
  const [focalLength, setFocalLength] = useState<number>(activeShot?.focal_length_mm || 35);
  const [cameraRoll, setCameraRoll] = useState<number>(activeShot?.camera_roll_deg || 0);
  const [motionSpeed, setMotionSpeed] = useState<'0.5x' | '1.0x' | '1.5x' | '2.0x'>('1.0x');
  const [motionEasing, setMotionEasing] = useState<'linear' | 'ease_in_out' | 'explosive' | 'slow_out'>('ease_in_out');
  const [environment, setEnvironment] = useState<StageEnvironment>('cyber_studio');
  const [propsConfig, setPropsConfig] = useState<StagePropType[]>(['sword', 'magic_circle']);
  
  // 2. Interactive & UI States
  const [selectedEntity, setSelectedEntity] = useState<string | null>('protagonist');
  const [gizmoMode, setGizmoMode] = useState<'translate' | 'rotate' | 'none'>('translate');
  const [compositionGrid, setCompositionGrid] = useState<'rule_of_thirds' | 'golden_ratio' | 'crosshair' | 'diagonal' | 'none'>('rule_of_thirds');
  const [aspectRatioMask, setAspectRatioMask] = useState<'9:16' | '16:9' | '1:1' | '2.35:1'>('9:16');
  
  const [showPip, setShowPip] = useState(true);
  const [showHelpers, setShowHelpers] = useState(true);
  const [showTrajectory, setShowTrajectory] = useState(true);
  const [isSimulating, setIsSimulating] = useState(false);
  const [scrubberProgress, setScrubberProgress] = useState(0); // 0.0 ~ 1.0
  const [activeRightTab, setActiveRightTab] = useState<'optics_motion' | 'cast_props' | 'environment'>('optics_motion');

  // AI Directing Assistant
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiThinking, setAiThinking] = useState(false);
  const [appliedSuccess, setAppliedSuccess] = useState(false);
  const [snapshotSuccess, setSnapshotSuccess] = useState(false);

  // Synchronize with activeShot
  useEffect(() => {
    if (activeShot) {
      if (activeShot.camera_framing) setFraming(activeShot.camera_framing);
      if (activeShot.camera_motion) setMotion(activeShot.camera_motion);
      if (activeShot.pose_preset) setPose(activeShot.pose_preset);
      if (activeShot.focal_length_mm) setFocalLength(activeShot.focal_length_mm);
      if (activeShot.camera_roll_deg !== undefined) setCameraRoll(activeShot.camera_roll_deg);
      if (activeShot.cast_layout) setCastLayout(activeShot.cast_layout);
      if (activeShot.props_config) setPropsConfig(activeShot.props_config);
    }
  }, [activeShotId, activeShot]);

  // Three.js References
  const sceneRef = useRef<THREE.Scene | null>(null);
  const mainCameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const virtualCameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const pipRendererRef = useRef<THREE.WebGLRenderer | null>(null);
  
  // Entity Group References
  const stageEntitiesGroupRef = useRef<THREE.Group | null>(null);
  const protagonistGroupRef = useRef<THREE.Group | null>(null);
  const antagonistGroupRef = useRef<THREE.Group | null>(null);
  const supportingGroupRef = useRef<THREE.Group | null>(null);
  const trajectoryLineRef = useRef<THREE.Line | null>(null);
  const cameraHelperRef = useRef<THREE.CameraHelper | null>(null);

  // Orbit navigation state for main viewport
  const orbitStateRef = useRef({
    isRotating: false,
    isPanning: false,
    prevX: 0,
    prevY: 0,
    target: new THREE.Vector3(0, 1.2, 0),
    radius: 4.8,
    theta: 0,
    phi: Math.PI / 3.0,
  });

  // Selected object position state for dragging / gizmo
  const entityPositionsRef = useRef<Record<string, THREE.Vector3>>({
    protagonist: new THREE.Vector3(0, 0, 0),
    antagonist: new THREE.Vector3(0, 0, -2.2),
    supporting: new THREE.Vector3(-1.8, 0, -1.0),
  });

  // Update Main Camera position based on spherical coordinates
  const updateMainCameraPosition = useCallback(() => {
    if (!mainCameraRef.current) return;
    const { target, radius, theta, phi } = orbitStateRef.current;
    const clampedPhi = Math.max(0.05, Math.min(Math.PI - 0.05, phi));
    const x = target.x + radius * Math.sin(clampedPhi) * Math.sin(theta);
    const y = target.y + radius * Math.cos(clampedPhi);
    const z = target.z + radius * Math.sin(clampedPhi) * Math.cos(theta);
    mainCameraRef.current.position.set(x, y, z);
    mainCameraRef.current.lookAt(target);
  }, []);

  // Compute MiniMax 01-Director Structured Prompt string
  const minimaxPromptPreview = useMemo(() => {
    const framingObj = FRAMING_PRESETS.find(f => f.id === framing);
    const motionObj = MOTION_PRESETS.find(m => m.id === motion);
    const parts = [
      `Motion: ${motionObj?.minimaxCode || motion}`,
      `Framing: ${framingObj?.label || framing}`,
      `Lens: ${focalLength}mm`,
    ];
    if (Math.abs(cameraRoll) > 0.5) parts.push(`Dutch Roll: ${cameraRoll > 0 ? '+' : ''}${cameraRoll.toFixed(1)}°`);
    if (motionSpeed !== '1.0x') parts.push(`Speed: ${motionSpeed}`);
    if (castLayout !== 'solo') parts.push(`Cast Staging: ${castLayout.toUpperCase()}`);
    return `[Camera: ${parts.join(', ')}]`;
  }, [framing, motion, focalLength, cameraRoll, motionSpeed, castLayout]);

  // Reset Main 3D View
  const handleResetView = useCallback(() => {
    orbitStateRef.current.target.set(0, 1.2, 0);
    orbitStateRef.current.radius = 4.8;
    orbitStateRef.current.theta = 0;
    orbitStateRef.current.phi = Math.PI / 3.0;
    updateMainCameraPosition();
  }, [updateMainCameraPosition]);

  // ============================================================
  // Initialize Three.js Stage & Viewports
  // ============================================================
  useEffect(() => {
    if (!containerRef.current) return;

    const width = containerRef.current.clientWidth;
    const height = containerRef.current.clientHeight;

    // 1. Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x07070a);
    scene.fog = new THREE.FogExp2(0x07070a, 0.05);
    sceneRef.current = scene;

    // 2. Main Navigation Camera
    const mainCamera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    mainCameraRef.current = mainCamera;
    updateMainCameraPosition();

    // 3. Virtual Shooting Camera (The Director's Cinematic Lens)
    const virtualCam = new THREE.PerspectiveCamera(35, 9 / 16, 0.1, 50);
    virtualCam.position.set(0, 1.3, 2.5);
    virtualCam.lookAt(0, 1.2, 0);
    scene.add(virtualCam);
    virtualCameraRef.current = virtualCam;

    // Camera Frustum Helper
    const helper = new THREE.CameraHelper(virtualCam);
    if (helper.material && !Array.isArray(helper.material)) {
      (helper.material as THREE.Material).opacity = 0.4;
      (helper.material as THREE.Material).transparent = true;
    }
    scene.add(helper);
    cameraHelperRef.current = helper;

    // 4. Main WebGL Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    containerRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // 5. Lighting Setup
    const ambientLight = new THREE.AmbientLight(0x1a1528, 2.2);
    scene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(0x7c3aed, 3.8);
    keyLight.position.set(4, 5, 3.5);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 1024;
    keyLight.shadow.mapSize.height = 1024;
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x00d2ff, 4.2);
    rimLight.position.set(-3.5, 3.5, -3);
    scene.add(rimLight);

    const fillLight = new THREE.PointLight(0xff0077, 2.5, 12);
    fillLight.position.set(0, 0.8, 2.2);
    scene.add(fillLight);

    // 6. Ground Stage Matrix
    const gridHelper = new THREE.GridHelper(14, 28, 0x7c3aed, 0x1a1a2e);
    gridHelper.position.y = 0;
    scene.add(gridHelper);

    // Glowing Director Stage Circles
    const ringGeo = new THREE.RingGeometry(1.4, 1.45, 64);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x7c3aed, side: THREE.DoubleSide });
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.rotation.x = Math.PI / 2;
    ringMesh.position.y = 0.01;
    scene.add(ringMesh);

    // 7. Master Stage Entities Group
    const stageEntitiesGroup = new THREE.Group();
    scene.add(stageEntitiesGroup);
    stageEntitiesGroupRef.current = stageEntitiesGroup;

    // 8. Animation Loop
    let reqId: number;
    const animate = () => {
      reqId = requestAnimationFrame(animate);

      // Subtle breath animation for characters
      if (protagonistGroupRef.current) {
        protagonistGroupRef.current.position.y = Math.sin(Date.now() * 0.002) * 0.012;
      }
      if (antagonistGroupRef.current) {
        antagonistGroupRef.current.position.y = Math.sin(Date.now() * 0.002 + 1.2) * 0.012;
      }

      // Rotate magic circle if present
      const magicCircle = scene.getObjectByName('magic_circle_mesh');
      if (magicCircle) {
        magicCircle.rotation.z += 0.008;
      }

      // Floating sword hover
      const floatingSword = scene.getObjectByName('floating_sword_mesh');
      if (floatingSword) {
        floatingSword.position.y = 1.8 + Math.sin(Date.now() * 0.003) * 0.08;
        floatingSword.rotation.y += 0.015;
      }

      // Update Camera Helper
      if (cameraHelperRef.current && virtualCameraRef.current) {
        cameraHelperRef.current.update();
      }

      renderer.render(scene, mainCamera);

      // Render PIP Monitor Viewport
      if (pipRendererRef.current && virtualCameraRef.current) {
        if (cameraHelperRef.current) cameraHelperRef.current.visible = false;
        pipRendererRef.current.render(scene, virtualCameraRef.current);
        if (cameraHelperRef.current && showHelpers) cameraHelperRef.current.visible = true;
      }
    };
    animate();

    // Resize Handler
    const handleResize = () => {
      if (!containerRef.current || !rendererRef.current || !mainCameraRef.current) return;
      const w = containerRef.current.clientWidth;
      const h = containerRef.current.clientHeight;
      mainCameraRef.current.aspect = w / h;
      mainCameraRef.current.updateProjectionMatrix();
      rendererRef.current.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(reqId);
      window.removeEventListener('resize', handleResize);
      if (containerRef.current && renderer.domElement) {
        containerRef.current.removeChild(renderer.domElement);
      }
      renderer.dispose();
    };
  }, [updateMainCameraPosition]);

  // Setup PIP Monitor WebGL Renderer
  useEffect(() => {
    if (!pipContainerRef.current) return;
    const w = pipContainerRef.current.clientWidth;
    const h = pipContainerRef.current.clientHeight;

    const pipRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    pipRenderer.setSize(w, h);
    pipRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    pipContainerRef.current.innerHTML = '';
    pipContainerRef.current.appendChild(pipRenderer.domElement);
    pipRendererRef.current = pipRenderer;

    return () => {
      if (pipContainerRef.current && pipRenderer.domElement) {
        pipContainerRef.current.innerHTML = '';
      }
      pipRenderer.dispose();
    };
  }, [showPip, aspectRatioMask]);

  // ============================================================
  // Re-build Stage Entities (Characters, Props, Cast Layout)
  // ============================================================
  useEffect(() => {
    if (!sceneRef.current || !stageEntitiesGroupRef.current) return;
    const stage = stageEntitiesGroupRef.current;
    
    // Clear old children
    while (stage.children.length > 0) {
      stage.remove(stage.children[0]);
    }

    // 1. Protagonist Mannequin (Neon Violet/Cyan)
    const protagonist = createMannequinMesh({
      pose,
      role: 'protagonist',
      primaryColor: 0x7c3aed,
      accentColor: 0x00d2ff,
      name: 'Protagonist'
    });
    protagonist.name = 'entity_protagonist';
    protagonist.position.copy(entityPositionsRef.current.protagonist);
    stage.add(protagonist);
    protagonistGroupRef.current = protagonist;

    // 2. Antagonist / Duel Opponent if castLayout !== 'solo'
    if (castLayout === 'duel' || castLayout === 'ots' || castLayout === 'surrounded') {
      const antagonist = createMannequinMesh({
        pose: pose === 'fight' ? 'fight' : 'stand',
        role: 'antagonist',
        primaryColor: 0xef4444,
        accentColor: 0xffaa00,
        name: 'Antagonist'
      });
      antagonist.name = 'entity_antagonist';
      if (castLayout === 'duel') {
        antagonist.position.set(0, 0, -2.2);
        antagonist.rotation.y = Math.PI; // Face protagonist
      } else if (castLayout === 'ots') {
        antagonist.position.set(-0.3, 0, -2.4);
        antagonist.rotation.y = Math.PI * 0.9;
      } else if (castLayout === 'surrounded') {
        antagonist.position.set(1.8, 0, -1.2);
        antagonist.rotation.y = -Math.PI * 0.6;
      }
      stage.add(antagonist);
      antagonistGroupRef.current = antagonist;
    }

    // 3. Supporting / Extra characters if 'surrounded'
    if (castLayout === 'surrounded') {
      const supporting1 = createMannequinMesh({
        pose: 'fight',
        role: 'supporting',
        primaryColor: 0x3b82f6,
        accentColor: 0x93c5fd,
        name: 'Supporting'
      });
      supporting1.name = 'entity_supporting';
      supporting1.position.set(-1.8, 0, -1.2);
      supporting1.rotation.y = Math.PI * 0.6;
      stage.add(supporting1);
      supportingGroupRef.current = supporting1;
    }

    // 4. Props & FX
    if (propsConfig.includes('sword')) {
      const sword = createFloatingSwordMesh();
      sword.name = 'floating_sword_mesh';
      sword.position.set(0.6, 1.8, 0.4);
      stage.add(sword);
    }

    if (propsConfig.includes('shield')) {
      const shield = createEnergyShieldMesh();
      shield.name = 'energy_shield_mesh';
      shield.position.set(0, 1.25, 0.5);
      stage.add(shield);
    }

    if (propsConfig.includes('magic_circle')) {
      const magicCircle = createMagicCircleMesh();
      magicCircle.name = 'magic_circle_mesh';
      magicCircle.position.set(0, 0.02, 0);
      stage.add(magicCircle);
    }

  }, [pose, castLayout, propsConfig]);

  // ============================================================
  // Update Virtual Camera Optics & Position Calculation
  // ============================================================
  const updateVirtualCameraOptics = useCallback(() => {
    if (!virtualCameraRef.current) return;
    const vCam = virtualCameraRef.current;

    // 1. Calculate FOV from focal length mm: FOV = 2 * atan(sensorHeight / (2 * fl))
    const sensorHeight = 24;
    const fovCalculated = 2 * Math.atan(sensorHeight / (2 * focalLength)) * (180 / Math.PI);
    vCam.fov = Math.max(12, Math.min(105, fovCalculated));

    // 2. Aspect Ratio
    let aspect = 9 / 16;
    if (aspectRatioMask === '16:9') aspect = 16 / 9;
    else if (aspectRatioMask === '1:1') aspect = 1.0;
    else if (aspectRatioMask === '2.35:1') aspect = 2.35;
    vCam.aspect = aspect;

    // 3. Base Position & LookAt based on framing
    let target = new THREE.Vector3(0, 1.25, 0);
    let camPos = new THREE.Vector3(0, 1.3, 2.5);

    switch (framing) {
      case 'extreme_close_up':
        camPos.set(0, 1.68, 0.75);
        target.set(0, 1.68, 0);
        break;
      case 'close_up':
        camPos.set(0, 1.55, 1.35);
        target.set(0, 1.5, 0);
        break;
      case 'medium':
        camPos.set(0, 1.3, 2.4);
        target.set(0, 1.25, 0);
        break;
      case 'full':
        camPos.set(0, 1.15, 3.8);
        target.set(0, 1.0, 0);
        break;
      case 'long':
        camPos.set(0, 1.6, 6.0);
        target.set(0, 1.1, 0);
        break;
      case 'bird_eye':
        camPos.set(0, 4.5, 2.0);
        target.set(0, 0.5, 0);
        break;
      case 'low_angle':
        camPos.set(0, 0.25, 1.8);
        target.set(0, 1.5, 0);
        break;
      case 'over_shoulder':
        camPos.set(0.55, 1.55, 1.8);
        target.set(-0.2, 1.4, -1.2);
        break;
      case 'dutch_angle':
        camPos.set(0, 1.2, 2.2);
        target.set(0, 1.25, 0);
        break;
      case 'high_angle':
        camPos.set(0, 2.8, 2.8);
        target.set(0, 1.0, 0);
        break;
    }

    vCam.position.copy(camPos);
    vCam.lookAt(target);

    // 4. Apply Dutch Roll Angle
    if (cameraRoll !== 0) {
      vCam.rotation.z = (cameraRoll * Math.PI) / 180;
    }

    vCam.updateProjectionMatrix();

    if (cameraHelperRef.current) {
      cameraHelperRef.current.update();
    }
  }, [framing, focalLength, cameraRoll, aspectRatioMask]);

  useEffect(() => {
    updateVirtualCameraOptics();
  }, [updateVirtualCameraOptics]);

  // ============================================================
  // 3D Motion Spline Path & Simulation Engine
  // ============================================================
  const calculateMotionWaypoints = useCallback((motionType: CameraMotion, startPos: THREE.Vector3, target: THREE.Vector3): THREE.Vector3[] => {
    const points: THREE.Vector3[] = [];
    points.push(startPos.clone());

    switch (motionType) {
      case 'push_in':
        points.push(startPos.clone().lerp(target, 0.45));
        points.push(startPos.clone().lerp(target, 0.75));
        break;
      case 'pull_out':
        points.push(new THREE.Vector3(startPos.x, startPos.y + 0.3, startPos.z + 1.2));
        points.push(new THREE.Vector3(startPos.x, startPos.y + 0.6, startPos.z + 2.4));
        break;
      case 'orbit': {
        const r = startPos.distanceTo(target);
        for (let i = 1; i <= 6; i++) {
          const angle = (i / 6) * Math.PI * 0.9;
          points.push(new THREE.Vector3(
            target.x + r * Math.sin(angle),
            startPos.y,
            target.z + r * Math.cos(angle)
          ));
        }
        break;
      }
      case 'orbit_boom_up': {
        const r = startPos.distanceTo(target);
        for (let i = 1; i <= 6; i++) {
          const angle = (i / 6) * Math.PI * 0.9;
          points.push(new THREE.Vector3(
            target.x + r * Math.sin(angle),
            startPos.y + (i / 6) * 1.5,
            target.z + r * Math.cos(angle)
          ));
        }
        break;
      }
      case 'truck_left':
        points.push(new THREE.Vector3(startPos.x - 0.8, startPos.y, startPos.z));
        points.push(new THREE.Vector3(startPos.x - 1.6, startPos.y, startPos.z));
        break;
      case 'truck_right':
        points.push(new THREE.Vector3(startPos.x + 0.8, startPos.y, startPos.z));
        points.push(new THREE.Vector3(startPos.x + 1.6, startPos.y, startPos.z));
        break;
      case 'boom_up':
        points.push(new THREE.Vector3(startPos.x, startPos.y + 0.9, startPos.z));
        points.push(new THREE.Vector3(startPos.x, startPos.y + 1.8, startPos.z));
        break;
      case 'pan_left_crane_down':
        points.push(new THREE.Vector3(startPos.x - 1.0, startPos.y - 0.5, startPos.z));
        points.push(new THREE.Vector3(startPos.x - 1.8, startPos.y - 1.0, startPos.z - 0.4));
        break;
      default:
        points.push(startPos.clone().lerp(target, 0.5));
    }
    return points;
  }, []);

  // Update Trajectory Spline in 3D Scene
  useEffect(() => {
    if (!sceneRef.current || !virtualCameraRef.current || !showTrajectory) {
      if (trajectoryLineRef.current && sceneRef.current) {
        sceneRef.current.remove(trajectoryLineRef.current);
        trajectoryLineRef.current = null;
      }
      return;
    }

    const scene = sceneRef.current;
    const vCam = virtualCameraRef.current;
    const startPos = vCam.position.clone();
    const target = new THREE.Vector3(0, 1.25, 0);

    if (trajectoryLineRef.current) {
      scene.remove(trajectoryLineRef.current);
    }

    const waypoints = calculateMotionWaypoints(motion, startPos, target);
    const curve = new THREE.CatmullRomCurve3(waypoints);
    const points = curve.getPoints(50);
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineDashedMaterial({
      color: 0x00d2ff,
      dashSize: 0.12,
      gapSize: 0.06,
      linewidth: 2,
    });
    const line = new THREE.Line(geometry, material);
    line.computeLineDistances();
    scene.add(line);
    trajectoryLineRef.current = line;

    return () => {
      if (trajectoryLineRef.current && sceneRef.current) {
        sceneRef.current.remove(trajectoryLineRef.current);
      }
    };
  }, [motion, framing, showTrajectory, calculateMotionWaypoints]);

  // Motion Simulation Player Loop
  const handleToggleSimulation = () => {
    if (!virtualCameraRef.current) return;
    if (isSimulating) {
      setIsSimulating(false);
      return;
    }

    setIsSimulating(true);
    const cam = virtualCameraRef.current;
    const startPos = cam.position.clone();
    const startFov = cam.fov;
    const startTime = performance.now();
    const duration = motionSpeed === '0.5x' ? 4500 : (motionSpeed === '1.5x' ? 1800 : (motionSpeed === '2.0x' ? 1200 : 2500));

    const step = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / duration);
      setScrubberProgress(progress);

      // Easing Function
      let ease = progress;
      if (motionEasing === 'ease_in_out') {
        ease = 0.5 * (1 - Math.cos(Math.PI * progress));
      } else if (motionEasing === 'explosive') {
        ease = Math.pow(progress, 0.4);
      } else if (motionEasing === 'slow_out') {
        ease = Math.sin((progress * Math.PI) / 2);
      }

      // Execute Motion Math
      if (motion === 'push_in') {
        cam.position.z = startPos.z - ease * 0.95;
      } else if (motion === 'pull_out') {
        cam.position.z = startPos.z + ease * 1.3;
      } else if (motion === 'orbit') {
        const angle = ease * Math.PI * 0.85;
        cam.position.x = Math.sin(angle) * startPos.z;
        cam.position.z = Math.cos(angle) * startPos.z;
      } else if (motion === 'orbit_boom_up') {
        const angle = ease * Math.PI * 0.85;
        cam.position.x = Math.sin(angle) * startPos.z;
        cam.position.z = Math.cos(angle) * startPos.z;
        cam.position.y = startPos.y + ease * 1.5;
      } else if (motion === 'dolly_zoom') {
        // Vertigo effect: Dolly in while expanding FOV
        cam.position.z = startPos.z - ease * 1.0;
        cam.fov = startFov + ease * 22;
        cam.updateProjectionMatrix();
      } else if (motion === 'fast_push_shake') {
        cam.position.z = startPos.z - ease * 1.2;
        if (progress > 0.6) {
          cam.position.x = (Math.random() - 0.5) * 0.15;
          cam.position.y = startPos.y + (Math.random() - 0.5) * 0.15;
        }
      } else if (motion === 'truck_left') {
        cam.position.x = startPos.x - ease * 1.5;
      } else if (motion === 'truck_right') {
        cam.position.x = startPos.x + ease * 1.5;
      } else if (motion === 'boom_up') {
        cam.position.y = startPos.y + ease * 1.6;
      } else if (motion === 'shake') {
        cam.position.x = startPos.x + (Math.random() - 0.5) * 0.12;
        cam.position.y = startPos.y + (Math.random() - 0.5) * 0.12;
      }

      cam.lookAt(0, 1.25, 0);
      if (cameraRoll !== 0) cam.rotation.z = (cameraRoll * Math.PI) / 180;
      cam.updateProjectionMatrix();

      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        cam.position.copy(startPos);
        cam.fov = startFov;
        cam.lookAt(0, 1.25, 0);
        if (cameraRoll !== 0) cam.rotation.z = (cameraRoll * Math.PI) / 180;
        cam.updateProjectionMatrix();
        setIsSimulating(false);
        setScrubberProgress(0);
      }
    };
    requestAnimationFrame(step);
  };

  // ============================================================
  // Mouse & Touch 3D Orbit Controls & Raycasting Selection
  // ============================================================
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onMouseDown = (e: MouseEvent) => {
      // Check Raycasting on left click
      if (e.button === 0 && sceneRef.current && mainCameraRef.current) {
        const rect = container.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2(x, y), mainCameraRef.current);
        
        if (stageEntitiesGroupRef.current) {
          const intersects = raycaster.intersectObjects(stageEntitiesGroupRef.current.children, true);
          if (intersects.length > 0) {
            let hitObj: THREE.Object3D | null = intersects[0].object;
            while (hitObj && hitObj.parent && hitObj.parent !== stageEntitiesGroupRef.current) {
              hitObj = hitObj.parent;
            }
            if (hitObj?.name?.includes('protagonist')) setSelectedEntity('protagonist');
            else if (hitObj?.name?.includes('antagonist')) setSelectedEntity('antagonist');
            else if (hitObj?.name?.includes('supporting')) setSelectedEntity('supporting');
            else if (hitObj?.name?.includes('sword')) setSelectedEntity('prop_sword');
          }
        }
        orbitStateRef.current.isRotating = true;
      } else if (e.button === 1 || e.button === 2) {
        orbitStateRef.current.isPanning = true;
      }
      orbitStateRef.current.prevX = e.clientX;
      orbitStateRef.current.prevY = e.clientY;
    };

    const onMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - orbitStateRef.current.prevX;
      const deltaY = e.clientY - orbitStateRef.current.prevY;
      orbitStateRef.current.prevX = e.clientX;
      orbitStateRef.current.prevY = e.clientY;

      if (orbitStateRef.current.isRotating) {
        orbitStateRef.current.theta -= deltaX * 0.006;
        orbitStateRef.current.phi -= deltaY * 0.006;
        updateMainCameraPosition();
      } else if (orbitStateRef.current.isPanning) {
        const factor = orbitStateRef.current.radius * 0.0015;
        orbitStateRef.current.target.x -= deltaX * factor;
        orbitStateRef.current.target.y += deltaY * factor;
        updateMainCameraPosition();
      }
    };

    const onMouseUp = () => {
      orbitStateRef.current.isRotating = false;
      orbitStateRef.current.isPanning = false;
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      orbitStateRef.current.radius = Math.max(1.2, Math.min(16.0, orbitStateRef.current.radius + e.deltaY * 0.003));
      updateMainCameraPosition();
    };

    const onContextMenu = (e: MouseEvent) => e.preventDefault();

    container.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    container.addEventListener('wheel', onWheel, { passive: false });
    container.addEventListener('contextmenu', onContextMenu);

    return () => {
      container.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('contextmenu', onContextMenu);
    };
  }, [updateMainCameraPosition]);

  // ============================================================
  // Natural Language AI Directing Assistant Parser
  // ============================================================
  const handleExecuteAiDirective = async () => {
    if (!aiPrompt.trim()) return;
    setAiThinking(true);

    try {
      const res = await invokeTool('director_3d_stage_plan', {
        ai_directive: aiPrompt,
        framing,
        motion,
        pose,
        focal_length_mm: focalLength,
        camera_roll_deg: cameraRoll,
        cast_layout: castLayout,
        speed: motionSpeed,
      });

      if (res.status === 'success' && res.result) {
        const r = res.result;
        if (r.framing) setFraming(r.framing);
        if (r.motion) setMotion(r.motion);
        if (r.pose) setPose(r.pose);
        if (r.focal_length_mm) setFocalLength(r.focal_length_mm);
        if (r.camera_roll_deg !== undefined) setCameraRoll(r.camera_roll_deg);
        if (r.cast_layout) setCastLayout(r.cast_layout);
      }
      setTimeout(() => handleToggleSimulation(), 300);
    } catch (e) {
      console.error('AI Directive execution error:', e);
    } finally {
      setAiThinking(false);
    }
  };

  // ============================================================
  // Save & Synchronize to Active Shot
  // ============================================================
  const handleApplyToShot = async () => {
    if (!activeShot) return;

    await invokeTool('director_3d_stage_plan', {
      framing,
      motion,
      pose,
      focal_length_mm: focalLength,
      camera_roll_deg: cameraRoll,
      cast_layout: castLayout,
      speed: motionSpeed,
    });

    const updatedVideoPrompt = activeShot.video_prompt 
      ? `${activeShot.video_prompt.replace(/\[Camera:[^\]]+\]/g, '').trim()} ${minimaxPromptPreview}`.trim()
      : minimaxPromptPreview;

    updateShot(activeShot.id, {
      camera_framing: framing,
      camera_motion: motion,
      pose_preset: pose,
      focal_length_mm: focalLength,
      camera_roll_deg: cameraRoll,
      cast_layout: castLayout,
      props_config: propsConfig,
      video_prompt: updatedVideoPrompt,
    });

    setAppliedSuccess(true);
    setTimeout(() => setAppliedSuccess(false), 2500);
  };

  // 3D Viewport Snapshot Capture
  const handleCaptureSnapshot = () => {
    if (!pipRendererRef.current) return;
    const canvas = pipRendererRef.current.domElement;
    const dataUrl = canvas.toDataURL('image/png');
    
    if (activeShot) {
      updateShot(activeShot.id, {
        image_url: dataUrl
      });
    }

    setSnapshotSuccess(true);
    setTimeout(() => setSnapshotSuccess(false), 2500);
  };

  return (
    <div className="flex-1 flex flex-col md:flex-row h-full bg-background overflow-hidden select-none">
      {/* ============================================================ */}
      {/* 3D Main Stage Viewport (Left / Center) */}
      {/* ============================================================ */}
      <div className="flex-1 relative flex flex-col bg-[#07070A] overflow-hidden">
        {/* Top Floating Control Bar */}
        <div className="absolute top-4 left-4 z-20 flex items-center space-x-3 bg-surface/90 backdrop-blur-md px-4 py-2 rounded-2xl border border-border shadow-xl">
          <div className="flex items-center space-x-2">
            <span className="w-2.5 h-2.5 rounded-full bg-brand-light animate-pulse" />
            <span className="text-xs font-bold text-white tracking-wide">MiniMax 3D 虚拟导演台</span>
          </div>
          <span className="text-gray-600">|</span>

          {/* Quick Shot Switcher */}
          <div className="flex items-center space-x-1.5">
            <span className="text-[11px] text-gray-400">当前分镜:</span>
            <select
              value={activeShot?.id || ''}
              onChange={(e) => setActiveShotId(e.target.value)}
              className="bg-surface-secondary border border-border rounded-lg px-2.5 py-1 text-xs font-mono text-brand-light focus:outline-none focus:border-brand cursor-pointer"
            >
              {shots.map((sh, idx) => (
                <option key={sh.id} value={sh.id}>
                  #{sh.shot_index || idx + 1}: {sh.action_desc.slice(0, 16) || '分镜镜头'}
                </option>
              ))}
            </select>
          </div>

          {/* Current Selection Pill */}
          {selectedEntity && (
            <>
              <span className="text-gray-600">|</span>
              <div className="flex items-center space-x-1.5 bg-brand/20 border border-brand/40 px-2 py-0.5 rounded-full text-[10px] text-brand-light">
                <Focus className="w-3 h-3" />
                <span>选中: {selectedEntity === 'protagonist' ? '主角' : (selectedEntity === 'antagonist' ? '对手' : selectedEntity)}</span>
              </div>
            </>
          )}
        </div>

        {/* Top Right Quick Actions */}
        <div className="absolute top-4 right-4 z-20 flex items-center space-x-2">
          <button
            onClick={handleResetView}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-surface/85 hover:bg-surface border border-border text-xs text-gray-300 hover:text-white backdrop-blur-md shadow-md transition-all"
            title="复位 3D 自由视角"
          >
            <Compass className="w-3.5 h-3.5" />
            <span>视角复位</span>
          </button>
          <button
            onClick={() => setShowTrajectory(!showTrajectory)}
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-xl border text-xs backdrop-blur-md shadow-md transition-all ${
              showTrajectory
                ? 'bg-accent-blue/20 border-accent-blue text-accent-blue'
                : 'bg-surface/85 border-border text-gray-400 hover:text-white'
            }`}
            title="3D 发光运镜样条轨迹曲线"
          >
            <Activity className="w-3.5 h-3.5" />
            <span>轨迹曲线</span>
          </button>
          <button
            onClick={() => setShowHelpers(!showHelpers)}
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-xl border text-xs backdrop-blur-md shadow-md transition-all ${
              showHelpers
                ? 'bg-brand/20 border-brand text-brand-light'
                : 'bg-surface/85 border-border text-gray-400 hover:text-white'
            }`}
            title="显示/隐藏摄影机视锥体"
          >
            <Eye className="w-3.5 h-3.5" />
            <span>机位视锥</span>
          </button>
          <button
            onClick={() => setShowPip(!showPip)}
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-xl border text-xs backdrop-blur-md shadow-md transition-all ${
              showPip
                ? 'bg-brand/20 border-brand text-brand-light'
                : 'bg-surface/85 border-border text-gray-400 hover:text-white'
            }`}
            title="画中画导演机位监视器"
          >
            <Monitor className="w-3.5 h-3.5" />
            <span>监视器</span>
          </button>
        </div>

        {/* 3D WebGL Canvas */}
        <div
          ref={containerRef}
          className="w-full h-full cursor-grab active:cursor-grabbing outline-none"
        />

        {/* Bottom AI Natural Language Director Assistant Bar */}
        <div className="absolute bottom-4 left-4 right-4 md:right-72 z-20 flex flex-col space-y-2 pointer-events-auto">
          {/* Timeline Scrubber when simulating */}
          {isSimulating && (
            <div className="bg-surface/90 backdrop-blur-md p-2 rounded-xl border border-brand/40 shadow-xl flex items-center space-x-3">
              <span className="text-[10px] font-mono text-brand-light font-bold">运镜进度</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={scrubberProgress}
                onChange={(e) => setScrubberProgress(parseFloat(e.target.value))}
                className="flex-1 accent-brand h-1.5 bg-surface-secondary rounded cursor-pointer"
              />
              <span className="text-[10px] font-mono text-gray-400">{(scrubberProgress * 100).toFixed(0)}%</span>
            </div>
          )}

          <div className="flex items-center space-x-2 bg-surface/90 backdrop-blur-md p-2 rounded-2xl border border-border shadow-2xl">
            <div className="flex items-center pl-2 pr-1 text-brand-light">
              <Wand2 className="w-4 h-4 animate-pulse" />
            </div>
            <input
              type="text"
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleExecuteAiDirective()}
              placeholder="✨ AI 空间导演调度：输入指令（如：'给一个希区柯克变焦，突显主角发现真相的惊恐眼神'、'贴地仰角双人对峙推镜'）..."
              className="flex-1 bg-transparent text-xs text-white placeholder-gray-500 focus:outline-none"
            />
            <button
              onClick={handleExecuteAiDirective}
              disabled={aiThinking || !aiPrompt.trim()}
              className="px-4 py-1.5 rounded-xl bg-gradient-to-r from-brand to-brand-blue hover:opacity-90 disabled:opacity-50 text-white text-xs font-bold shadow-md shadow-brand/20 transition-all flex items-center space-x-1.5"
            >
              {aiThinking ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              <span>{aiThinking ? '正在调度...' : 'AI 空间调度'}</span>
            </button>
          </div>
        </div>

        {/* ============================================================ */}
        {/* PIP Director Camera Viewfinder Monitor */}
        {/* ============================================================ */}
        {showPip && (
          <div className="absolute bottom-18 md:bottom-4 right-4 z-20 w-52 h-80 bg-surface/95 border-2 border-brand/60 rounded-2xl shadow-2xl overflow-hidden backdrop-blur-md flex flex-col transition-all">
            {/* Monitor Top Bar */}
            <div className="h-7 px-3 bg-surface-secondary border-b border-border flex items-center justify-between text-[10px] text-gray-300 font-mono">
              <span className="flex items-center space-x-1.5">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-ping" />
                <span className="text-white font-bold">CAM 1 [REC]</span>
              </span>
              <div className="flex items-center space-x-1">
                <span className="text-brand-light font-bold">{aspectRatioMask}</span>
                <span className="text-gray-500">|</span>
                <span className="text-accent-blue font-bold">{focalLength}mm</span>
              </div>
            </div>

            {/* Viewfinder Canvas Container */}
            <div className="flex-1 relative overflow-hidden bg-black flex items-center justify-center">
              <div ref={pipContainerRef} className="w-full h-full" />
              
              {/* Composition Grid Overlays */}
              {compositionGrid === 'rule_of_thirds' && (
                <div className="absolute inset-0 pointer-events-none grid grid-cols-3 grid-rows-3 border border-white/10 opacity-40">
                  <div className="border-r border-b border-white/25" />
                  <div className="border-r border-b border-white/25" />
                  <div className="border-b border-white/25" />
                  <div className="border-r border-b border-white/25" />
                  <div className="border-r border-b border-white/25" />
                  <div className="border-b border-white/25" />
                  <div className="border-r border-b border-white/25" />
                  <div className="border-r border-b border-white/25" />
                  <div />
                </div>
              )}

              {compositionGrid === 'crosshair' && (
                <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                  <Crosshair className="w-6 h-6 text-brand-light/70" />
                </div>
              )}

              {compositionGrid === 'golden_ratio' && (
                <div className="absolute inset-0 pointer-events-none border border-brand-light/30 rounded-full scale-90 opacity-40" />
              )}
            </div>

            {/* Viewfinder Footer Controls */}
            <div className="p-2 bg-surface-secondary/95 border-t border-border flex items-center justify-between text-[10px]">
              <div className="flex items-center space-x-1">
                <button
                  onClick={() => setCompositionGrid(g => g === 'rule_of_thirds' ? 'crosshair' : (g === 'crosshair' ? 'golden_ratio' : (g === 'golden_ratio' ? 'none' : 'rule_of_thirds')))}
                  className="px-2 py-0.5 rounded bg-surface border border-border text-gray-300 hover:text-white font-mono"
                  title="切换构图参考线"
                >
                  网格: {compositionGrid === 'rule_of_thirds' ? '九宫' : (compositionGrid === 'crosshair' ? '十字' : (compositionGrid === 'golden_ratio' ? '黄金' : '无'))}
                </button>
              </div>

              <button
                onClick={handleCaptureSnapshot}
                className="flex items-center space-x-1 px-2.5 py-1 rounded-lg bg-brand/30 hover:bg-brand border border-brand/50 text-brand-light hover:text-white font-bold transition-all"
                title="截取当前 3D 视角作为分镜画面参考"
              >
                {snapshotSuccess ? <Check className="w-3 h-3 text-accent-green" /> : <Camera className="w-3 h-3" />}
                <span>{snapshotSuccess ? '已快照' : '截取分镜'}</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ============================================================ */}
      {/* Right Control Inspector Tabs */}
      {/* ============================================================ */}
      <div className="w-full md:w-96 bg-surface border-l border-border flex flex-col h-full overflow-hidden shrink-0 shadow-2xl">
        {/* Navigation Tabs Header */}
        <div className="flex items-center border-b border-border bg-surface-secondary/80 p-1">
          <button
            onClick={() => setActiveRightTab('optics_motion')}
            className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center space-x-1.5 ${
              activeRightTab === 'optics_motion'
                ? 'bg-surface text-brand-light shadow-md'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            <Video className="w-3.5 h-3.5" />
            <span>光学与运镜</span>
          </button>
          <button
            onClick={() => setActiveRightTab('cast_props')}
            className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center space-x-1.5 ${
              activeRightTab === 'cast_props'
                ? 'bg-surface text-accent-orange shadow-md'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            <span>站位与道具</span>
          </button>
          <button
            onClick={() => setActiveRightTab('environment')}
            className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center space-x-1.5 ${
              activeRightTab === 'environment'
                ? 'bg-surface text-accent-green shadow-md'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            <Sun className="w-3.5 h-3.5" />
            <span>影棚环境</span>
          </button>
        </div>

        {/* Scrollable Inspector Content */}
        <div className="flex-1 p-5 space-y-6 overflow-y-auto custom-scrollbar">
          {/* TAB 1: OPTICS & MOTIONS */}
          {activeRightTab === 'optics_motion' && (
            <>
              {/* 1. Camera Focal Length (焦距) */}
              <div>
                <label className="text-xs text-gray-300 font-semibold mb-2 flex items-center justify-between">
                  <span className="flex items-center space-x-1.5">
                    <Camera className="w-3.5 h-3.5 text-accent-blue" />
                    <span>镜头焦距 (Focal Length)</span>
                  </span>
                  <span className="text-xs text-accent-blue font-mono font-bold bg-accent-blue/10 px-2 py-0.5 rounded">
                    {focalLength} mm
                  </span>
                </label>
                
                {/* Focal length slider */}
                <input
                  type="range"
                  min="16"
                  max="135"
                  step="1"
                  value={focalLength}
                  onChange={(e) => setFocalLength(parseInt(e.target.value))}
                  className="w-full accent-accent-blue h-1.5 bg-surface-secondary rounded cursor-pointer"
                />

                {/* Quick focal presets */}
                <div className="grid grid-cols-6 gap-1.5 mt-2">
                  {FOCAL_PRESETS.map((fl) => (
                    <button
                      key={fl}
                      onClick={() => setFocalLength(fl)}
                      className={`py-1 rounded-lg text-[10px] font-mono font-bold border transition-all ${
                        focalLength === fl
                          ? 'bg-accent-blue/20 border-accent-blue text-white'
                          : 'bg-surface-secondary border-border text-gray-400 hover:text-white'
                      }`}
                    >
                      {fl}mm
                    </button>
                  ))}
                </div>
              </div>

              {/* 2. Dutch Roll Angle (荷兰角) */}
              <div>
                <label className="text-xs text-gray-300 font-semibold mb-2 flex items-center justify-between">
                  <span className="flex items-center space-x-1.5">
                    <Rotate3d className="w-3.5 h-3.5 text-brand-light" />
                    <span>荷兰角倾斜 (Dutch Roll)</span>
                  </span>
                  <span className="text-xs text-brand-light font-mono font-bold bg-brand/10 px-2 py-0.5 rounded">
                    {cameraRoll > 0 ? '+' : ''}{cameraRoll.toFixed(1)}°
                  </span>
                </label>
                <input
                  type="range"
                  min="-45"
                  max="45"
                  step="1"
                  value={cameraRoll}
                  onChange={(e) => setCameraRoll(parseFloat(e.target.value))}
                  className="w-full accent-brand h-1.5 bg-surface-secondary rounded cursor-pointer"
                />
              </div>

              {/* 3. Camera Framing (景别) */}
              <div>
                <label className="text-xs text-gray-300 font-semibold mb-2 flex items-center justify-between">
                  <span>🎥 镜头景别 (Framing Preset)</span>
                  <span className="text-[10px] text-brand-light font-mono bg-brand/10 px-2 py-0.5 rounded">
                    {framing}
                  </span>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {FRAMING_PRESETS.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => {
                        setFraming(f.id);
                        setFocalLength(f.fl);
                      }}
                      className={`p-2.5 rounded-xl text-left border transition-all ${
                        framing === f.id
                          ? 'bg-brand/20 border-brand text-white shadow-md shadow-brand/20 ring-1 ring-brand'
                          : 'bg-surface-secondary border-border text-gray-400 hover:text-gray-200'
                      }`}
                    >
                      <div className="text-xs font-bold truncate">{f.label}</div>
                      <div className="text-[9px] text-gray-500 truncate mt-0.5">{f.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* 4. MiniMax 01-Director Motions (15+ 单轴与 5 大复合运镜) */}
              <div>
                <label className="text-xs text-gray-300 font-semibold mb-2 flex items-center justify-between">
                  <span>🚀 运镜轨迹 (MiniMax Motion Matrix)</span>
                  <span className="text-[10px] text-accent-orange font-mono bg-accent-orange/10 px-2 py-0.5 rounded">
                    {motion}
                  </span>
                </label>

                {/* Combos vs Single selector */}
                <div className="space-y-3">
                  <div className="text-[10px] font-bold text-accent-orange uppercase tracking-wider">🌟 电影级双轴复合运镜 (MiniMax Combos)</div>
                  <div className="grid grid-cols-1 gap-2">
                    {MOTION_PRESETS.filter(m => m.category === 'combo').map((m) => (
                      <button
                        key={m.id}
                        onClick={() => setMotion(m.id)}
                        className={`p-2.5 rounded-xl border text-left transition-all ${
                          motion === m.id
                            ? 'bg-accent-orange/20 border-accent-orange text-white shadow-md shadow-accent-orange/20 ring-1 ring-accent-orange'
                            : 'bg-surface-secondary border-border text-gray-400 hover:text-gray-200'
                        }`}
                      >
                        <div className="text-xs font-bold flex items-center justify-between">
                          <span>{m.label}</span>
                          <span className="text-[9px] bg-accent-orange/30 text-accent-orange px-1.5 py-0.5 rounded font-mono">COMBO</span>
                        </div>
                        <div className="text-[9px] text-gray-400 mt-0.5">{m.desc}</div>
                      </button>
                    ))}
                  </div>

                  <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider pt-2">🎬 经典单轴运镜</div>
                  <div className="grid grid-cols-2 gap-2">
                    {MOTION_PRESETS.filter(m => m.category === 'single').map((m) => (
                      <button
                        key={m.id}
                        onClick={() => setMotion(m.id)}
                        className={`p-2 rounded-xl border text-left transition-all ${
                          motion === m.id
                            ? 'bg-brand/20 border-brand text-white shadow-md ring-1 ring-brand'
                            : 'bg-surface-secondary border-border text-gray-400 hover:text-gray-200'
                        }`}
                      >
                        <div className="text-xs font-bold truncate">{m.label}</div>
                        <div className="text-[9px] text-gray-500 truncate mt-0.5">{m.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Motion Playback Button */}
                <div className="mt-4">
                  <button
                    onClick={handleToggleSimulation}
                    className={`w-full flex items-center justify-center space-x-2 py-2.5 rounded-xl text-xs font-bold shadow-lg transition-all ${
                      isSimulating
                        ? 'bg-red-500 text-white'
                        : 'bg-gradient-to-r from-accent-orange to-brand text-white hover:opacity-95'
                    }`}
                  >
                    {isSimulating ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 fill-current" />}
                    <span>{isSimulating ? '停止运镜预览' : '▶ 播放当前运镜轨迹模拟'}</span>
                  </button>
                </div>
              </div>
            </>
          )}

          {/* TAB 2: CAST & PROPS */}
          {activeRightTab === 'cast_props' && (
            <>
              {/* 1. Cast Staging Layout (角色站位构图) */}
              <div>
                <label className="text-xs text-gray-300 font-semibold mb-2 flex items-center justify-between">
                  <span>👥 多角色空间站位 (Cast Staging)</span>
                  <span className="text-[10px] text-accent-orange font-mono bg-accent-orange/10 px-2 py-0.5 rounded">
                    {castLayout}
                  </span>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {CAST_LAYOUTS.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => setCastLayout(c.id)}
                      className={`p-2.5 rounded-xl text-left border transition-all ${
                        castLayout === c.id
                          ? 'bg-accent-orange/20 border-accent-orange text-white shadow-md ring-1 ring-accent-orange'
                          : 'bg-surface-secondary border-border text-gray-400 hover:text-gray-200'
                      }`}
                    >
                      <div className="text-xs font-bold">{c.label}</div>
                      <div className="text-[9px] text-gray-500 mt-0.5">{c.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* 2. Character Pose Presets (9 种动作姿态) */}
              <div>
                <label className="text-xs text-gray-300 font-semibold mb-2 flex items-center justify-between">
                  <span>🥋 角色动作姿态 (9 Poses)</span>
                  <span className="text-[10px] text-accent-green font-mono bg-accent-green/10 px-2 py-0.5 rounded">
                    {pose}
                  </span>
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {POSE_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setPose(p.id)}
                      className={`p-2 rounded-xl text-left border transition-all ${
                        pose === p.id
                          ? 'bg-accent-green/20 border-accent-green text-white shadow-md ring-1 ring-accent-green'
                          : 'bg-surface-secondary border-border text-gray-400 hover:text-gray-200'
                      }`}
                    >
                      <div className="text-sm">{p.icon}</div>
                      <div className="text-xs font-bold mt-1 truncate">{p.label}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* 3. Stage Props & Visual FX */}
              <div>
                <label className="text-xs text-gray-300 font-semibold mb-2 flex items-center justify-between">
                  <span>⚔️ 场景道具与结界 (Props & FX)</span>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { id: 'sword' as StagePropType, label: '浮空飞剑', icon: '🗡️' },
                    { id: 'shield' as StagePropType, label: '聚能护盾', icon: '🛡️' },
                    { id: 'magic_circle' as StagePropType, label: '地面符文阵', icon: '🌀' },
                  ].map((pr) => {
                    const active = propsConfig.includes(pr.id);
                    return (
                      <button
                        key={pr.id}
                        onClick={() => {
                          setPropsConfig(prev => 
                            prev.includes(pr.id) ? prev.filter(x => x !== pr.id) : [...prev, pr.id]
                          );
                        }}
                        className={`p-2.5 rounded-xl border text-left flex items-center space-x-2 transition-all ${
                          active
                            ? 'bg-brand/20 border-brand text-white shadow-md'
                            : 'bg-surface-secondary border-border text-gray-400 hover:text-gray-200'
                        }`}
                      >
                        <span className="text-base">{pr.icon}</span>
                        <span className="text-xs font-bold">{pr.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {/* TAB 3: ENVIRONMENT */}
          {activeRightTab === 'environment' && (
            <>
              <div>
                <label className="text-xs text-gray-300 font-semibold mb-2 block">
                  🌆 3D 影棚氛围预设
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { id: 'cyber_studio' as StageEnvironment, label: '暗黑赛博影棚', desc: '经典工业霓虹' },
                    { id: 'xianxia_cloud' as StageEnvironment, label: '修仙仙山云海', desc: '青云缥缈灵气' },
                    { id: 'desert_battle' as StageEnvironment, label: '决战古荒漠', desc: '炽热落日黄沙' },
                    { id: 'neon_city' as StageEnvironment, label: '雨夜霓虹都市', desc: '赛博街道反光' },
                  ].map((env) => (
                    <button
                      key={env.id}
                      onClick={() => setEnvironment(env.id)}
                      className={`p-2.5 rounded-xl border text-left transition-all ${
                        environment === env.id
                          ? 'bg-accent-green/20 border-accent-green text-white shadow-md ring-1 ring-accent-green'
                          : 'bg-surface-secondary border-border text-gray-400 hover:text-gray-200'
                      }`}
                    >
                      <div className="text-xs font-bold">{env.label}</div>
                      <div className="text-[9px] text-gray-500 mt-0.5">{env.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs text-gray-300 font-semibold mb-2 block">
                  📐 构图比例与遮幅
                </label>
                <div className="grid grid-cols-4 gap-2">
                  {(['9:16', '16:9', '1:1', '2.35:1'] as const).map((r) => (
                    <button
                      key={r}
                      onClick={() => setAspectRatioMask(r)}
                      className={`py-2 rounded-xl text-xs font-bold border transition-all ${
                        aspectRatioMask === r
                          ? 'bg-brand text-white border-brand shadow-md'
                          : 'bg-surface-secondary border-border text-gray-400 hover:text-white'
                      }`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* MiniMax Prompt Live Syntax Box */}
          <div className="p-3.5 rounded-2xl bg-surface-secondary border border-border space-y-2">
            <div className="flex items-center justify-between text-[11px] font-bold text-gray-300">
              <span className="flex items-center space-x-1.5">
                <Sparkles className="w-3.5 h-3.5 text-brand-light" />
                <span>MiniMax 01-Director 规范语法</span>
              </span>
              <span className="text-[9px] bg-brand/20 text-brand-light px-1.5 py-0.5 rounded font-mono">LIVE PROMPT</span>
            </div>
            <div className="p-2.5 rounded-xl bg-black/60 font-mono text-[11px] text-brand-light leading-relaxed break-all border border-brand/20">
              {minimaxPromptPreview}
            </div>
          </div>
        </div>

        {/* Footer Synchronize to Shot Button */}
        <div className="p-4 border-t border-border bg-surface-secondary/40 shrink-0">
          <button
            onClick={handleApplyToShot}
            className={`w-full py-3.5 rounded-2xl text-xs font-bold flex items-center justify-center space-x-2 transition-all shadow-xl ${
              appliedSuccess
                ? 'bg-accent-green text-white shadow-accent-green/30'
                : 'bg-gradient-to-r from-brand to-brand-blue hover:opacity-95 text-white shadow-brand/30'
            }`}
          >
            {appliedSuccess ? (
              <>
                <Check className="w-4 h-4" />
                <span>已同步 3D 轨迹与机位至当前分镜！</span>
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                <span>保存 3D 机位与 MiniMax 运镜至分镜</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

// ============================================================
// 3D Procedural Mesh Helpers (Stylized Sci-Fi / Xianxia Mannequin)
// ============================================================
function createMannequinMesh(opts: {
  pose: PosePreset;
  role: 'protagonist' | 'antagonist' | 'supporting';
  primaryColor: number;
  accentColor: number;
  name: string;
}): THREE.Group {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({
    color: opts.primaryColor,
    metalness: 0.7,
    roughness: 0.25,
    emissive: 0x110022,
  });

  const jointMat = new THREE.MeshStandardMaterial({
    color: opts.accentColor,
    emissive: opts.accentColor,
    emissiveIntensity: 0.6,
    roughness: 0.1,
  });

  // Head
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 16), bodyMat);
  head.position.y = 1.7;
  head.castShadow = true;
  group.add(head);

  // Visor / Cyber Eye Glow
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.15), jointMat);
  visor.position.set(0, 1.72, 0.1);
  group.add(visor);

  // Torso
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.12, 0.55, 12), bodyMat);
  torso.position.y = 1.25;
  torso.castShadow = true;
  group.add(torso);

  // Poses & Limbs
  if (opts.pose === 'fight') {
    torso.rotation.y = 0.45;
    const armL = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.5), jointMat);
    armL.position.set(0.26, 1.35, 0.3);
    armL.rotation.x = Math.PI / 2.2;
    group.add(armL);

    const armR = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.48), jointMat);
    armR.position.set(-0.26, 1.25, 0.15);
    armR.rotation.z = Math.PI / 4;
    group.add(armR);
  } else if (opts.pose === 'cast_spell') {
    const armL = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.55), jointMat);
    armL.position.set(0.3, 1.5, 0.25);
    armL.rotation.x = Math.PI / 1.8;
    armL.rotation.z = -Math.PI / 6;
    group.add(armL);

    const armR = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.55), jointMat);
    armR.position.set(-0.3, 1.5, 0.25);
    armR.rotation.x = Math.PI / 1.8;
    armR.rotation.z = Math.PI / 6;
    group.add(armR);
  } else if (opts.pose === 'look_back') {
    torso.rotation.y = Math.PI * 0.75;
    head.rotation.y = -Math.PI * 0.45;
  } else if (opts.pose === 'defend') {
    const armCross = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.08), jointMat);
    armCross.position.set(0, 1.35, 0.25);
    armCross.rotation.z = 0.3;
    group.add(armCross);
  } else {
    // Normal Stand
    const armL = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.55), jointMat);
    armL.position.set(0.24, 1.2, 0);
    group.add(armL);

    const armR = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.55), jointMat);
    armR.position.set(-0.24, 1.2, 0);
    group.add(armR);
  }

  // Legs
  const legL = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.04, 0.7), bodyMat);
  legL.position.set(0.12, 0.55, opts.pose === 'fight' || opts.pose === 'run' ? 0.25 : 0);
  group.add(legL);

  const legR = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.04, 0.7), bodyMat);
  legR.position.set(-0.12, 0.55, opts.pose === 'fight' || opts.pose === 'run' ? -0.25 : 0);
  group.add(legR);

  return group;
}

function createFloatingSwordMesh(): THREE.Group {
  const group = new THREE.Group();
  const bladeMat = new THREE.MeshStandardMaterial({
    color: 0x00d2ff,
    emissive: 0x0088cc,
    emissiveIntensity: 0.8,
    metalness: 0.9,
    roughness: 0.1,
  });
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.2, 0.02), bladeMat);
  blade.rotation.z = Math.PI / 4;
  group.add(blade);
  return group;
}

function createEnergyShieldMesh(): THREE.Group {
  const group = new THREE.Group();
  const shieldMat = new THREE.MeshStandardMaterial({
    color: 0x7c3aed,
    emissive: 0x7c3aed,
    emissiveIntensity: 0.4,
    transparent: true,
    opacity: 0.45,
    roughness: 0.1,
  });
  const shield = new THREE.Mesh(new THREE.CylinderGeometry(0.65, 0.65, 0.04, 6), shieldMat);
  shield.rotation.x = Math.PI / 2;
  group.add(shield);
  return group;
}

function createMagicCircleMesh(): THREE.Group {
  const group = new THREE.Group();
  const circleMat = new THREE.MeshBasicMaterial({
    color: 0x00d2ff,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.7,
  });
  const ring1 = new THREE.Mesh(new THREE.RingGeometry(1.6, 1.68, 48), circleMat);
  ring1.rotation.x = Math.PI / 2;
  group.add(ring1);

  const ring2 = new THREE.Mesh(new THREE.RingGeometry(1.1, 1.15, 32), circleMat);
  ring2.rotation.x = Math.PI / 2;
  group.add(ring2);
  return group;
}
