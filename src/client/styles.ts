/**
 * 设置卡片的样式。
 *
 * **只用宿主的主题 token**（`--dsw-alias-*`），并为每一个都配一个十六进制
 * 回退值——宿主换主题时变量会变，而变量缺失时（较老的宿主线）回退值保证
 * 卡片仍然是可读的，而不是一堆继承来的黑色文字。
 *
 * 类名前缀 `dsm-minimax-*`（`dsm` = DSH minimax），与本插件族的
 * `dsm-workbuddy-*` / `dsm-trae-*` 保持同一套外观语言。
 *
 * 参考：dingminhua/dsh-connect-workbuddy（MIT，Copyright (c) 2026 LaoDing）
 *   —— 卡片外壳、按钮原语与 `--dsw-alias-*` 主题变量的用法来自该项目。
 *
 * NOTE: 这是一个模板字面量，里面不能出现反引号；一个落单的反引号会静默
 * 关闭它（文件随后以一句误导性的 "Expected a semicolon" 解析失败）。
 */

/** 卡片的完整样式表。 */
export const MINIMAX_CARD_CSS = `
/* ---- 卡片外壳 ---- */
.dsm-minimax-card{
  border:1px solid var(--dsw-alias-border-l2,#36373b);
  background:var(--dsw-alias-bg-layer-3,#202126);
  border-radius:12px;
  list-style:none;
  transition:border-color .16s,background .16s;
}
.dsm-minimax-card:hover{border-color:var(--dsw-alias-label-dimmed,#777)}
.dsm-minimax-card-head{
  flex-direction:column;flex:1;gap:4px;min-width:0;display:flex;
}
.dsm-minimax-card-title{
  color:var(--dsw-alias-label-primary,#e6e6e6);font-size:15px;font-weight:600;line-height:1.4;
}
.dsm-minimax-card-desc{
  color:var(--dsw-alias-label-tertiary,#999);font-size:13px;line-height:1.5;
}
.dsm-minimax-card-body{
  border-top:1px solid var(--dsw-alias-border-l2,#36373b);
  margin:0 16px;padding:14px 0 10px;
  display:flex;flex-direction:column;gap:14px;
}

/* ---- 按钮原语 ---- */
.dsm-minimax-btn{
  appearance:none;font:inherit;cursor:pointer;
  border:1px solid transparent;border-radius:8px;
  padding:5px 14px;font-size:13px;line-height:1.5;
}
.dsm-minimax-btn:focus-visible{
  outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px;
}
.dsm-minimax-btn:disabled{opacity:.4;cursor:default}
.dsm-minimax-btn-outline{
  border-color:var(--dsw-alias-border-l2,#36373b);
  color:var(--dsw-alias-label-secondary,#c6c9d0);
  background:transparent;font-weight:500;
}
.dsm-minimax-btn-outline:hover:not(:disabled){
  color:var(--dsw-alias-label-primary,#e6e6e6);
  border-color:var(--dsw-alias-label-dimmed,#777);
  background:rgba(255,255,255,.04);
}

/* ---- 状态行（登录态 / 区域 / 路由 / 版本） ---- */
.dsm-minimax-facts{
  display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:0;
  font-size:12px;line-height:18px;
}
.dsm-minimax-fact-key{
  color:var(--dsw-alias-label-tertiary,#9aa0a8);white-space:nowrap;
}
.dsm-minimax-fact-value{
  color:var(--dsw-alias-label-primary,#e6e6e6);
  overflow-wrap:anywhere;
}

/* ---- 登录态徽标 ----
   颜色只回答一个问题：现在能不能用。能不能用之外的信息（来源、代数、到期）
   由旁边的文字行回答，所以颜色可以诚实地停在「可用 / 不可用」这一层。 */
.dsm-minimax-badge{
  display:inline-flex;align-items:center;gap:6px;
  padding:2px 10px;border-radius:999px;
  font-size:12px;font-weight:600;line-height:18px;white-space:nowrap;
  border:1px solid transparent;
}
.dsm-minimax-badge-dot{flex:none;width:7px;height:7px;border-radius:50%}
.dsm-minimax-badge-ready{
  color:var(--dsw-alias-state-success-primary,#22a06b);
  border-color:rgba(34,160,107,.4);background:rgba(34,160,107,.12);
}
.dsm-minimax-badge-ready .dsm-minimax-badge-dot{background:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-minimax-badge-warn{
  color:var(--dsw-alias-state-warning-primary,#d29922);
  border-color:rgba(210,153,34,.4);background:rgba(210,153,34,.12);
}
.dsm-minimax-badge-warn .dsm-minimax-badge-dot{background:var(--dsw-alias-state-warning-primary,#d29922)}
.dsm-minimax-badge-error{
  color:var(--dsw-alias-state-error-primary,#ef4444);
  border-color:rgba(239,68,68,.4);background:rgba(239,68,68,.12);
}
.dsm-minimax-badge-error .dsm-minimax-badge-dot{background:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-minimax-badge-unknown{
  color:var(--dsw-alias-label-secondary,#c6c9d0);
  border-color:var(--dsw-alias-border-l2,#36373b);background:transparent;
}
.dsm-minimax-badge-unknown .dsm-minimax-badge-dot{
  background:var(--dsw-alias-label-dimmed,rgba(127,127,127,.6));
}

/* ---- 错误 / 说明 ---- */
.dsm-minimax-error{
  margin:0;color:var(--dsw-alias-state-error-primary,#d92d20);
  font-size:12px;line-height:18px;
}
.dsm-minimax-hint{
  margin:0;color:var(--dsw-alias-label-tertiary,#9aa0a8);
  font-size:12px;line-height:18px;
}

/* ---- 模型表 ---- */
.dsm-minimax-models{margin:0;padding:0;border-collapse:collapse;width:100%;font-size:12px}
.dsm-minimax-models th{
  text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary,#9aa0a8);
  padding:0 10px 6px 0;white-space:nowrap;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));
}
.dsm-minimax-models td{
  padding:7px 10px 7px 0;
  color:var(--dsw-alias-label-primary,#e6e6e6);
  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));
  vertical-align:top;
}
.dsm-minimax-models tr:last-child td{border-bottom:0}
.dsm-minimax-model-id{
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:11px;color:var(--dsw-alias-label-primary,#e6e6e6);
  overflow-wrap:anywhere;
}
.dsm-minimax-model-name{
  color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px;
}
.dsm-minimax-chip{
  display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;line-height:16px;
  border:1px solid var(--dsw-alias-border-l2,#36373b);
  color:var(--dsw-alias-label-secondary,#c6c9d0);background:transparent;white-space:nowrap;
}
.dsm-minimax-chip-on{
  border-color:rgba(86,134,254,.4);color:var(--dsw-alias-brand-primary,#5686fe);
  background:rgba(86,134,254,.1);
}

/* ---- 操作行 ---- */
.dsm-minimax-actions{display:flex;align-items:center;gap:10px}
.dsm-minimax-updated{
  color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:11px;line-height:16px;
}
`
