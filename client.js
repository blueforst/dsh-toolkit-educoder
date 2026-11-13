// 由 scripts/build-client.mjs 生成；服务器模块与固定版本的本机通用模块在此组合。
window.__ModuleLoader__.load({
  id: '@forst/dsh-toolkit',
  factory: require => {
    const modules = [
(require => {
    const React = require('react');
    const h = React.createElement;
    const units = bytes => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
    const percent = value => Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
    const colorFor = value => value > 90 ? '#ef4444' : value > 70 ? '#f59e0b' : '#3b82f6';

    function useSample(wide, endpoint, scope, intervalMs = 1000) {
      const [sample, setSample] = React.useState(null);
      const [unavailable, setUnavailable] = React.useState(false);
      React.useEffect(() => {
        if (!wide) return;
        let disposed = false;
        let pending = false;
        let controller;
        async function refresh() {
          if (disposed || pending || document.visibilityState === 'hidden') return;
          pending = true;
          controller = new AbortController();
          const timeout = window.setTimeout(() => controller.abort(), 6500);
          try {
            const response = await fetch(endpoint, { cache: 'no-store', signal: controller.signal });
            if (!response.ok) throw new Error('数据暂不可用');
            const data = await response.json();
            if (data.scope !== scope || !Number.isFinite(data.timestamp)) throw new Error('数据格式无效');
            if (!disposed) { setSample(data); setUnavailable(false); }
          } catch {
            if (!disposed) setUnavailable(true);
          } finally { window.clearTimeout(timeout); pending = false; }
        }
        refresh();
        const timer = window.setInterval(refresh, intervalMs);
        document.addEventListener('visibilitychange', refresh);
        return () => {
          disposed = true;
          controller?.abort();
          window.clearInterval(timer);
          document.removeEventListener('visibilitychange', refresh);
        };
      }, [wide, endpoint, scope, intervalMs]);
      return { sample, stale: unavailable || !sample || Date.now() - sample.timestamp > Math.max(10000, intervalMs * 2 + 5000) };
    }

    function MetricBar({ label, value, stale, detail, suffix, ariaLabel, precision = 1 }) {
      const numeric = percent(value);
      const text = numeric === null ? '--' : `${numeric.toFixed(precision)}%`;
      return h('div', { style: { minWidth: 0 } },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', fontSize: '12px', lineHeight: '16px' } },
          h('span', { style: { fontWeight: 500 } }, label,
            suffix ? h('span', { style: { marginLeft: '6px', fontSize: '11px', opacity: .5, fontWeight: 400 } }, suffix) : null),
          h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, text)),
        h('div', {
          role: 'progressbar', 'aria-label': ariaLabel, 'aria-valuemin': 0, 'aria-valuemax': 100,
          'aria-valuenow': stale ? undefined : numeric ?? undefined,
          'aria-valuetext': stale ? '数据暂不可用' : text,
          style: { height: '5px', marginTop: '5px', borderRadius: '999px', overflow: 'hidden', background: 'var(--dsw-alias-border-l2,#e5e7eb)' },
        }, h('div', { style: { height: '100%', width: `${numeric ?? 0}%`, borderRadius: '999px', background: stale ? '#94a3b8' : colorFor(numeric), transition: 'width .4s ease,background-color .2s ease' } })),
        detail ? h('div', { style: { marginTop: '4px', fontSize: '11px', lineHeight: '14px', opacity: .55, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } }, stale ? '等待更新' : detail) : null);
    }

    function MetricsSection({ wide, stale, children }) {
      // The bundled common quota section owns the shared footer's wrapping.
      // Keep a single owner so unmounting cannot restore another effect's value.
      if (!wide) return null;
      return h('div', {
        'data-dsh-server-metrics': 'true',
        'data-placement': 'sidebar', 'data-state': stale ? 'unavailable' : 'ready',
        'aria-label': '服务器资源',
        title: stale ? '数据暂不可用' : '服务器整机资源，每 1 秒更新',
        style: {
          boxSizing: 'border-box', width: '100%', flex: '0 0 100%', padding: '10px 12px 12px', marginBottom: '4px',
          display: 'flex', flexDirection: 'column', gap: '11px', color: 'var(--dsw-alias-label-primary,#172033)',
          borderBottom: '1px solid var(--dsw-alias-border-l2,#e5e7eb)',
        },
      }, children);
    }

    function ServerMetrics({ wide }) {
      const { sample, stale } = useSample(wide, '/server-metrics', 'host');
      return h(MetricsSection, { wide, stale }, [
        { label: 'CPU', data: sample?.cpu }, { label: '内存', data: sample?.memory }, { label: '硬盘', data: sample?.disk },
      ].map(({ label, data }, index) => h(MetricBar, {
        key: label, label, value: data?.percent, stale, ariaLabel: `服务器${label}使用率`,
        suffix: index === 0 && data ? `${data.cores} 核` : null,
        detail: index === 0 ? null : data ? `${units(data.used)} / ${units(data.total)}` : '等待更新',
      })));
    }

    function apply(ctx) {
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'server-metrics', order: 49, label: '服务器资源' }, ServerMetrics));
    }
    return { apply, inject: ['slots'] };
  })(require),
