import React, { useEffect, useRef, useState, useCallback } from 'react';
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
  Layers,
  RefreshCw,
  Sliders,
  Compass,
  Monitor,
  ChevronDown
} from 'lucide-react';
import { useProjectStore } from '../../stores/useProjectStore';
import { useMcpStore } from '../../stores/useMcpStore';
import { CameraFraming, CameraMotion } from '../../types';

export const Director3DStage: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const pipContainerRef = useRef<HTMLDivElement>(null);
  const { project, activeShotId, setActiveShotId, updateShot } = useProjectStore();
  const { invokeTool } = useMcpStore();

  const shots = project?.scenes.flatMap((s) => s.shots) || [];
  const activeShot = shots.find((sh) => sh.id === activeShotId) || shots[0];

  const [framing, setFraming] = useState<CameraFraming>(activeShot?.camera_framing || 'medium');
  const [motion, setMotion] = useState<CameraMotion>(activeShot?.camera_motion || 'push_in');
  const [pose, setPose] = useState<'stand' | 'fight' | 'look_back' | 'run'>(activeShot?.pose_preset || 'stand');
  const [isSimulatingMotion, setIsSimulatingMotion] = useState(false);
  const [appliedSuccess, setAppliedSuccess] = useState(false);
  const [showPip, setShowPip] = useState(true);
  const [showHelpers, setShowHelpers] = useState(true);

  // Synchronize when activeShot changes
  useEffect(() => {
    if (activeShot) {
      if (activeShot.camera_framing) setFraming(activeShot.camera_framing);
      if (activeShot.camera_motion) setMotion(activeShot.camera_motion);
      if (activeShot.pose_preset) setPose(activeShot.pose_preset);
    }
  }, [activeShotId, activeShot]);

  // Three.js instances
  const sceneRef = useRef<THREE.Scene | null>(null);
  const mainCameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const virtualCameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const pipRendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const mannequinGroupRef = useRef<THREE.Group | null>(null);
  const cameraHelperRef = useRef<THREE.CameraHelper | null>(null);
  const motionCurveMeshRef = useRef<THREE.Line | null>(null);

  // Orbit controls state
  const orbitStateRef = useRef({
    isRotating: false,
    isPanning: false,
    prevX: 0,
    prevY: 0,
    target: new THREE.Vector3(0, 1.2, 0),
    radius: 4.5,
    theta: 0,       // azimuthal angle
    phi: Math.PI / 3, // polar angle
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

  // Reset Orbit View
  const handleResetView = useCallback(() => {
    orbitStateRef.current.target.set(0, 1.2, 0);
    orbitStateRef.current.radius = 4.5;
    orbitStateRef.current.theta = 0;
    orbitStateRef.current.phi = Math.PI / 2.8;
    updateMainCameraPosition();
  }, [updateMainCameraPosition]);

  useEffect(() => {
    if (!containerRef.current) return;

    const width = containerRef.current.clientWidth;
    const height = containerRef.current.clientHeight;

    // 1. Scene Setup
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x07070a);
    scene.fog = new THREE.FogExp2(0x07070a, 0.06);
    sceneRef.current = scene;

    // 2. Main Viewport Camera
    const mainCamera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    mainCameraRef.current = mainCamera;
    updateMainCameraPosition();

    // 3. Virtual Shooting Camera (The Director's Lens)
    const virtualCam = new THREE.PerspectiveCamera(45, 9 / 16, 0.2, 20);
    virtualCam.position.set(0, 1.3, 2.5);
    virtualCam.lookAt(0, 1.2, 0);
    scene.add(virtualCam);
    virtualCameraRef.current = virtualCam;

    // Virtual Camera Frustum Helper
    const helper = new THREE.CameraHelper(virtualCam);
    if (helper.material && !Array.isArray(helper.material)) {
      (helper.material as THREE.Material).opacity = 0.5;
      (helper.material as THREE.Material).transparent = true;
    }
    scene.add(helper);
    cameraHelperRef.current = helper;

    // 4. Main Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    containerRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // 5. Lighting Setup (Dramatic Dual Studio Neon Lights)
    const ambientLight = new THREE.AmbientLight(0x1a1528, 2.0);
    scene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(0x7c3aed, 3.5);
    keyLight.position.set(3, 4, 3);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 1024;
    keyLight.shadow.mapSize.height = 1024;
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x00d2ff, 4.0);
    rimLight.position.set(-3, 3, -2.5);
    scene.add(rimLight);

    const fillLight = new THREE.PointLight(0xff0077, 2.0, 10);
    fillLight.position.set(0, 0.5, 2);
    scene.add(fillLight);

    // 6. Ground Studio Stage
    const gridHelper = new THREE.GridHelper(12, 24, 0x7c3aed, 0x1f1f2e);
    gridHelper.position.y = 0;
    scene.add(gridHelper);

    // Glowing Director Ring on Floor
    const ringGeo = new THREE.RingGeometry(1.2, 1.25, 32);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x7c3aed, side: THREE.DoubleSide });
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.rotation.x = Math.PI / 2;
    ringMesh.position.y = 0.01;
    scene.add(ringMesh);

    // 7. Mannequin Character Model
    const mannequin = create3DMannequin(pose);
    scene.add(mannequin);
    mannequinGroupRef.current = mannequin;

    // Animation Loop
    let reqId: number;
    const animate = () => {
      reqId = requestAnimationFrame(animate);

      if (mannequinGroupRef.current) {
        mannequinGroupRef.current.position.y = Math.sin(Date.now() * 0.002) * 0.015;
      }

      if (cameraHelperRef.current && virtualCameraRef.current) {
        cameraHelperRef.current.update();
      }

      renderer.render(scene, mainCamera);

      // Render PIP Monitor
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

  // Setup PIP Renderer
  useEffect(() => {
    if (!pipContainerRef.current) return;
    const w = pipContainerRef.current.clientWidth;
    const h = pipContainerRef.current.clientHeight;

    const pipRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
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
  }, [showPip]);

  // Mouse & Touch Orbit Controls Event Listeners
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 0) {
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
      orbitStateRef.current.radius = Math.max(1.2, Math.min(15.0, orbitStateRef.current.radius + e.deltaY * 0.003));
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

  // Update Virtual Camera Framing & Position
  useEffect(() => {
    if (!virtualCameraRef.current) return;
    const vCam = virtualCameraRef.current;

    switch (framing) {
      case 'extreme_close_up':
        vCam.position.set(0, 1.68, 0.75);
        vCam.fov = 28;
        break;
      case 'close_up':
        vCam.position.set(0, 1.55, 1.35);
        vCam.fov = 34;
        break;
      case 'medium':
        vCam.position.set(0, 1.3, 2.4);
        vCam.fov = 45;
        break;
      case 'full':
        vCam.position.set(0, 1.15, 3.8);
        vCam.fov = 50;
        break;
      case 'bird_eye':
        vCam.position.set(0, 3.8, 2.2);
        vCam.fov = 60;
        break;
      case 'low_angle':
        vCam.position.set(0, 0.25, 1.7);
        vCam.fov = 55;
        break;
    }
    vCam.lookAt(0, 1.25, 0);
    vCam.updateProjectionMatrix();

    if (cameraHelperRef.current) {
      cameraHelperRef.current.update();
    }
  }, [framing]);

  // Update Pose Mesh
  useEffect(() => {
    if (!sceneRef.current || !mannequinGroupRef.current) return;
    sceneRef.current.remove(mannequinGroupRef.current);
    const newMannequin = create3DMannequin(pose);
    sceneRef.current.add(newMannequin);
    mannequinGroupRef.current = newMannequin;
  }, [pose]);

  // Toggle Helpers
  useEffect(() => {
    if (cameraHelperRef.current) {
      cameraHelperRef.current.visible = showHelpers;
    }
  }, [showHelpers]);

  // Motion Simulation with smooth lerp
  const handleSimulateMotion = () => {
    if (!virtualCameraRef.current || isSimulatingMotion) return;
    setIsSimulatingMotion(true);
    const cam = virtualCameraRef.current;
    const startPos = cam.position.clone();
    const startTime = performance.now();
    const duration = 2200;

    const step = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / duration);
      const ease = Math.sin((progress * Math.PI) / 2);

      if (motion === 'push_in') {
        cam.position.z = startPos.z - ease * 0.9;
      } else if (motion === 'pull_out') {
        cam.position.z = startPos.z + ease * 1.2;
      } else if (motion === 'orbit') {
        const angle = ease * Math.PI * 0.8;
        cam.position.x = Math.sin(angle) * startPos.z;
        cam.position.z = Math.cos(angle) * startPos.z;
      } else if (motion === 'shake') {
        cam.position.x = startPos.x + (Math.random() - 0.5) * 0.12;
        cam.position.y = startPos.y + (Math.random() - 0.5) * 0.12;
      }

      cam.lookAt(0, 1.25, 0);
      cam.updateProjectionMatrix();

      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        cam.position.copy(startPos);
        cam.lookAt(0, 1.25, 0);
        cam.updateProjectionMatrix();
        setIsSimulatingMotion(false);
      }
    };
    requestAnimationFrame(step);
  };

  // Apply to active shot and call MCP Tool
  const handleApplyToShot = async () => {
    if (!activeShot) return;

    await invokeTool('director_3d_stage_plan', {
      framing,
      motion,
      pose,
    });

    updateShot(activeShot.id, {
      camera_framing: framing,
      camera_motion: motion,
      pose_preset: pose,
    });

    setAppliedSuccess(true);
    setTimeout(() => setAppliedSuccess(false), 2500);
  };

  return (
    <div className="flex-1 flex flex-col md:flex-row h-full bg-background overflow-hidden select-none">
      {/* 3D Main Stage Viewport */}
      <div className="flex-1 relative flex flex-col bg-[#07070A] overflow-hidden">
        {/* Top Info & Shot Selector Bar */}
        <div className="absolute top-4 left-4 z-20 flex items-center space-x-3 bg-surface/90 backdrop-blur-md px-3.5 py-2 rounded-2xl border border-border shadow-xl">
          <div className="flex items-center space-x-2">
            <span className="w-2.5 h-2.5 rounded-full bg-accent-orange animate-pulse" />
            <span className="text-xs font-bold text-white">3D 虚拟导演监视台</span>
          </div>
          <span className="text-gray-600">|</span>
          
          {/* Quick Shot Switcher */}
          <div className="flex items-center space-x-1.5">
            <span className="text-[11px] text-gray-400">当前分镜:</span>
            <select
              value={activeShot?.id || ''}
              onChange={(e) => setActiveShotId(e.target.value)}
              className="bg-surface-secondary border border-border rounded-lg px-2 py-1 text-xs font-mono text-brand-light focus:outline-none focus:border-brand cursor-pointer"
            >
              {shots.map((sh, idx) => (
                <option key={sh.id} value={sh.id}>
                  #{sh.shot_index || idx + 1}: {sh.action_desc.slice(0, 18) || '分镜镜头'}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Top Right Tool Action Buttons */}
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
            onClick={() => setShowHelpers(!showHelpers)}
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-xl border text-xs backdrop-blur-md shadow-md transition-all ${
              showHelpers
                ? 'bg-brand/20 border-brand text-brand-light'
                : 'bg-surface/85 border-border text-gray-400 hover:text-white'
            }`}
            title="显示/隐藏摄影机视锥体辅助线"
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
            title="显示/隐藏导演机位画中画监视器"
          >
            <Monitor className="w-3.5 h-3.5" />
            <span>监视器</span>
          </button>
        </div>

        {/* 3D WebGL Canvas with Grab Cursor */}
        <div
          ref={containerRef}
          className="w-full h-full cursor-grab active:cursor-grabbing outline-none"
        />

        {/* Viewport Control Instructions Overlay */}
        <div className="absolute bottom-4 left-4 z-10 text-[10px] text-gray-500 bg-surface/70 backdrop-blur-md px-3 py-1.5 rounded-xl border border-border/60 pointer-events-none flex items-center space-x-3">
          <span>🖱️ 左键拖拽: 360°旋转</span>
          <span>·</span>
          <span>右键/中键拖拽: 平移</span>
          <span>·</span>
          <span>滚轮: 缩放距离</span>
        </div>

        {/* Picture-in-Picture Director Camera Monitor */}
        {showPip && (
          <div className="absolute bottom-4 right-4 z-20 w-48 h-72 bg-surface/95 border-2 border-brand/50 rounded-2xl shadow-2xl overflow-hidden backdrop-blur-md flex flex-col">
            {/* Monitor Header */}
            <div className="h-7 px-2.5 bg-surface-secondary border-b border-border flex items-center justify-between text-[10px] text-gray-300 font-mono">
              <span className="flex items-center space-x-1">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-ping" />
                <span className="text-white font-bold">CAM 1 [LIVE]</span>
              </span>
              <span className="text-brand-light font-bold">9:16</span>
            </div>

            {/* PIP Render Container */}
            <div className="flex-1 relative overflow-hidden bg-black flex items-center justify-center">
              <div ref={pipContainerRef} className="w-full h-full" />
              
              {/* Rule of Thirds Composition Grid Lines */}
              <div className="absolute inset-0 pointer-events-none grid grid-cols-3 grid-rows-3 border border-white/10 opacity-40">
                <div className="border-r border-b border-white/20" />
                <div className="border-r border-b border-white/20" />
                <div className="border-b border-white/20" />
                <div className="border-r border-b border-white/20" />
                <div className="border-r border-b border-white/20" />
                <div className="border-b border-white/20" />
                <div className="border-r border-white/20" />
                <div className="border-r border-white/20" />
                <div />
              </div>

              {/* Crosshair Center */}
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                <Crosshair className="w-4 h-4 text-brand-light/60" />
              </div>
            </div>

            {/* Monitor Footer Info */}
            <div className="h-6 px-2 bg-surface-secondary/90 border-t border-border flex items-center justify-between text-[9px] text-gray-400 font-mono">
              <span>{framing}</span>
              <span>35mm F1.8</span>
            </div>
          </div>
        )}
      </div>

      {/* Right Control Inspector */}
      <div className="w-full md:w-84 bg-surface border-l border-border flex flex-col p-5 space-y-5 overflow-y-auto custom-scrollbar shrink-0 shadow-xl">
        <div className="flex items-center justify-between border-b border-border pb-3">
          <div className="flex items-center space-x-2">
            <div className="p-1.5 rounded-lg bg-brand/20 text-brand-light">
              <Video className="w-4 h-4" />
            </div>
            <span className="text-xs font-bold text-white">机位与空间强控参数</span>
          </div>
          <span className="text-[10px] bg-accent-green/20 text-accent-green px-2 py-0.5 rounded-full border border-accent-green/30 font-medium">
            3D ControlNet
          </span>
        </div>

        {/* 1. Camera Framing (景别选择) */}
        <div>
          <label className="text-xs text-gray-300 font-semibold mb-2 flex items-center justify-between">
            <span>🎥 镜头景别 (Framing)</span>
            <span className="text-[10px] text-brand-light font-mono bg-brand/10 px-2 py-0.5 rounded">
              {framing}
            </span>
          </label>
          <div className="grid grid-cols-3 gap-2">
            {[
              { id: 'extreme_close_up', label: '大特写', desc: '眼神/微表情' },
              { id: 'close_up', label: '特写', desc: '面部与半身' },
              { id: 'medium', label: '中景', desc: '胸部以上' },
              { id: 'full', label: '全景', desc: '全身与站位' },
              { id: 'bird_eye', label: '鸟瞰俯冲', desc: '高空俯视' },
              { id: 'low_angle', label: '仰角霸气', desc: '低机位压迫' },
            ].map((f) => (
              <button
                key={f.id}
                onClick={() => setFraming(f.id as CameraFraming)}
                className={`p-2 rounded-xl text-left border transition-all ${
                  framing === f.id
                    ? 'bg-brand/20 border-brand text-white shadow-md shadow-brand/20 ring-1 ring-brand'
                    : 'bg-surface-secondary border-border text-gray-400 hover:text-gray-200 hover:border-border-active'
                }`}
              >
                <div className="text-xs font-bold">{f.label}</div>
                <div className="text-[9px] text-gray-500 truncate mt-0.5">{f.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* 2. Camera Motion (运镜轨迹) */}
        <div>
          <label className="text-xs text-gray-300 font-semibold mb-2 flex items-center justify-between">
            <span>🚀 运镜轨迹 (Camera Motion)</span>
            <span className="text-[10px] text-accent-orange font-mono bg-accent-orange/10 px-2 py-0.5 rounded">
              {motion}
            </span>
          </label>
          <div className="grid grid-cols-2 gap-2">
            {[
              { id: 'push_in', label: '急进推进 (Push In)', desc: '镜头逼近主角' },
              { id: 'pull_out', label: '渐远拉出 (Pull Out)', desc: '由近及远展示环境' },
              { id: 'orbit', label: '360° 环绕 (Orbit)', desc: '动态弧形环拍' },
              { id: 'shake', label: '战斗震颤 (Shake)', desc: '冲击感手持震动' },
            ].map((m) => (
              <button
                key={m.id}
                onClick={() => setMotion(m.id as CameraMotion)}
                className={`p-2.5 rounded-xl border text-left transition-all ${
                  motion === m.id
                    ? 'bg-accent-orange/20 border-accent-orange text-white shadow-md shadow-accent-orange/20 ring-1 ring-accent-orange'
                    : 'bg-surface-secondary border-border text-gray-400 hover:text-gray-200 hover:border-border-active'
                }`}
              >
                <div className="text-xs font-bold truncate">{m.label}</div>
                <div className="text-[9px] text-gray-500 truncate mt-0.5">{m.desc}</div>
              </button>
            ))}
          </div>

          <div className="mt-2.5">
            <button
              onClick={handleSimulateMotion}
              disabled={isSimulatingMotion}
              className={`w-full flex items-center justify-center space-x-2 py-2 rounded-xl text-xs font-bold shadow-md transition-all ${
                isSimulatingMotion
                  ? 'bg-accent-orange/40 text-white'
                  : 'bg-gradient-to-r from-accent-orange to-brand-glow text-white hover:opacity-90'
              }`}
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              <span>{isSimulatingMotion ? '正在运镜演示中...' : '▶ 播放当前运镜轨迹'}</span>
            </button>
          </div>
        </div>

        {/* 3. Character Pose (角色素体姿态) */}
        <div>
          <label className="text-xs text-gray-300 font-semibold mb-2 flex items-center justify-between">
            <span>🥋 角色姿态预设 (Pose Preset)</span>
            <span className="text-[10px] text-accent-green font-mono bg-accent-green/10 px-2 py-0.5 rounded">
              {pose}
            </span>
          </label>
          <div className="grid grid-cols-2 gap-2">
            {[
              { id: 'stand', label: '傲然站立 (Stand)' },
              { id: 'fight', label: '武道打斗 (Combat)' },
              { id: 'look_back', label: '回眸凝视 (Look Back)' },
              { id: 'run', label: '极速突进 (Dash)' },
            ].map((p) => (
              <button
                key={p.id}
                onClick={() => setPose(p.id as any)}
                className={`px-3 py-2 rounded-xl text-xs font-semibold border text-left transition-all ${
                  pose === p.id
                    ? 'bg-accent-green/20 border-accent-green text-white shadow-md shadow-accent-green/20 ring-1 ring-accent-green'
                    : 'bg-surface-secondary border-border text-gray-400 hover:text-gray-200 hover:border-border-active'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* 4. Apply & Save to Shot */}
        <div className="pt-2 border-t border-border mt-auto">
          <button
            onClick={handleApplyToShot}
            className={`w-full py-3 rounded-xl text-xs font-bold flex items-center justify-center space-x-2 transition-all shadow-xl ${
              appliedSuccess
                ? 'bg-accent-green text-white shadow-accent-green/30'
                : 'bg-gradient-to-r from-brand to-brand-blue hover:opacity-95 text-white shadow-brand/30'
            }`}
          >
            {appliedSuccess ? (
              <>
                <Check className="w-4 h-4" />
                <span>已同步至当前分镜！</span>
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                <span>保存 3D 轨迹与机位至当前分镜</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

// Helper: Build stylized 3D mannequin mesh
function create3DMannequin(pose: string): THREE.Group {
  const group = new THREE.Group();

  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: 0x7c3aed,
    metalness: 0.6,
    roughness: 0.3,
    emissive: 0x220044,
  });

  const jointMaterial = new THREE.MeshStandardMaterial({
    color: 0x00d2ff,
    emissive: 0x005588,
    roughness: 0.2,
  });

  // Head
  const headGeo = new THREE.SphereGeometry(0.18, 16, 16);
  const head = new THREE.Mesh(headGeo, bodyMaterial);
  head.position.y = 1.7;
  head.castShadow = true;
  group.add(head);

  // Eyes glow bar (Cyber visor)
  const eyeGeo = new THREE.BoxGeometry(0.15, 0.04, 0.16);
  const eyeMesh = new THREE.Mesh(eyeGeo, jointMaterial);
  eyeMesh.position.set(0, 1.72, 0.1);
  group.add(eyeMesh);

  // Torso
  const torsoGeo = new THREE.CylinderGeometry(0.16, 0.12, 0.55, 12);
  const torso = new THREE.Mesh(torsoGeo, bodyMaterial);
  torso.position.y = 1.25;
  torso.castShadow = true;
  group.add(torso);

  // Arms and Legs according to pose
  if (pose === 'fight') {
    torso.rotation.y = 0.4;
    const armL = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.5), jointMaterial);
    armL.position.set(0.25, 1.35, 0.3);
    armL.rotation.x = Math.PI / 2.2;
    group.add(armL);

    const armR = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.45), jointMaterial);
    armR.position.set(-0.25, 1.25, 0.15);
    armR.rotation.z = Math.PI / 4;
    group.add(armR);
  } else if (pose === 'look_back') {
    torso.rotation.y = Math.PI * 0.75;
    head.rotation.y = -Math.PI * 0.4;
  } else if (pose === 'run') {
    torso.rotation.x = 0.25;
    const armL = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.55), jointMaterial);
    armL.position.set(0.25, 1.25, -0.2);
    armL.rotation.x = -Math.PI / 3;
    group.add(armL);

    const armR = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.55), jointMaterial);
    armR.position.set(-0.25, 1.25, 0.2);
    armR.rotation.x = Math.PI / 3;
    group.add(armR);
  } else {
    const armL = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.55), jointMaterial);
    armL.position.set(0.24, 1.2, 0);
    group.add(armL);

    const armR = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.55), jointMaterial);
    armR.position.set(-0.24, 1.2, 0);
    group.add(armR);
  }

  // Legs
  const legL = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.04, 0.7), bodyMaterial);
  legL.position.set(0.12, 0.55, pose === 'fight' || pose === 'run' ? 0.25 : 0);
  group.add(legL);

  const legR = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.04, 0.7), bodyMaterial);
  legR.position.set(-0.12, 0.55, pose === 'fight' || pose === 'run' ? -0.25 : 0);
  group.add(legR);

  return group;
}
