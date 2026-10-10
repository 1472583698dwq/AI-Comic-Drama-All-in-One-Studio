/* 最小形态原型行为验证（jsdom，确定性）—— 对 minimal-shell.html 做真实点击并断言。
 *
 * 运行：
 *   npm i jsdom            # 任意临时目录即可，本脚本不写业务依赖
 *   node verify-behavior.js minimal-shell.html
 *
 * 覆盖：最小形态锁定集合（壳 / 设置台 / 开关总闸 / 空态自救）·
 *      三层开关热插拔（page / feature / prefs）· 插件贡献与精确回滚 ·
 *      外部停用当前页 → 空态自救闭环 · 单条 render 失败的错误隔离 · 无 JS 错误。
 * 说明：断言文本一律只取 #hostSlot，避免 toast 文案污染（插件名也会出现在 toast 里）。
 */
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');

const file = process.argv[2] || 'minimal-shell.html';
const html = fs.readFileSync(file, 'utf8');
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.detail && e.detail.stack ? e.detail.stack : e.message)));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'http://localhost/' });
const win = dom.window;
const doc = win.document;

const results = [];
const check = (name, cond, extra = '') =>
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '   [' + extra + ']' : ''}`);
const $ = (s) => doc.querySelector(s);
const $$ = (s) => [...doc.querySelectorAll(s)];
const click = (s) => {
  const el = typeof s === 'string' ? $(s) : s;
  if (!el) throw new Error('元素不存在: ' + s);
  el.click();
};
const ev = (expr) => win.eval(expr);
const hostText = () => doc.querySelector('#hostSlot').textContent;
const railGoIds = () => $$('#railList [data-go]').map((b) => b.dataset.go);

try {
  /* ---- 1. 最小形态：出厂只有设置台 + 壳全部锁定 ---- */
  check('出厂：图标轨无任何页面宿主，且提示"除设置台外暂无启用页"',
    railGoIds().length === 0 && doc.querySelector('#railList').textContent.includes('暂无启用页'));
  check('出厂：舞台渲染的是设置台（唯一真实页）', !!$('#hostSlot .console') && !!$('#hostSlot .card'));
  check('钉底自救入口「设置台」存在且高亮', !!$('#pinConfig') && $('#pinConfig').classList.contains('active'));
  check('锁定（最小形态）标注 >= 6 处', $$('[data-lock="locked"]').length >= 6, 'count=' + $$('[data-lock="locked"]').length);
  check('可插拔标注存在（宿主 / 附加面板）', $$('[data-lock="pluggable"]').length >= 1, 'count=' + $$('[data-lock="pluggable"]').length);
  check('设置台开关不可关：config 无 data-tog，且存在 locked 开关',
    !$('[data-tog="page"][data-id="config"]') && !!$('.sw.locked'));
  check('开关总闸三组 + 插件分区都在设置台内', $$('#hostSlot .card').length === 5, 'cards=' + $$('#hostSlot .card').length);

  /* ---- 2. 标注模式（最小形态图示） ---- */
  click('#annotBtn');
  check('标注模式：body.annot 立即生效', doc.body.classList.contains('annot'));
  click('#annotBtn');
  check('标注模式可关闭', !doc.body.classList.contains('annot'));

  /* ---- 3. prefs 层热插拔（改本机呈现，不碰能力） ---- */
  click('[data-tog="pref"][data-id="rail_labels"]');
  check('prefs 关闭：图标轨收窄（去掉 wide）', !$('#rail').classList.contains('wide'));
  click('[data-tog="pref"][data-id="rail_labels"]');
  check('prefs 恢复：图标轨展开', $('#rail').classList.contains('wide'));
  click('[data-tog="pref"][data-id="status_pill"]');
  check('prefs 关闭：顶栏状态胶囊隐藏', $('#statusPill').style.display === 'none');
  click('[data-tog="pref"][data-id="status_pill"]');
  check('prefs 恢复：状态胶囊回来', $('#statusPill').style.display !== 'none');

  /* ---- 4. feature 层热插拔（附加面板，默认关） ---- */
  check('feature 默认关：注册表视图不存在',
    !$('#hostSlot .tbl') && hostText().includes('启用「注册表视图」'));
  click('[data-tog="feature"][data-id="panel_registry"]');
  check('feature 开启：注册表视图立即出现', !!$('#hostSlot .tbl'));
  check('注册表含锁定壳条目与插件条目（含 source 标注）',
    hostText().includes('顶条壳') && hostText().includes('ink_pack') && hostText().includes('plugin:ink-pack'));

  /* ---- 5. page 层热插拔：开启 → 宿主出现 → 进入 → 占位 → 关闭 → 消失 ---- */
  click('[data-tog="page"][data-id="studio"]');
  check('页面开关开启：图标轨立即出现该宿主', railGoIds().includes('studio'));
  click('[data-go="studio"]');
  check('进入页面：渲染宿主占位（非真实界面）',
    !!$('#hostSlot .host') && hostText().includes('host: studio') && hostText().includes('内容待实现'));
  click('[data-go="config"]');
  check('回设置台：钉底入口恢复高亮', $('#pinConfig').classList.contains('active'));
  click('[data-tog="page"][data-id="studio"]');
  check('页面开关关闭：图标轨入口立即消失', !railGoIds().includes('studio'));

  /* ---- 6. 插件热插拔：启用 → 入口+插件宿主 → 停用 → 精确回滚 ---- */
  click('[data-tog="plugin"][data-id="ink_pack"]');
  check('插件启用：图标轨出现插件入口', railGoIds().includes('plugin:ink_pack'));
  check('插件启用：状态胶囊计数变化', $('#pillText').textContent.includes('插件 1'));
  click('[data-go="plugin:ink_pack"]');
  check('插件宿主渲染贡献占位（带 🧩 标注）',
    hostText().includes('水墨漫剧包') && !!$('#hostSlot [data-lock="plugin"]'));
  click('[data-go="config"]');
  click('[data-tog="plugin"][data-id="ink_pack"]');
  check('插件停用：入口消失（精确回滚，无残留）', !railGoIds().includes('plugin:ink_pack'));

  /* ---- 7. 外部停用当前页 → 归一 → 空态自救闭环 ---- */
  click('[data-tog="feature"][data-id="panel_diagnostics"]');
  check('诊断面板出现「外部停用当前页」演练入口', !!$('[data-demo="external-off"]'));
  click('[data-tog="page"][data-id="home"]');
  click('[data-demo="external-off"]');
  check('当前页被外部停用且无可用页 → 落到空态自救页', !!$('#hostSlot .empty'));
  check('空态页列出被关闭的页面', $$('#hostSlot .tagwrap span').length === 10,
    'tags=' + $$('#hostSlot .tagwrap span').length);
  click('#hostSlot .cta');
  check('自救入口可用：回到设置台（开关面板可操作）', !!$('#hostSlot .console') && !!$('[data-tog="page"][data-id="home"]'));

  /* ---- 8. 错误隔离：单条 render 失败不拖垮宿主 ---- */
  click('[data-tog="demo"][data-id="crash"]');
  check('故障条目注入：自动进入该条目，仅它显示占位',
    !!$('#hostSlot .slot-error') && hostText().includes('该模块加载失败'));
  check('崩溃未拖垮宿主：图标轨仍有条目、钉底入口仍在',
    railGoIds().includes('plugin:broken') && !!$('#pinConfig'));
  click('#pinConfig');
  check('故障期间设置台仍可正常渲染（开关总闸可用）',
    !!$('#hostSlot .console') && !!$('[data-tog="page"][data-id="home"]'));

  /* ---- 9. 出厂重置 ---- */
  click('#resetBtn');
  check('重置：回到"只有设置台可用"的出厂态',
    ev("state.activeTab") === 'config' && railGoIds().length === 0 && !$('#hostSlot .tbl'));

  /* ---- 10. 控制台干净 ---- */
  check('无页面 JS 错误', errors.length === 0, errors.join(' | '));
} catch (e) {
  results.push('FAIL  运行中断: ' + e.message);
}

console.log(results.join('\n'));
const ok = results.length > 0 && results.every((r) => r.startsWith('PASS'));
console.log(ok ? '\n== ALL PASS ==' : '\n== HAS FAIL ==');
process.exit(ok ? 0 : 1);