(require => {
    const React = require('react');
    const h = React.createElement;
    const percent = value => Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
    const colorFor = value => value > 90 ? '#ef4444' : value > 70 ? '#f59e0b' : '#3b82f6';

    function useSample(wide, endpoint, scope, intervalMs = 1000) {
      const [sample, setSample] = React.useState(null);
      const [unavailable, setUnavailable] = React.useState(null);
      React.useEffect(() => {
        if (!wide) return;
        let disposed = false;
        let pending = false;
        let controller;
        async function refresh() {
          if (disposed || pending || document.visibilityState === 'hidden') return;
          pending = true;
          controller = new AbortController();
          const timeout = window.setTimeout(() => controller.abort(), 6500);
          try {
            const response = await fetch(endpoint, { cache: 'no-store', signal: controller.signal });
            if (!response.ok) {
              const error = response.status === 503 ? await response.json() : null;
              if (!disposed) setUnavailable(error?.code === 'missing-credential' ? '未配置 OpenCode Go API Key' : '暂时无法读取额度');
              return;
            }
            const data = await response.json();
            if (data.scope !== scope || !Number.isFinite(data.timestamp)) throw new Error('数据格式无效');
            if (!disposed) { setSample(data); setUnavailable(null); }
          } catch {
            if (!disposed) setUnavailable('暂时无法读取额度');
          } finally { window.clearTimeout(timeout); pending = false; }
        }
        refresh();
        const timer = window.setInterval(refresh, intervalMs);
        document.addEventListener('visibilitychange', refresh);
        return () => {
          disposed = true;
          controller?.abort();
          window.clearInterval(timer);
          document.removeEventListener('visibilitychange', refresh);
        };
      }, [wide, endpoint, scope, intervalMs]);
      return { sample, unavailable, stale: Boolean(unavailable) || !sample || Date.now() - sample.timestamp > Math.max(10000, intervalMs * 2 + 5000) };
    }

    function MetricBar({ label, value, stale, detail, suffix, ariaLabel, precision = 1 }) {
      const numeric = percent(value);
      const text = numeric === null ? '--' : `${numeric.toFixed(precision)}%`;
      return h('div', { style: { minWidth: 0 } },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', fontSize: '12px', lineHeight: '16px' } },
          h('span', { style: { fontWeight: 500 } }, label,
            suffix ? h('span', { style: { marginLeft: '6px', fontSize: '11px', opacity: .5, fontWeight: 400 } }, suffix) : null),
          h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, text)),
        h('div', {
          role: 'progressbar', 'aria-label': ariaLabel, 'aria-valuemin': 0, 'aria-valuemax': 100,
          'aria-valuenow': stale ? undefined : numeric ?? undefined,
          'aria-valuetext': stale ? detail : text,
          style: { height: '5px', marginTop: '5px', borderRadius: '999px', overflow: 'hidden', background: 'var(--dsw-alias-border-l2,#e5e7eb)' },
        }, h('div', { style: { height: '100%', width: `${numeric ?? 0}%`, borderRadius: '999px', background: stale ? '#94a3b8' : colorFor(numeric), transition: 'width .4s ease,background-color .2s ease' } })),
        detail ? h('div', { style: { marginTop: '4px', fontSize: '11px', lineHeight: '14px', opacity: .55, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } }, detail) : null);
    }

    function QuotaSection({ wide, stale, detail, children }) {
      const rootRef = React.useRef(null);
      React.useLayoutEffect(() => {
        if (!wide || !rootRef.current) return;
        let container = rootRef.current.parentElement;
        while (container && getComputedStyle(container).display === 'contents') container = container.parentElement;
        if (!container) return;
        // The native footer is a single flex row. Quota owns this one reversible
        // override in both packages so the full-width section does not squeeze
        // the native action buttons; the server metrics section only consumes it.
        const previous = container.style.getPropertyValue('flex-wrap');
        const priority = container.style.getPropertyPriority('flex-wrap');
        container.style.setProperty('flex-wrap', 'wrap');
        return () => {
          // Do not undo an unrelated layout change made after this effect.
          if (container.style.getPropertyValue('flex-wrap') !== 'wrap' ||
              container.style.getPropertyPriority('flex-wrap') !== '') return;
          if (previous) container.style.setProperty('flex-wrap', previous, priority);
          else container.style.removeProperty('flex-wrap');
        };
      }, [wide]);
      if (!wide) return null;
      return h('div', {
        ref: rootRef,
        'data-dsh-opencode-go-quota': 'true',
        'data-placement': 'sidebar', 'data-state': stale ? 'unavailable' : 'ready',
        'aria-label': 'OpenCode Go 月额度',
        title: stale ? detail : 'OpenCode Go 官方本月已用额度，每 60 秒刷新',
        style: {
          boxSizing: 'border-box', width: '100%', flex: '0 0 100%', padding: '10px 12px 12px', marginBottom: '4px',
          display: 'flex', flexDirection: 'column', gap: '11px', color: 'var(--dsw-alias-label-primary,#172033)',
          borderBottom: '1px solid var(--dsw-alias-border-l2,#e5e7eb)',
        },
      }, children);
    }

    function OpenCodeQuota({ wide }) {
      const { sample, stale, unavailable } = useSample(wide, '/opencode-go-quota', 'opencode-go-monthly', 60000);
      const monthly = sample?.monthly;
      const detail = unavailable ?? (stale ? '等待更新' : '本月已使用');
      return h(QuotaSection, { wide, stale, detail }, h(MetricBar, {
        label: 'OpenCode Go', value: monthly?.percent, stale, ariaLabel: 'OpenCode Go 本月已用额度',
        detail, precision: 0,
      }));
    }

    function apply(ctx) {
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'opencode-go-quota', order: 51, label: 'OpenCode Go 月额度' }, OpenCodeQuota));
    }
    return { apply, inject: ['slots'] };
  })(require),
