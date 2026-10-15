// -*- coding: utf-8 -*-
/**
 * REQ-toonflow-canvas T3 · GLB 模型加载（原 Director3DStage 模块级代码，原样迁出）。
 * 带进程级缓存 / 并发去重 / 坏文件黑名单；每次返回独立材质的克隆。不依赖 React。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// 基础真实模型库（CC0，来自 three.js / Khronos Sample Models，已下载至 public/models）
// 初始角色（主角/对手/配角）改用程序化「人体布偶」，此处仅保留道具 GLB
export const MODEL_URLS: Record<string, string> = {
  chair: '/models/SheenChair.glb', // 4.3MB 椅子
  helmet: '/models/DamagedHelmet.glb', // 3.7MB 头盔
  camera_prop: '/models/AntiqueCamera.glb', // 复古相机
  avocado: '/models/Avocado.glb',
  boombox: '/models/BoomBox.glb',
};
const gltfLoader = new GLTFLoader();
const modelCache = new Map<string, THREE.Group>();
/** 正在加载中的 URL → 同一个 Promise。缓存是 await 之后才写的，没有这张表的话
 *  同一个模型的并发请求会各自完整下载+解析一遍（实测 BoomBox 被拉了两次）。 */
const modelInflight = new Map<string, Promise<THREE.Group | null>>();
/** 加载失败过的 URL。坏文件不记下来的话，每放一次道具都会重试一轮，
 *  一个坏 GLB 能刷出 8 次解析失败 + 30 条贴图报错。 */
const modelFailed = new Set<string>();

export function cloneWithOwnMaterials(src: THREE.Group): THREE.Group {
  const clone = src.clone(true) as THREE.Group;
  // 深拷贝材质避免共享
  clone.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      const m = obj as THREE.Mesh;
      if (Array.isArray(m.material)) m.material = (m.material as any[]).map((mat: any) => mat.clone());
      else if (m.material) m.material = (m.material as any).clone();
    }
  });
  return clone;
}

/** GLB 完整性预检：文件头第 8 字节起是声明的总长度，和实际字节数对不上就是下载被截断。
 *  不先验的话 GLTFLoader 只会抛一句没头没尾的 `Invalid typed array length`。 */
export async function assertGlbIntact(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength < 12) throw new Error(`文件只有 ${buf.byteLength} 字节，不是合法 GLB`);
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'glTF') throw new Error(`不是 GLB（文件头为 ${JSON.stringify(magic)}）`);
  const declared = dv.getUint32(8, true);
  if (declared !== buf.byteLength) {
    throw new Error(
      `GLB 文件不完整：实际 ${buf.byteLength} 字节，文件头声明 ${declared} 字节`
      + `（缺 ${declared - buf.byteLength}）。这份模型下载时被截断了，需要重新下载。`,
    );
  }
  return buf;
}

export async function loadGLBModel(url: string, scale = 1): Promise<THREE.Group | null> {
  if (modelCache.has(url)) return cloneWithOwnMaterials(modelCache.get(url)!);
  if (modelFailed.has(url)) return null;
  const pending = modelInflight.get(url);
  if (pending) {
    const root = await pending;
    return root ? cloneWithOwnMaterials(root) : null;
  }
  const task = loadGLBModelOnce(url, scale);
  modelInflight.set(url, task);
  try {
    const root = await task;
    return root ? cloneWithOwnMaterials(root) : null;
  } finally {
    modelInflight.delete(url);
  }
}

async function loadGLBModelOnce(url: string, scale = 1): Promise<THREE.Group | null> {
  try {
    const buf = await assertGlbIntact(url);
    const gltf = await gltfLoader.parseAsync(buf, '');
    const root = gltf.scene as THREE.Group;
    root.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        // 修正过亮的金属度
        const mat = mesh.material as THREE.MeshStandardMaterial;
        if (mat && (mat as any).isMeshStandardMaterial) {
          if (mat.metalness > 0.9) mat.metalness = 0.3;
          mat.needsUpdate = true;
        }
      }
    });
    // 归一化尺寸至 ~1.6m 高
    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim > 0) {
      const s = (1.6 / maxDim) * scale;
      root.scale.setScalar(s);
    }
    // 底部对齐到 y=0
    const box2 = new THREE.Box3().setFromObject(root);
    const center = new THREE.Vector3();
    box2.getCenter(center);
    root.position.sub(new THREE.Vector3(center.x, box2.min.y, center.z));
    // 淡入
    root.traverse((obj) => {
      if ((obj as any).isMesh) (obj as THREE.Mesh).userData.isRealModel = true;
    });
    modelCache.set(url, root);
    return root;
  } catch (e) {
    modelFailed.add(url);
    console.warn(`[Director3D] GLB 加载失败 ${url}:`, e instanceof Error ? e.message : e);
    return null;
  }
}
