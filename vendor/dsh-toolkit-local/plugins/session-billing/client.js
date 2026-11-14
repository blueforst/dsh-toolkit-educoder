window.__ModuleLoader__.load({
  id: '@forst/dsh-session-billing',
  factory: require => {
    const React = require('react');
    const { createPortal } = require('react-dom');
    const { Tooltip, useAnchoredPosition, useDismissOnOutsidePointer } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;
    // DSH 0.2.2-rc.2 将面板定位迁移到 CSS 锚点，旧版仍提供定位 hook。
    const usesLegacyPosition = typeof useAnchoredPosition === 'function';
    const useLegacyPosition = usesLegacyPosition ? useAnchoredPosition : () => null;
    // 与原生统计项使用相同设计变量，样式仅作用于本插件。
    const css = `
      .forst-cost-anchor{min-width:0;display:inline-flex;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}
      .forst-cost-pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:transparent;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer}
      .forst-cost-pill svg{flex:none;width:14px;height:14px}
      .forst-cost-label{min-width:0;overflow:hidden;text-overflow:ellipsis}
      .forst-cost-pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
      @media(hover:hover){.forst-cost-pill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}}
      .forst-cost-panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);max-height:calc(100dvh - 24px);overflow:auto;backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:16px;font-size:12px;line-height:18px;position:fixed}
      .forst-cost-panel--anchored{height:fit-content;position-anchor:var(--forst-cost-anchor);top:max(12px,var(--dsh-frame-overlay-top,12px));left:max(12px,anchor(left));right:12px;bottom:calc(anchor(top) + 8px);align-self:safe end;justify-self:safe start;position-try-fallbacks:--forst-cost-viewport-end;margin:0}
      @position-try --forst-cost-viewport-end{left:12px;right:12px;justify-self:safe end}
      .forst-cost-title{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;display:flex}
      .forst-cost-title-label{align-items:center;gap:6px;min-width:0;display:inline-flex}
      .forst-cost-title-label svg{flex:none;width:14px;height:14px}
      .forst-cost-title-value{font-variant-numeric:tabular-nums}
      .forst-cost-rule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}
      .forst-cost-details{color:var(--dsw-alias-label-tertiary);grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid}
      .forst-cost-details dt,.forst-cost-details dd{min-width:0;margin:0}
      .forst-cost-details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}
    `;
    function CostIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true },
        h('circle', { cx: 12, cy: 12, r: 9 }), h('path', { d: 'M15 8.5h-4.5a2 2 0 0 0 0 4h3a2 2 0 0 1 0 4H9M12 6v12' }));
    }
    const dollars = (value, pricedCalls) => pricedCalls === 0 ? '--' : value > 0 && value < .0001 ? '<$0.0001' : `$${value.toFixed(4)}`;
    function SessionBilling({ useProjection }) {
      const cost = useProjection('forstSessionCost');
      const [open, setOpen] = React.useState(false);
      const rootRef = React.useRef(null);
      const panelRef = React.useRef(null);
      const triggerRef = React.useRef(null);
      const dialogId = React.useId();
      const anchorName = `--forst-cost-${dialogId.replaceAll(/[^\w-]/g, '')}`;
      const pos = useLegacyPosition({ open, anchorRef: rootRef, panelRef, side: 'top', gap: 8, margin: 12 });
      useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef);
      React.useEffect(() => {
        if (!open) return;
        const onKeyDown = event => {
          if (event.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); }
        };
        const onClick = event => {
          if (event.target instanceof Node && !rootRef.current?.contains(event.target) && !panelRef.current?.contains(event.target)) setOpen(false);
        };
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('click', onClick, true);
        return () => { document.removeEventListener('keydown', onKeyDown); document.removeEventListener('click', onClick, true); };
      }, [open]);
      React.useEffect(() => { if (!cost || cost.pricedCalls + cost.unpricedCalls === 0) setOpen(false); }, [cost]);
      if (!cost || cost.pricedCalls + cost.unpricedCalls === 0) return null;
      const amount = dollars(cost.usd, cost.pricedCalls);
      const label = `${amount}${cost.unpricedCalls ? ' *' : ''}`;
      return h('span', {
        ref: rootRef, className: 'forst-cost-anchor',
        style: usesLegacyPosition ? undefined : { anchorName },
        'data-composer-stat': 'session-cost', 'data-dsh-session-cost': 'true',
        'data-usd': cost.usd, 'data-priced-calls': cost.pricedCalls, 'data-unpriced-calls': cost.unpricedCalls,
      },
      h(Tooltip, { label: `会话费用 ${label}`, side: 'top', portal: true, delayMs: 200, onlyWhenClipped: true, disabled: open },
        h('button', { ref: triggerRef, className: 'forst-cost-pill', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': open, 'aria-controls': open ? dialogId : undefined, 'aria-label': `会话费用 ${label}，点击查看明细`, onClick: () => setOpen(value => !value) },
          h(CostIcon), h('span', { className: 'forst-cost-label' }, label))),
      open && createPortal(h('div', {
        id: dialogId, ref: panelRef, role: 'dialog', 'aria-label': '会话费用', 'data-session-cost-details': true,
        className: usesLegacyPosition ? 'forst-cost-panel' : 'forst-cost-panel forst-cost-panel--anchored',
        style: usesLegacyPosition ? pos ?? { visibility: 'hidden', left: 0, top: 0 } : { '--forst-cost-anchor': anchorName },
      },
        h('div', { className: 'forst-cost-title' }, h('span', { className: 'forst-cost-title-label' }, h(CostIcon), '会话费用'), h('span', { className: 'forst-cost-title-value' }, label)),
        h('div', { className: 'forst-cost-rule', 'aria-hidden': true }),
        h('dl', { className: 'forst-cost-details' },
          [['输入', 'inputUsd'], ['输出', 'outputUsd'], ['缓存读', 'cacheReadUsd'], ['缓存写', 'cacheWriteUsd']].filter(([, key]) => key !== 'cacheWriteUsd' || cost.cacheWriteUsd > 0).map(([name, key]) =>
            h(React.Fragment, { key }, h('dt', null, name), h('dd', { 'data-cost-bucket': key }, dollars(cost[key], cost.pricedCalls)))))), document.body));
    }
    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style');
        style.dataset.pluginCss = '@forst/dsh-session-billing';
        style.textContent = css;
        document.head.appendChild(style);
        return () => style.remove();
      });
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'session-cost', order: -1, label: '会话费用' }, SessionBilling));
    }
    return { apply, inject: ['slots'] };
  },
});