(require => {
    const React = require('react');
    const { createPortal } = require('react-dom');
    const { Tooltip, useAnchoredPosition, useDismissOnOutsidePointer } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;
    // 与原生统计项使用相同设计变量，样式仅作用于本插件。
    const css = `
      .forst-cost-anchor{min-width:0;display:inline-flex;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}
      .forst-cost-pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:transparent;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer}
      .forst-cost-pill svg{flex:none;width:14px;height:14px}
      .forst-cost-label{min-width:0;overflow:hidden;text-overflow:ellipsis}
      .forst-cost-pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
      @media(hover:hover){.forst-cost-pill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}}
      .forst-cost-panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);max-height:calc(100dvh - 24px);overflow:auto;backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:16px;font-size:12px;line-height:18px;position:fixed}
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
      const pos = useAnchoredPosition({ open, anchorRef: rootRef, panelRef, side: 'top', gap: 8, margin: 12 });
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
        'data-composer-stat': 'session-cost', 'data-dsh-session-cost': 'true',
        'data-usd': cost.usd, 'data-priced-calls': cost.pricedCalls, 'data-unpriced-calls': cost.unpricedCalls,
      },
      h(Tooltip, { label: `会话费用 ${label}`, side: 'top', portal: true, delayMs: 200, onlyWhenClipped: true, disabled: open },
        h('button', { ref: triggerRef, className: 'forst-cost-pill', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': open, 'aria-controls': open ? dialogId : undefined, 'aria-label': `会话费用 ${label}，点击查看明细`, onClick: () => setOpen(value => !value) },
          h(CostIcon), h('span', { className: 'forst-cost-label' }, label))),
      open && createPortal(h('div', { id: dialogId, ref: panelRef, className: 'forst-cost-panel', role: 'dialog', 'aria-label': '会话费用', 'data-session-cost-details': true, style: pos ?? { visibility: 'hidden', left: 0, top: 0 } },
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
  })(require)
    ];
    return { inject: ['slots'], apply(ctx) { for (const module of modules) module.apply(ctx); } };
  },
});
