import { describe, expect, it } from 'vitest';
import { rectsOverlap, selectedNodeRects } from '../AutoHideMiniMap';

/** E2E-2 观察 7：小地图挡住选中节点的提示词面板时让开。 */

const r = (left: number, top: number, w: number, h: number) => ({ left, top, right: left + w, bottom: top + h });

describe('rectsOverlap', () => {
  it('相交 / 贴边（margin 内）算挡；离得远不算', () => {
    const minimap = r(1180, 700, 200, 150);
    expect(rectsOverlap(r(900, 760, 660, 120), minimap)).toBe(true); // 提示词面板伸进小地图
    expect(rectsOverlap(r(900, 650, 276, 48), minimap)).toBe(true); // 右下角离小地图 4px / 2px
    expect(rectsOverlap(r(100, 100, 300, 200), minimap)).toBe(false);
  });
});

describe('selectedNodeRects', () => {
  it('取节点卡片 + 上下浮层的矩形，忽略空矩形与找不到的节点', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div class="react-flow__node" data-id="n1"><div class="cv-node"><div class="cv-node__slot cv-node__slot--bottom"></div></div></div>';
    const node = root.querySelector('.react-flow__node') as HTMLElement;
    const slot = root.querySelector('.cv-node__slot') as HTMLElement;
    node.getBoundingClientRect = () => ({ left: 10, top: 10, right: 230, bottom: 210, width: 220, height: 200 } as DOMRect);
    slot.getBoundingClientRect = () => ({ left: 0, top: 222, right: 660, bottom: 400, width: 660, height: 178 } as DOMRect);
    const rects = selectedNodeRects(root, ['n1', 'missing']);
    expect(rects).toHaveLength(2);
    expect(rects[1]).toMatchObject({ left: 0, bottom: 400 });
  });
});
