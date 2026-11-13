window.__ModuleLoader__.load({
  id: '@forst/dsh-opencode-go-quota',
  factory: require => {
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
  },
});
