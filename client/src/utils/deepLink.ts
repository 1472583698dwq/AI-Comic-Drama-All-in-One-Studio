/**
 * 深链接：`/?project=<项目id>&tab=<页签>` 直接打开指定项目的指定页签（如 tab=canvas）。
 *
 * 必须在任何 store 模块求值之前执行（main.tsx 第一个 import）：
 * useProjectStore / useProjectListStore 在模块初始化时就从 localStorage 读 activeProjectId / app_active_tab，
 * 这里先把参数写进 localStorage，再把参数从地址栏抹掉（刷新不会反复覆盖用户后续的切换）。
 */
try {
  const qs = new URLSearchParams(window.location.search);
  const project = qs.get('project');
  const tab = qs.get('tab');
  if (project) localStorage.setItem('activeProjectId', project);
  if (tab) localStorage.setItem('app_active_tab', tab);
  if (project || tab) {
    qs.delete('project');
    qs.delete('tab');
    const rest = qs.toString();
    window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash);
  }
} catch {
  /* localStorage 不可用时忽略，按常规启动 */
}

export {};
