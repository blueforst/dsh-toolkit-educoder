window.__ModuleLoader__.load({
  id: '@forst/dsh-educoder',
  factory: require => {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useId, useMemo, useRef, useState } = React;
    const panelId = 'dsh-educoder';

    const accountLabels = {
      ready: '已登录', unverified: '待核验', auth_required: '需重新登录', manual: '需人工处理',
    };
    const accountTones = {
      ready: 'green', unverified: 'amber', auth_required: 'red', manual: 'red',
    };
    const taskMeta = {
      running: { label: '运行中', tone: 'blue' },
      queued: { label: '排队中', tone: 'blue' },
      waiting: { label: '待启动', tone: 'slate' },
      paused: { label: '已暂停', tone: 'amber' },
      manual: { label: '需人工处理', tone: 'red' },
      failed: { label: '执行失败', tone: 'red' },
      passed: { label: '已通过', tone: 'green' },
      cancelled: { label: '已取消', tone: 'slate' },
    };
    const problemLabels = {
      auth_required: '账号会话已失效，请重新登录。',
      invalid_credentials: '登录未通过，请检查账号和密码。',
      tasks_disabled: '当前实例开放账号登录和课程查看，作业执行尚未启用。',
      course_limit: '该课程超过 1000 项作业，请分批启动。',
      live_disabled: '此实例未启用真实 EduCoder 提交。',
      next_stage: '已通过本关，准备读取下一关。',
      stage_limit: '已达到单次任务的关卡上限。',
      signature_error: '平台拒绝了请求签名。',
      manual_required: '平台需要人工处理，请核对登录验证或题型。',
      choice_closed: '头歌已关闭当前关卡的评测。',
      unavailable: '服务暂不可用，请稍后重试。',
      uncertain: '平台返回结果不明确，请先核对远端状态。',
      invalid_scope: '无法确认该账号有权访问所选作业。',
      invalid_input: '请检查输入内容后重试。',
      verification_pending: '正在等待平台确认评测结果。',
      verification_failed: '平台评测未通过。',
      budget: '已达到任务运行预算。',
      timeout: '任务已达到时间上限。',
      cancelled: '任务已取消。',
      agent_failed: 'Agent 运行失败，可查看关联会话。',
      terminal_unavailable: '当前终端需要人工处理。',
      write_unverified: '平台尚未确认修改结果。',
      resume_after_readback: '已读回平台当前代码，准备继续解题。',
      busy: '该账号有任务在运行，请先暂停或等待。',
      stale_scope: '远端任务已变化，请重新读取作业。',
      already_exists: '该账号或任务已存在。',
      not_found: '该账号或任务已被移除。',
      invalid_state: '任务状态已更新，请刷新后重试。',
      retry_limit: '已达到重试上限。',
      recovery_required: '任务有未确认的远端操作，恢复时会先核对状态。',
    };
    const commands = {
      start: { label: '启动', drawerLabel: '立即启动', primary: true, states: ['waiting'] },
      pause: { label: '暂停', drawerLabel: '暂停执行', primary: false, states: ['queued', 'running'] },
      resume: { label: '恢复', drawerLabel: '恢复执行', primary: true, states: ['paused', 'manual', 'failed'] },
      cancel: { label: '取消任务', drawerLabel: '取消任务', danger: true, states: ['waiting', 'queued', 'running', 'paused', 'manual', 'failed'] },
    };
    const statusFilterOrder = ['running', 'queued', 'waiting', 'manual', 'failed', 'paused', 'passed', 'cancelled'];
    const activeStatuses = new Set(['running', 'queued']);
    const issueStatuses = new Set(['manual', 'failed']);

    const formatDate = value => {
      if (!value) return '';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
    };
    const formatRelativeTime = value => {
      if (!value) return '';
      const ts = typeof value === 'number' ? value : Date.parse(value);
      if (!Number.isFinite(ts)) return '';
      const diffSec = Math.round((Date.now() - ts) / 1000);
      if (diffSec < 10) return '刚刚';
      if (diffSec < 60) return `${diffSec} 秒前`;
      const diffMin = Math.round(diffSec / 60);
      if (diffMin < 60) return `${diffMin} 分钟前`;
      const diffHr = Math.round(diffMin / 60);
      if (diffHr < 24) return `${diffHr} 小时前`;
      return formatDate(value);
    };
    const formatClock = value => {
      if (!value) return '';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    };
    const titleOf = (items, id) => items.find(item => item.id === id)?.title || id;
    const labelOf = (labels, key, fallback) => Object.hasOwn(labels, key) ? labels[key] : fallback;
    const taskMessage = code => code ? labelOf(problemLabels, code, '查看任务记录以了解详情。') : '';
    const errorMessage = error => labelOf(problemLabels, error?.code, '请求失败，请刷新后重试。');
    const pct = (passed, total) => total > 0 ? Math.min(100, Math.max(0, Math.round((passed / total) * 100))) : 0;
    const avatarText = text => {
      const raw = typeof text === 'string' ? text.trim() : '';
      if (!raw) return 'E';
      const parts = raw.split(/[·|｜/]+/).map(part => part.trim()).filter(Boolean);
      const preferred = parts.find(part => /^[^\d*_\s-]/.test(part)) || raw.replace(/^[\d*_\s-]+/, '') || raw;
      return (preferred.slice(0, 1) || 'E').toUpperCase();
    };

    async function request(action, fields, signal) {
      const response = await fetch('/dsh-educoder/api', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...fields }),
        signal: AbortSignal.any([AbortSignal.timeout(45000), ...(signal ? [signal] : [])]),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.ok !== true) {
        const error = new Error('EduCoder 请求失败');
        error.code = result?.error?.code;
        throw error;
      }
      return result.data;
    }

    function SvgIcon({ paths, size = 15, className, spin }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
        className: ['edu-icon', spin && 'edu-spin', className].filter(Boolean).join(' '),
      }, paths.map((d, index) => h('path', { key: index, d })));
    }

    const icons = {
      brand: ['M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z', 'm9 10-2 2 2 2', 'm15 10 2 2-2 2', 'm13 8-2 8'],
      refresh: ['M21 12a9 9 0 1 1-2.64-6.36', 'M21 3v6h-6'],
      plus: ['M12 5v14', 'M5 12h14'],
      check: ['M20 6 9 17l-5-5'],
      eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z'],
      eyeOff: ['M9.88 9.88a3 3 0 1 0 4.24 4.24', 'M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68', 'M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61', 'M2 2l20 20'],
      external: ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
      close: ['M18 6 6 18', 'M6 6l12 12'],
      book: ['M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20'],
      queue: ['M4 6h16', 'M4 12h16', 'M4 18h10'],
      search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z', 'm21 21-4.3-4.3'],
      more: ['M12 12h.01', 'M19 12h.01', 'M5 12h.01'],
      play: ['m6 4 14 8-14 8V4Z'],
    };

    function Button({ children, primary, danger, ghost, size, iconOnly, ...props }) {
      return h('button', {
        type: 'button', ...props,
        className: [
          'edu-btn', primary && 'edu-btn-primary', danger && 'edu-btn-danger',
          ghost && 'edu-btn-ghost', size === 'sm' && 'edu-btn-sm', iconOnly && 'edu-btn-icon',
          props.className,
        ].filter(Boolean).join(' '),
      }, children);
    }

    function StatusPill({ status, map = taskMeta, interactive, onClick, className }) {
      const meta = map[status] || { label: '待确认', tone: 'slate' };
      const dotClass = 'edu-dot edu-dot-' + status;
      const body = [h('span', { key: 'dot', className: dotClass, 'aria-hidden': true }), meta.label];
      if (interactive) {
        return h('button', {
          type: 'button', className: ['edu-pill edu-pill-interactive', className].filter(Boolean).join(' '),
          'data-tone': meta.tone, onClick,
        }, body);
      }
      return h('span', { className: ['edu-pill', className].filter(Boolean).join(' '), 'data-tone': meta.tone }, body);
    }

    function AccountModal({ modal, busy, activeKey, modalError, onSubmit, onClose }) {
      const loginId = useId();
      const passwordId = useId();
      const [showPassword, setShowPassword] = useState(false);
      const loginRef = useRef(null);
      const isRelogin = modal.kind === 'relogin';
      const targetAccount = modal.account;
      const submitting = busy && activeKey === (isRelogin ? 'relogin:' + targetAccount.id : 'addAccount');

      useEffect(() => {
        loginRef.current?.focus();
      }, []);

      return h('div', {
        className: 'edu-modal-backdrop',
        onMouseDown(event) {
          if (event.target === event.currentTarget && !busy) onClose();
        },
      },
      h('form', {
        className: 'edu-modal',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'edu-account-modal-title',
        onSubmit(event) {
          event.preventDefault();
          const form = event.currentTarget;
          const login = form.elements.namedItem('login').value.trim();
          const passwordInput = form.elements.namedItem('password');
          const password = passwordInput.value;
          passwordInput.value = '';
          setShowPassword(false);
          if (login && password) onSubmit(targetAccount?.id, login, password);
        },
      },
      h('div', { className: 'edu-modal-head' },
        h('div', null,
          h('h2', { id: 'edu-account-modal-title' },
            isRelogin ? '重新登录 · ' + (targetAccount.label || targetAccount.id) : '绑定 EduCoder 账号'),
          h('p', { className: 'edu-muted edu-xs edu-mt-2' }, '密码仅用于一次性换取独立隔离会话，不会保存或回显')),
        h(Button, { size: 'sm', iconOnly: true, ghost: true, disabled: busy, onClick: onClose, 'aria-label': '关闭弹窗' },
          h(SvgIcon, { paths: icons.close, size: 15 }))),

      modalError && h('div', { role: 'alert', className: 'edu-modal-error' }, modalError),

      h('div', { className: 'edu-field' },
        h('label', { htmlFor: loginId }, '用户名、手机号或邮箱'),
        h('input', {
          ref: loginRef, id: loginId, name: 'login', className: 'edu-input',
          autoComplete: 'off', maxLength: 255, required: true, placeholder: '输入头歌登录账号',
        })),

      h('div', { className: 'edu-field' },
        h('label', { htmlFor: passwordId }, '密码'),
        h('div', { className: 'edu-password-wrap' },
          h('input', {
            id: passwordId, name: 'password', className: 'edu-input',
            type: showPassword ? 'text' : 'password',
            autoComplete: 'off', maxLength: 1024, required: true, placeholder: '仅用于换取独立会话',
          }),
          h('button', {
            type: 'button', className: 'edu-eye-btn',
            'aria-label': showPassword ? '隐藏密码' : '显示密码',
            'aria-pressed': showPassword,
            title: showPassword ? '隐藏密码' : '显示密码',
            onClick: () => setShowPassword(value => !value),
          }, h(SvgIcon, { paths: showPassword ? icons.eyeOff : icons.eye, size: 14 })))),

      h('div', { className: 'edu-modal-foot' },
        h(Button, { disabled: busy, onClick: onClose }, '取消'),
        h(Button, { type: 'submit', primary: true, disabled: busy },
          submitting && h(SvgIcon, { paths: icons.refresh, size: 13, spin: true }),
          isRelogin ? '验证并更新会话' : '验证并绑定'))));
    }

    function AccountRail({
      accounts, selectedId, tasks, showTaskMetrics, busy, activeKey,
      chooseAccount, checkAccount, openAddModal, openReloginModal, removeAccount,
    }) {
      const [menuId, setMenuId] = useState(null);
      const [confirmRemoveId, setConfirmRemoveId] = useState(null);

      useEffect(() => {
        if (!menuId) return;
        const onPointer = event => {
          if (!event.target.closest?.('.edu-acc-menu-wrap')) setMenuId(null);
        };
        document.addEventListener('mousedown', onPointer);
        return () => document.removeEventListener('mousedown', onPointer);
      }, [menuId]);

      return h('aside', { className: 'edu-rail', 'aria-labelledby': 'edu-account-heading' },
        h('div', { className: 'edu-rail-head' },
          h('h2', { id: 'edu-account-heading', className: 'edu-rail-title' }, '已绑定账号 (', accounts.length, ')'),
          h('span', { className: 'edu-faint edu-xs' }, '凭证隔离')),

        h('div', { className: 'edu-rail-scroll' },
          accounts.map(account => {
            const isSelected = account.id === selectedId;
            const isMenuOpen = menuId === account.id;
            const checking = busy && activeKey === 'check:' + account.id;
            const removing = busy && activeKey === 'remove:' + account.id;
            const activeCount = showTaskMetrics
              ? tasks.filter(task => task.accountId === account.id && activeStatuses.has(task.status)).length
              : 0;
            const needRelogin = account.status === 'auth_required' || account.status === 'manual';

            return h('div', {
              key: account.id,
              className: ['edu-acc-item', isSelected && 'selected'].filter(Boolean).join(' '),
            },
            h('div', { className: 'edu-acc-top' },
              h('button', {
                type: 'button', className: 'edu-acc-trigger', 'aria-pressed': isSelected,
                disabled: busy, onClick: () => { setConfirmRemoveId(null); chooseAccount(account.id); },
              },
              h('span', { className: 'edu-avatar', 'aria-hidden': true },
                avatarText(account.label || account.id),
                h('span', { className: 'edu-avatar-dot edu-dot edu-dot-' + account.status })),
              h('span', { className: 'edu-acc-meta' },
                h('span', { className: 'edu-acc-name', title: account.label || account.id }, account.label || account.id),
                h('span', { className: 'edu-acc-sub' },
                  h('span', { className: 'edu-acc-status', 'data-tone': accountTones[account.status] || 'slate' },
                    labelOf(accountLabels, account.status, '待确认')),
                  account.updatedAt && h('span', { className: 'edu-faint', title: formatDate(account.updatedAt) },
                    ' · ', formatRelativeTime(account.updatedAt))))),

              h('div', { className: 'edu-acc-menu-wrap' },
                h('button', {
                  type: 'button',
                  className: ['edu-acc-more', isMenuOpen && 'open'].filter(Boolean).join(' '),
                  'aria-label': '账号操作 · ' + (account.label || account.id),
                  'aria-expanded': isMenuOpen,
                  disabled: busy,
                  onClick: () => setMenuId(prev => prev === account.id ? null : account.id),
                }, h(SvgIcon, { paths: checking ? icons.refresh : icons.more, size: 15, spin: checking })),
                isMenuOpen && h('div', { className: 'edu-popover', role: 'menu' },
                  h('button', {
                    type: 'button', role: 'menuitem', className: 'edu-popover-item',
                    onClick: () => { setMenuId(null); checkAccount(account.id); },
                  }, h(SvgIcon, { paths: icons.refresh, size: 13 }), '检查登录状态'),
                  h('button', {
                    type: 'button', role: 'menuitem', className: 'edu-popover-item',
                    onClick: () => { setMenuId(null); openReloginModal(account); },
                  }, '重新输入凭据登录'),
                  h('div', { className: 'edu-popover-sep' }),
                  h('button', {
                    type: 'button', role: 'menuitem', className: 'edu-popover-item danger',
                    onClick: () => { setMenuId(null); setConfirmRemoveId(account.id); },
                  }, '解绑并清除记录')))),

            activeCount > 0 && h('div', { className: 'edu-acc-running edu-xs' },
              h('span', { className: 'edu-dot edu-dot-running', 'aria-hidden': true }),
              h('span', null, activeCount, ' 项任务执行中')),

            needRelogin && confirmRemoveId !== account.id && h('div', { className: 'edu-acc-cta' },
              h('span', { className: 'edu-xs edu-tone-red' }, account.status === 'manual' ? '需要人工核验' : '会话已过期'),
              h(Button, { size: 'sm', disabled: busy, onClick: () => openReloginModal(account) }, '重新登录')),

            confirmRemoveId === account.id && h('div', { className: 'edu-acc-cta' },
              h('span', { className: 'edu-xs edu-tone-red' }, '确认解绑此账号？'),
              h('div', { className: 'edu-row-gap-4' },
                h(Button, {
                  size: 'sm', danger: true, disabled: busy,
                  onClick: () => { setConfirmRemoveId(null); removeAccount(account.id); },
                }, removing ? '解绑中…' : '删除'),
                h(Button, { size: 'sm', disabled: busy, onClick: () => setConfirmRemoveId(null) }, '取消'))));
          })),

        h('div', { className: 'edu-rail-foot' },
          h(Button, { className: 'edu-btn-full', disabled: busy, onClick: openAddModal },
            h(SvgIcon, { paths: icons.plus, size: 14 }), '添加 EduCoder 账号')));
    }

    function useCatalog(action, scope, fields, version) {
      const [entry, setEntry] = useState({ scope: '', version: -1, items: [], error: '' });
      useEffect(() => {
        if (!scope) return;
        const controller = new AbortController();
        request(action, fields, controller.signal)
          .then(items => {
            if (!controller.signal.aborted) setEntry({ scope, version, items, error: '' });
          })
          .catch(failure => {
            if (!controller.signal.aborted) setEntry({ scope, version, items: [], error: errorMessage(failure) });
          });
        return () => controller.abort();
      }, [action, scope, version]);
      const matching = entry.scope === scope && entry.version === version;
      return { loading: Boolean(scope) && !matching, items: matching ? entry.items : [], error: matching ? entry.error : '' };
    }

    function resolveLinkedTask(tasks, accountId, courseId, homeworkId) {
      return tasks.find(task => task.accountId === accountId && task.courseId === courseId && task.homeworkId === homeworkId) || null;
    }

    function CatalogStage({
      account, version, refreshCatalog, tasks, tasksEnabled, busy, activeKey,
      checkedMap, onToggleHomework, onToggleAllVisible, onRemoveCheckedKey, onClearChecked, onAllocateChecked,
      onStartCourse, onRunSingle, onInspectTask,
    }) {
      const [courseId, setCourseId] = useState('');
      const [hwFilter, setHwFilter] = useState('all');
      const [hwSearch, setHwSearch] = useState('');
      const [drawerOpen, setDrawerOpen] = useState(false);

      const courses = useCatalog('courses', account ? account.id : '', { accountId: account?.id }, version);
      const currentCourse = courses.items.some(item => item.id === courseId) ? courseId : (courses.items[0]?.id || '');
      const currentCourseObj = courses.items.find(item => item.id === currentCourse);
      const homeworks = useCatalog('homeworks', currentCourse ? `${account?.id || ''}:${currentCourse}` : '', {
        accountId: account?.id, courseId: currentCourse,
      }, version);

      const query = hwSearch.trim().toLocaleLowerCase();
      const summary = useMemo(() => {
        let totalStages = 0;
        let passedStages = 0;
        let doneCount = 0;
        for (const hw of homeworks.items) {
          const hasCount = Number.isSafeInteger(hw.taskCount) && hw.taskCount > 0;
          if (hasCount) {
            totalStages += hw.taskCount;
            passedStages += Math.min(hw.taskCount, hw.passedCount ?? 0);
            if ((hw.passedCount ?? 0) >= hw.taskCount) doneCount += 1;
          }
        }
        return {
          totalStages,
          passedStages,
          doneCount,
          pendingCount: homeworks.items.length - doneCount,
          pctVal: pct(passedStages, totalStages),
        };
      }, [homeworks.items]);

      const filtered = useMemo(() => homeworks.items.filter(hw => {
        const hasCount = Number.isSafeInteger(hw.taskCount) && hw.taskCount > 0;
        const done = hasCount && (hw.passedCount ?? 0) >= hw.taskCount;
        if (hwFilter === 'pending' && done) return false;
        if (hwFilter === 'done' && !done) return false;
        if (query && !hw.title.toLocaleLowerCase().includes(query) && !String(hw.id).toLocaleLowerCase().includes(query)) {
          return false;
        }
        return true;
      }), [homeworks.items, hwFilter, query]);

      const allFilteredChecked = Boolean(
        account && currentCourse && filtered.length > 0 &&
        filtered.every(hw => checkedMap.has(`${account.id}:${currentCourse}:${hw.id}`)),
      );
      const checkedItems = Array.from(checkedMap.values());
      const checkedAccountCount = new Set(checkedItems.map(item => item.accountId)).size;
      const startingCourse = activeKey === `startCourse:${account?.id}:${currentCourse}`;

      return h('div', { className: 'edu-stage', 'aria-labelledby': 'edu-catalog-heading' },
        h('h2', { id: 'edu-catalog-heading', className: 'edu-sr-only' }, '课程与作业'),

        h('div', { className: 'edu-course-header' },
          h('div', { className: 'edu-course-tabs-row' },
            courses.loading
              ? h('div', { className: 'edu-tabs-skeleton', 'aria-hidden': true }, h('span', { className: 'edu-skeleton-pill' }), h('span', { className: 'edu-skeleton-pill' }))
              : h('div', { className: 'edu-course-tabs', role: 'tablist', 'aria-label': '课程快速切换' },
                courses.items.map(item => {
                  const active = item.id === currentCourse;
                  return h('button', {
                    key: item.id, type: 'button', role: 'tab', 'aria-selected': active,
                    className: ['edu-course-tab', active && 'active'].filter(Boolean).join(' '),
                    onClick: () => { setCourseId(item.id); setHwSearch(''); setHwFilter('all'); },
                  },
                  h('span', null, item.title),
                  active && !homeworks.loading && homeworks.items.length > 0 &&
                    h('span', { className: 'edu-course-tab-count edu-tabular' }, homeworks.items.length));
                })),
            h('div', { className: 'edu-course-actions' },
              tasksEnabled && account && currentCourse && h(Button, {
                size: 'sm', primary: true,
                disabled: busy || homeworks.loading || Boolean(homeworks.error) || summary.pendingCount === 0,
                'aria-busy': startingCourse,
                title: '启动所选课程的全部未完成作业',
                onClick: () => onStartCourse(account.id, currentCourse),
              }, h(SvgIcon, { paths: startingCourse ? icons.refresh : icons.play, size: 13, spin: startingCourse }), '一键通关'),
              h(Button, {
                size: 'sm', ghost: true,
                disabled: busy || courses.loading, onClick: refreshCatalog,
              }, h(SvgIcon, { paths: icons.refresh, size: 13, spin: courses.loading || homeworks.loading }), '重载目录')))),

        courses.error && h('div', { className: 'edu-stage-scroll' },
          h('div', { role: 'alert', className: 'edu-inline-alert' },
            h('span', null, '读取课程目录失败：', courses.error),
            h(Button, { size: 'sm', onClick: refreshCatalog }, '重试'))),

        !courses.error && !courses.loading && courses.items.length === 0 && h('div', { className: 'edu-stage-scroll' },
          h('div', { className: 'edu-empty-card' },
            h('strong', null, '该账号暂无可用课程'),
            h('p', { className: 'edu-muted edu-xs' }, '可点击右上角「重载目录」重新拉取最新课程列表。'))),

        !courses.error && currentCourse && h(React.Fragment, null,
          h('div', { className: 'edu-catalog-toolbar' },
            h('div', { className: 'edu-course-meter' },
              summary.totalStages > 0
                ? h(React.Fragment, null,
                  h('span', { className: 'edu-meter-text edu-tabular' }, summary.passedStages, '/', summary.totalStages, ' 关'),
                  h('div', { className: 'edu-meter-track', 'aria-hidden': true },
                    h('div', { className: ['edu-meter-fill', summary.pctVal >= 100 && 'done'].filter(Boolean).join(' '), style: { width: summary.pctVal + '%' } })),
                  h('span', { className: 'edu-muted edu-xs edu-tabular' }, summary.pctVal, '%'))
                : h('span', { className: 'edu-muted edu-xs' },
                  homeworks.loading ? '正在统计课程进度…' : (currentCourseObj?.title || '') + ' · ' + homeworks.items.length + ' 项作业')),

            h('div', { className: 'edu-filter-row' },
              h('div', { className: 'edu-seg-pills', role: 'group', 'aria-label': '按完成度筛选作业' },
                [['all', '全部', homeworks.items.length], ['pending', '未通关', summary.pendingCount], ['done', '已通关', summary.doneCount]]
                  .map(([val, text, count]) => h('button', {
                    key: val, type: 'button',
                    className: ['edu-seg-pill', hwFilter === val && 'active'].filter(Boolean).join(' '),
                    'aria-pressed': hwFilter === val,
                    onClick: () => setHwFilter(val),
                  }, text, ' ', h('span', { className: 'edu-tabular' }, count)))),
              h('div', { className: 'edu-search-box' },
                h(SvgIcon, { paths: icons.search, size: 14 }),
                h('input', {
                  className: 'edu-search-input', value: hwSearch,
                  onChange: event => setHwSearch(event.target.value),
                  placeholder: '筛选作业…', 'aria-label': '筛选作业',
                })))),

          h('div', { className: ['edu-stage-scroll', checkedItems.length > 0 && 'with-float'].filter(Boolean).join(' ') },
            homeworks.error
              ? h('div', { role: 'alert', className: 'edu-inline-alert' },
                h('span', null, '读取作业列表失败：', homeworks.error),
                h(Button, { size: 'sm', onClick: refreshCatalog }, '重试'))
              : homeworks.loading
                ? h('div', { className: 'edu-hw-list-card edu-skeleton-pad', 'aria-hidden': true },
                  h('div', { className: 'edu-skeleton-row' }),
                  h('div', { className: 'edu-skeleton-row' }),
                  h('div', { className: 'edu-skeleton-row' }))
                : h('div', { className: 'edu-hw-list-card' },
                  h('div', { className: ['edu-hw-head', !tasksEnabled && 'readonly'].filter(Boolean).join(' ') },
                    tasksEnabled && h('input', {
                      type: 'checkbox', checked: allFilteredChecked,
                      disabled: filtered.length === 0,
                      'aria-label': allFilteredChecked ? '取消全选当前列表作业' : '全选当前列表作业',
                      onChange: () => onToggleAllVisible(account, currentCourseObj, filtered),
                    }),
                    h('span', null, '作业名称'),
                    h('span', null, '关卡进度'),
                    tasksEnabled
                      ? h(React.Fragment, null,
                        h('span', null, '队列状态'),
                        h('span', { className: 'edu-text-right' }, '操作'))
                      : h('span', { className: 'edu-text-right' }, '完成度')),

                  filtered.length === 0
                    ? h('div', { className: 'edu-empty-inline' },
                      homeworks.items.length === 0 ? '该课程暂无实训作业' : '没有符合筛选条件的作业')
                    : h('div', { role: 'listbox', 'aria-label': '作业列表' },
                      filtered.map(hw => {
                        const key = `${account.id}:${currentCourse}:${hw.id}`;
                        const checked = tasksEnabled && checkedMap.has(key);
                        const hasCounts = Number.isSafeInteger(hw.taskCount) && hw.taskCount > 0;
                        const passed = hw.passedCount ?? 0;
                        const done = hasCounts && passed >= hw.taskCount;
                        const hwPct = hasCounts ? pct(passed, hw.taskCount) : 0;
                        const linkedTask = tasksEnabled ? resolveLinkedTask(tasks, account.id, currentCourse, hw.id) : null;

                        return h('div', {
                          key: hw.id, role: 'option', 'aria-selected': checked,
                          className: ['edu-hw-row', !tasksEnabled && 'readonly', checked && 'checked'].filter(Boolean).join(' '),
                        },
                        tasksEnabled && h('div', null,
                          h('input', {
                            type: 'checkbox', checked,
                            'aria-label': '选择 ' + hw.title,
                            onChange: () => onToggleHomework(key, {
                              key, accountId: account.id, accountLabel: account.label || account.id,
                              courseId: currentCourse, courseTitle: currentCourseObj?.title || currentCourse,
                              homeworkId: hw.id, homeworkTitle: hw.title,
                            }),
                          })),
                        h('div', { className: 'edu-min0' },
                          h('div', { className: 'edu-hw-title edu-truncate', title: hw.title }, hw.title)),
                        h('div', { className: 'edu-hw-progress-cell' },
                          hasCounts ? h(React.Fragment, null,
                            h('div', { className: 'edu-hw-progress-label edu-tabular' },
                              h('span', null, done ? '已通关' : passed + '/' + hw.taskCount + ' 关'),
                              h('span', { className: 'edu-muted' }, hwPct, '%')),
                            h('div', { className: 'edu-hw-progress-bar' },
                              h('span', { className: done ? 'done' : undefined, style: { width: hwPct + '%' } })))
                            : h('span', { className: 'edu-muted edu-xs' }, '待读取关卡')),
                        !tasksEnabled
                          ? h('div', { className: 'edu-text-right' },
                            h('span', { className: 'edu-pill', 'data-tone': done ? 'green' : 'slate' }, done ? '已完成' : '进行中'))
                          : h(React.Fragment, null,
                            h('div', null,
                              linkedTask
                                ? h(StatusPill, { status: linkedTask.status, interactive: true, onClick: () => onInspectTask(linkedTask.id) })
                                : h('span', { className: 'edu-faint edu-xs' }, '未分配')),
                            h('div', { className: 'edu-hw-actions' },
                              linkedTask
                                ? h(Button, { size: 'sm', onClick: () => onInspectTask(linkedTask.id) }, '查看日志')
                                : h(Button, {
                                  size: 'sm', primary: !done, disabled: busy,
                                  onClick: () => onRunSingle({
                                    accountId: account.id, courseId: currentCourse, homeworkId: hw.id,
                                  }),
                                }, h(SvgIcon, { paths: icons.play, size: 12 }), done ? '重跑' : '直接运行'))));
                      }))))),

        tasksEnabled && checkedItems.length > 0 && h(React.Fragment, null,
          drawerOpen && h('div', { className: 'edu-float-drawer', role: 'dialog', 'aria-label': '已选作业清单' },
            h('div', { className: 'edu-float-drawer-head' },
              h('strong', { className: 'edu-sm' }, '已勾选跨课程 / 账号作业 (', checkedItems.length, ')'),
              h(Button, { size: 'sm', iconOnly: true, ghost: true, onClick: () => setDrawerOpen(false), 'aria-label': '收起清单' },
                h(SvgIcon, { paths: icons.close, size: 14 }))),
            h('div', { className: 'edu-float-drawer-list' },
              checkedItems.map(item => h('div', { key: item.key, className: 'edu-float-drawer-item' },
                h('div', { className: 'edu-min0 edu-flex1' },
                  h('div', { className: 'edu-truncate edu-strong' }, item.homeworkTitle),
                  h('div', { className: 'edu-truncate edu-xs edu-muted' }, item.accountLabel, ' · ', item.courseTitle)),
                h(Button, { size: 'sm', ghost: true, onClick: () => {
                  if (checkedItems.length <= 1) setDrawerOpen(false);
                  onRemoveCheckedKey(item.key);
                } }, '移除'))))),

          h('div', { className: 'edu-float-bar', role: 'region', 'aria-label': '批量作业操作' },
            h('div', { className: 'edu-float-count' },
              h('span', { className: 'edu-float-num edu-tabular' }, checkedItems.length),
              h('span', null, '已选作业', checkedAccountCount > 1 ? ` · 跨 ${checkedAccountCount} 个账号` : ''),
              h(Button, { size: 'sm', ghost: true, onClick: () => setDrawerOpen(value => !value) },
                drawerOpen ? '收起清单' : '查看清单 ▾')),
            h('div', { className: 'edu-float-sep' }),
            h('div', { className: 'edu-row-gap-6' },
              h(Button, { size: 'sm', ghost: true, disabled: busy, onClick: () => { setDrawerOpen(false); onClearChecked(); } }, '清空'),
              h(Button, { size: 'sm', disabled: busy, onClick: () => { setDrawerOpen(false); onAllocateChecked(false); } }, '待启动'),
              h(Button, { size: 'sm', primary: true, disabled: busy, onClick: () => { setDrawerOpen(false); onAllocateChecked(true); } },
                h(SvgIcon, { paths: icons.play, size: 12 }), '运行 (', checkedItems.length, ')')))));
    }

    function QueueStage({
      tasks, accounts, busy, activeKey, concurrency, saveConcurrency,
      runCommand, inspectTask, openSession, drawerTaskId,
      statusFilter, setStatusFilter,
    }) {
      const [query, setQuery] = useState('');
      const [checkedIds, setCheckedIds] = useState([]);
      const [confirmBulkCancel, setConfirmBulkCancel] = useState(false);
      const selectAllRef = useRef(null);

      const accountsById = useMemo(() => new Map(accounts.map(account => [account.id, account])), [accounts]);
      const search = query.trim().toLocaleLowerCase();

      const statusCounts = useMemo(() => {
        const map = new Map();
        for (const task of tasks) map.set(task.status, (map.get(task.status) || 0) + 1);
        return map;
      }, [tasks]);

      const visible = useMemo(() => tasks.filter(task => (!statusFilter || task.status === statusFilter)
        && (!search || [
          task.id, task.courseId, task.homeworkId, task.courseTitle, task.homeworkTitle,
          accountsById.get(task.accountId)?.label, taskMessage(task.code),
        ].some(val => typeof val === 'string' && val.toLocaleLowerCase().includes(search)))),
      [tasks, statusFilter, search, accountsById]);

      const visibleIdSet = useMemo(() => new Set(visible.map(task => task.id)), [visible]);
      const checkedTaskSet = useMemo(() => new Set(checkedIds), [checkedIds]);
      const selectedTasks = useMemo(() => tasks.filter(task => checkedTaskSet.has(task.id)), [tasks, checkedTaskSet]);
      const visibleCheckedCount = useMemo(() => visible.filter(task => checkedTaskSet.has(task.id)).length, [visible, checkedTaskSet]);
      const allVisibleChecked = visible.length > 0 && visibleCheckedCount === visible.length;
      const someVisibleChecked = visibleCheckedCount > 0 && visibleCheckedCount < visible.length;

      useEffect(() => {
        if (selectAllRef.current) selectAllRef.current.indeterminate = someVisibleChecked;
      }, [someVisibleChecked]);

      useEffect(() => {
        if (selectedTasks.length === 0) setConfirmBulkCancel(false);
      }, [selectedTasks.length]);

      const chips = statusFilterOrder.filter(key => statusCounts.has(key) || key === statusFilter);
      const bulkSpecs = [
        ['start', '批量启动', true],
        ['pause', '批量暂停', false],
        ['resume', '批量恢复', false],
      ];
      const cancellableIds = selectedTasks.filter(task => commands.cancel.states.includes(task.status)).map(task => task.id);

      return h('div', { className: 'edu-stage', 'aria-labelledby': 'edu-queue-heading' },
        h('h2', { id: 'edu-queue-heading', className: 'edu-sr-only' }, '任务队列'),

        h('div', { className: 'edu-queue-toolbar' },
          h('div', { className: 'edu-queue-chips', role: 'group', 'aria-label': '按状态快速筛选' },
            h('button', {
              type: 'button',
              className: ['edu-q-chip', statusFilter === '' && 'active'].filter(Boolean).join(' '),
              'aria-pressed': statusFilter === '',
              onClick: () => setStatusFilter(''),
            }, '全部 ', h('span', { className: 'edu-q-chip-num edu-tabular' }, tasks.length)),
            chips.map(key => h('button', {
              key, type: 'button',
              className: ['edu-q-chip', statusFilter === key && 'active'].filter(Boolean).join(' '),
              'aria-pressed': statusFilter === key,
              onClick: () => setStatusFilter(prev => prev === key ? '' : key),
            },
            h('span', { className: 'edu-dot edu-dot-' + key, 'aria-hidden': true }),
            h('span', null, taskMeta[key]?.label || key),
            h('span', { className: 'edu-q-chip-num edu-tabular' }, statusCounts.get(key) || 0)))),

          h('div', { className: 'edu-queue-right-tools' },
            h('div', { className: 'edu-search-box' },
              h(SvgIcon, { paths: icons.search, size: 14 }),
              h('input', {
                className: 'edu-search-input', value: query,
                onChange: event => setQuery(event.target.value),
                placeholder: '搜索账号、课程或作业…', 'aria-label': '搜索任务',
              })),
            concurrency !== null && h('div', { className: 'edu-stepper', role: 'group', 'aria-label': '全局并发上限' },
              h('span', { className: 'edu-stepper-label' }, '全局并发'),
              h('button', {
                type: 'button', 'aria-label': '减少全局并发',
                disabled: busy || concurrency <= 1,
                onClick: () => saveConcurrency(concurrency - 1),
              }, '−'),
              h('span', { className: 'edu-stepper-val edu-tabular' },
                busy && activeKey === 'settings' ? '…' : concurrency),
              h('button', {
                type: 'button', 'aria-label': '增加全局并发',
                disabled: busy || concurrency >= 32,
                onClick: () => saveConcurrency(concurrency + 1),
              }, '+')))),

        selectedTasks.length > 0 && h('div', { className: 'edu-queue-bulk' },
          h('span', { className: 'edu-strong edu-sm edu-tabular' }, '已选择 ', selectedTasks.length, ' 项任务'),
          h('div', { className: 'edu-row-gap-6 edu-wrap-row' },
            bulkSpecs.map(([cmd, text, primary]) => {
              const ids = selectedTasks.filter(task => commands[cmd].states.includes(task.status)).map(task => task.id);
              return h(Button, {
                key: cmd, size: 'sm', primary, disabled: busy || ids.length === 0,
                onClick: () => runCommand(ids, cmd),
              }, text);
            }),
            cancellableIds.length > 0 && (!confirmBulkCancel
              ? h(Button, { size: 'sm', danger: true, ghost: true, disabled: busy, onClick: () => setConfirmBulkCancel(true) }, '批量取消')
              : h('div', { className: 'edu-row-gap-4' },
                h(Button, {
                  size: 'sm', danger: true, disabled: busy,
                  onClick: () => { setConfirmBulkCancel(false); runCommand(cancellableIds, 'cancel'); },
                }, '确认取消 (', cancellableIds.length, ')'),
                h(Button, { size: 'sm', disabled: busy, onClick: () => setConfirmBulkCancel(false) }, '保留'))),
            h(Button, { size: 'sm', ghost: true, onClick: () => setCheckedIds([]) }, '取消选择'))),

        h('div', { className: 'edu-stage-scroll edu-scroll-queue' },
          h('div', { className: 'edu-q-table-card' },
            visible.length === 0
              ? h('div', { className: 'edu-empty-inline' },
                tasks.length === 0 ? '队列为空 · 可在「课程与作业」页直接运行或勾选加入任务' : '没有符合筛选条件的任务')
              : h('div', { className: 'edu-table-wrap' },
                h('table', { className: 'edu-q-table' },
                  h('thead', null, h('tr', null,
                    h('th', { className: 'edu-col-check' }, h('input', {
                      ref: selectAllRef, type: 'checkbox', checked: allVisibleChecked,
                      'aria-label': allVisibleChecked ? '取消全选当前列表' : '全选当前列表',
                      onChange: () => setCheckedIds(prev => allVisibleChecked
                        ? prev.filter(id => !visibleIdSet.has(id))
                        : [...new Set([...prev, ...visible.map(task => task.id)])]),
                    })),
                    h('th', null, '作业与课程'),
                    h('th', { style: { width: '132px' } }, '账号'),
                    h('th', { style: { width: '260px' } }, '状态与说明'),
                    h('th', { className: 'edu-col-time', style: { width: '96px' } }, '更新时间'),
                    h('th', { className: 'edu-text-right', style: { width: '188px' } }, '操作'))),
                  h('tbody', null, visible.map(task => {
                    const account = accountsById.get(task.accountId);
                    const primaryCmd = ['start', 'pause', 'resume'].find(cmd => commands[cmd].states.includes(task.status));
                    const checked = checkedTaskSet.has(task.id);
                    return h('tr', {
                      key: task.id,
                      className: drawerTaskId === task.id ? 'active-row' : undefined,
                      onClick: event => {
                        if (event.target.closest?.('button, input, a')) return;
                        inspectTask(task.id);
                      },
                    },
                    h('td', { className: 'edu-col-check' }, h('input', {
                      type: 'checkbox', checked,
                      'aria-label': '选择 ' + (task.homeworkTitle || task.homeworkId),
                      onChange: () => setCheckedIds(prev => prev.includes(task.id)
                        ? prev.filter(item => item !== task.id) : [...prev, task.id]),
                    })),
                    h('td', null,
                      h('div', { className: 'edu-strong edu-wrap' }, task.homeworkTitle || '作业 ' + task.homeworkId),
                      h('div', { className: 'edu-muted edu-xs edu-wrap edu-mt-2' }, task.courseTitle || '课程 ' + task.courseId)),
                    h('td', null,
                      h('span', { className: 'edu-account-chip' },
                        h('span', { className: 'edu-dot edu-dot-' + (account?.status || 'ready'), 'aria-hidden': true }),
                        h('span', null, account?.label || task.accountId))),
                    h('td', null,
                      h(StatusPill, { status: task.status }),
                      task.code && h('div', { className: 'edu-muted edu-xs edu-wrap edu-mt-3' }, taskMessage(task.code))),
                    h('td', { className: 'edu-col-time edu-muted edu-xs edu-tabular', title: formatDate(task.updatedAt) },
                      formatRelativeTime(task.updatedAt) || '—'),
                    h('td', null,
                      h('div', { className: 'edu-row-actions' },
                        primaryCmd && h(Button, {
                          size: 'sm', primary: commands[primaryCmd].primary, disabled: busy,
                          onClick: () => runCommand([task.id], primaryCmd),
                        }, commands[primaryCmd].label),
                        task.sessionId && h(Button, {
                          size: 'sm', disabled: busy, onClick: () => openSession(task.sessionId),
                        }, '会话', h(SvgIcon, { paths: icons.external, size: 11 })),
                        h(Button, {
                          size: 'sm', ghost: true, onClick: () => inspectTask(task.id),
                        }, '记录'))));
                  })))))));
    }

    function TaskDrawer({ task, liveTask, accountsById, busy, onClose, onRefresh, onCommand, onOpenSession }) {
      const [confirmCancel, setConfirmCancel] = useState(false);
      const status = liveTask?.status || task.status;
      const code = liveTask?.code !== undefined ? liveTask.code : task.code;
      const attempts = liveTask?.attempts ?? task.attempts ?? 0;
      const verifiedAt = liveTask?.verifiedAt ?? task.verifiedAt;
      const updatedAt = liveTask?.updatedAt ?? task.updatedAt;
      const sessionId = liveTask?.sessionId || task.sessionId;
      const events = task.events?.length ? [...task.events].reverse() : [];
      const account = accountsById.get(task.accountId);
      const primaryCmd = ['start', 'pause', 'resume'].find(cmd => commands[cmd].states.includes(status));
      const canCancel = commands.cancel.states.includes(status);

      useEffect(() => {
        setConfirmCancel(false);
      }, [task.id, status]);

      return h('div', {
        className: 'edu-drawer-backdrop',
        onMouseDown(event) {
          if (event.target === event.currentTarget) onClose();
        },
      },
      h('section', { className: 'edu-drawer', 'aria-labelledby': 'edu-log-heading' },
        h('div', { className: 'edu-drawer-head' },
          h('div', { className: 'edu-row-gap-8' },
            h('h3', { id: 'edu-log-heading' }, '任务记录'),
            h(StatusPill, { status })),
          h('div', { className: 'edu-row-gap-4' },
            h(Button, { size: 'sm', ghost: true, disabled: busy, onClick: () => onRefresh(task.id) },
              h(SvgIcon, { paths: icons.refresh, size: 13 }), '刷新记录'),
            h(Button, { size: 'sm', iconOnly: true, ghost: true, onClick: onClose, 'aria-label': '关闭记录' },
              h(SvgIcon, { paths: icons.close, size: 15 })))),

        h('div', { className: 'edu-drawer-body' },
          h('div', { className: 'edu-drawer-summary' },
            h('div', { className: 'edu-strong' }, task.homeworkTitle || '作业 ' + task.homeworkId),
            h('div', { className: 'edu-xs edu-muted' }, task.courseTitle || '课程 ' + task.courseId),
            h('div', { className: 'edu-drawer-meta edu-xs' },
              h('span', { className: 'edu-account-chip' },
                h('span', { className: 'edu-dot edu-dot-' + (account?.status || 'ready'), 'aria-hidden': true }),
                account?.label || task.accountId),
              h('span', { className: 'edu-tabular' }, '尝试 ', attempts, ' 次'),
              updatedAt && h('span', { className: 'edu-tabular', title: formatDate(updatedAt) }, formatRelativeTime(updatedAt))),
            verifiedAt && h('div', { className: 'edu-xs edu-muted edu-tabular' }, '核验于 ', formatDate(verifiedAt))),

          code && h('div', {
            className: [
              'edu-drawer-callout',
              status === 'passed' && 'ok',
              (status === 'running' || status === 'queued') && 'info',
              (status === 'manual' || status === 'paused') && 'warn',
              status === 'cancelled' && 'neutral',
            ].filter(Boolean).join(' '),
          }, h('strong', null, status === 'passed' ? '核验结果：' : '状态说明：'), taskMessage(code)),

          (primaryCmd || sessionId || canCancel) && h('div', { className: 'edu-row-gap-8 edu-wrap-row' },
            primaryCmd && h(Button, {
              size: 'sm', primary: commands[primaryCmd].primary, disabled: busy,
              onClick: () => onCommand([task.id], primaryCmd),
            }, commands[primaryCmd].drawerLabel),
            sessionId && h(Button, {
              size: 'sm', disabled: busy, onClick: () => onOpenSession(sessionId),
            }, '进入 Agent 会话', h(SvgIcon, { paths: icons.external, size: 12 })),
            canCancel && (!confirmCancel
              ? h(Button, { size: 'sm', danger: true, ghost: true, disabled: busy, onClick: () => setConfirmCancel(true) }, '取消任务')
              : h('div', { className: 'edu-row-gap-4' },
                h(Button, {
                  size: 'sm', danger: true, disabled: busy,
                  onClick: () => { setConfirmCancel(false); onCommand([task.id], 'cancel'); },
                }, '确认取消'),
                h(Button, { size: 'sm', disabled: busy, onClick: () => setConfirmCancel(false) }, '保留')))),

          h('div', null,
            h('div', { className: 'edu-timeline-heading' }, '状态时间线'),
            events.length === 0
              ? h('p', { className: 'edu-muted edu-xs' }, '暂无状态记录。')
              : h('ol', { className: 'edu-timeline' },
                events.map((event, index) => h('li', { key: index, className: 'edu-timeline-item' },
                  h('div', { className: 'edu-timeline-rail', 'aria-hidden': true },
                    h('span', { className: 'edu-dot edu-dot-' + event.status }),
                    h('span', { className: 'edu-timeline-line' })),
                  h('div', { className: 'edu-timeline-card' },
                    h('div', { className: 'edu-timeline-head' },
                      h('div', { className: 'edu-row-gap-6' },
                        h(StatusPill, { status: event.status }),
                        event.attempt ? h('span', { className: 'edu-muted edu-xs edu-tabular' }, '第 ', event.attempt, ' 次') : null),
                      h('time', { className: 'edu-xs edu-faint edu-tabular', dateTime: event.at, title: formatDate(event.at) },
                        formatClock(event.at) || formatDate(event.at))),
                    event.code && h('div', { className: 'edu-xs edu-muted edu-mt-6' }, taskMessage(event.code)),
                    event.sessionId && h('div', { className: 'edu-mt-6' },
                      h(Button, { size: 'sm', disabled: busy, onClick: () => onOpenSession(event.sessionId) },
                        '会话', h(SvgIcon, { paths: icons.external, size: 11 })))))))))));
    }

    function Page({ navigateSession }) {
      const [accounts, setAccounts] = useState([]);
      const [tasks, setTasks] = useState([]);
      const [accountId, setAccountId] = useState('');
      const [activeTab, setActiveTab] = useState('catalog');
      const [version, setVersion] = useState(0);
      const [checkedMap, setCheckedMap] = useState(() => new Map());
      const [concurrency, setConcurrency] = useState(null);
      const [mode, setMode] = useState(null);
      const [tasksEnabled, setTasksEnabled] = useState(false);
      const [busy, setBusy] = useState(false);
      const [activeKey, setActiveKey] = useState('');
      const [error, setError] = useState('');
      const [modalError, setModalError] = useState('');
      const [toast, setToast] = useState('');
      const [stale, setStale] = useState(false);
      const [lastSyncedAt, setLastSyncedAt] = useState(null);
      const [log, setLog] = useState(null);
      const [loaded, setLoaded] = useState(false);
      const [statusFilter, setStatusFilter] = useState('');
      const [modal, setModal] = useState(null);

      const operation = useRef(null);
      const detailRequest = useRef(null);
      const revision = useRef(0);
      const account = accounts.find(item => item.id === accountId) || accounts[0] || null;
      const accountsById = useMemo(() => new Map(accounts.map(item => [item.id, item])), [accounts]);
      const showQueueTab = tasksEnabled || tasks.length > 0;
      const effectiveTab = showQueueTab ? activeTab : 'catalog';
      const liveLogTask = log ? tasks.find(task => task.id === log.id) : null;

      useEffect(() => {
        if (!toast) return;
        const timer = setTimeout(() => setToast(''), 3500);
        return () => clearTimeout(timer);
      }, [toast]);

      useEffect(() => {
        if (log && liveLogTask && liveLogTask.updatedAt !== log.updatedAt) {
          void inspectTask(log.id);
        }
      }, [log?.id, liveLogTask?.updatedAt]);

      useEffect(() => {
        const onKeyDown = event => {
          if (event.key !== 'Escape') return;
          if (modal && !busy) { setModal(null); setModalError(''); }
          else if (log) setLog(null);
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
      }, [modal, log, busy]);

      async function readAll(signal) {
        const token = ++revision.current;
        const [accountList, taskList, settings] = await Promise.all([
          request('accounts', {}, signal), request('tasks', {}, signal), request('settings', {}, signal),
        ]);
        if (signal.aborted || token !== revision.current) return;
        setAccounts(accountList);
        setTasks(taskList);
        setConcurrency(settings.concurrency);
        setMode(settings.mode);
        setTasksEnabled(settings.tasksEnabled !== false);
        setStale(false);
        setLastSyncedAt(new Date().toISOString());
        setLoaded(true);
      }

      useEffect(() => {
        const controller = new AbortController();
        let reading = false;
        let loadedAll = false;
        async function poll(initial) {
          if (controller.signal.aborted || reading || operation.current) return;
          if (!initial && document.visibilityState === 'hidden') return;
          reading = true;
          const token = revision.current;
          try {
            if (!loadedAll) {
              await readAll(controller.signal);
              loadedAll = true;
            } else {
              const values = await request('tasks', {}, controller.signal);
              if (!controller.signal.aborted && token === revision.current) {
                setTasks(values);
                setStale(false);
                setLastSyncedAt(new Date().toISOString());
              }
            }
          } catch {
            if (!controller.signal.aborted && (initial || token === revision.current)) setStale(true);
          } finally {
            reading = false;
          }
        }
        void poll(true);
        const timer = setInterval(() => void poll(false), 4000);
        return () => {
          controller.abort();
          operation.current?.abort();
          detailRequest.current?.abort();
          clearInterval(timer);
        };
      }, []);

      async function perform(key, callback, { suppressGlobalError = false } = {}) {
        if (operation.current) return false;
        const controller = new AbortController();
        operation.current = controller;
        ++revision.current;
        setBusy(true);
        setActiveKey(key);
        if (!suppressGlobalError) setError('');
        try {
          await callback(controller.signal);
          return true;
        } catch (failure) {
          if (!controller.signal.aborted && !suppressGlobalError) setError(errorMessage(failure));
          return false;
        } finally {
          if (operation.current === controller) {
            operation.current = null;
            if (!controller.signal.aborted) {
              setBusy(false);
              setActiveKey('');
            }
          }
        }
      }

      async function inspectTask(taskId) {
        detailRequest.current?.abort();
        const controller = new AbortController();
        detailRequest.current = controller;
        setError('');
        try {
          const detail = await request('task', { taskId }, controller.signal);
          if (!controller.signal.aborted) setLog(detail);
        } catch (failure) {
          if (!controller.signal.aborted) setError(errorMessage(failure));
        } finally {
          if (detailRequest.current === controller) detailRequest.current = null;
        }
      }

      function updateAccount(updated) {
        setAccounts(prev => prev.some(item => item.id === updated.id)
          ? prev.map(item => item.id === updated.id ? updated : item) : [...prev, updated]);
        setVersion(v => v + 1);
      }

      function mergeTasks(updated) {
        setTasks(prev => [...updated, ...prev.filter(task => !updated.some(item => item.id === task.id))]);
      }

      async function allocateTargets(targets, start, clearChecked) {
        return perform('allocate', async signal => {
          const created = await request('allocate', { targets, start }, signal);
          mergeTasks(created);
          if (clearChecked) setCheckedMap(new Map());
          setToast(start ? `已分配并启动 ${created.length} 项任务` : `已加入待启动队列（${created.length} 项）`);
        });
      }

      async function startCourse(targetAccountId, courseId) {
        return perform(`startCourse:${targetAccountId}:${courseId}`, async signal => {
          const { tasks: startedTasks, started, skippedCompleted, skippedExisting } = await request(
            'startCourse', { accountId: targetAccountId, courseId }, signal,
          );
          mergeTasks(startedTasks);
          const messages = [started ? `已启动 ${started} 项作业` : '该课程暂无可启动的作业'];
          if (skippedCompleted) messages.push(`已通关 ${skippedCompleted} 项`);
          if (skippedExisting) messages.push(`已有任务 ${skippedExisting} 项`);
          setToast(messages.join(' · '));
        });
      }

      async function handleAccountSubmit(targetAccountId, login, password) {
        setModalError('');
        await perform(targetAccountId ? 'relogin:' + targetAccountId : 'addAccount', async signal => {
          try {
            const updated = await request(targetAccountId ? 'relogin' : 'addAccount', {
              ...(targetAccountId ? { accountId: targetAccountId } : {}), login, password,
            }, signal);
            updateAccount(updated);
            setAccountId(updated.id);
            setModal(null);
            setToast(targetAccountId ? '已刷新账号登录会话' : '账号已绑定并验证');
          } catch (failure) {
            if (!signal.aborted) setModalError(errorMessage(failure));
            throw failure;
          }
        }, { suppressGlobalError: true });
      }

      function toggleHomework(key, entry) {
        setCheckedMap(prev => {
          const next = new Map(prev);
          if (next.has(key)) next.delete(key);
          else next.set(key, entry);
          return next;
        });
      }

      function toggleAllVisible(targetAccount, courseObj, homeworks) {
        if (!targetAccount || !courseObj || homeworks.length === 0) return;
        setCheckedMap(prev => {
          const next = new Map(prev);
          const allIn = homeworks.every(hw => next.has(`${targetAccount.id}:${courseObj.id}:${hw.id}`));
          for (const hw of homeworks) {
            const key = `${targetAccount.id}:${courseObj.id}:${hw.id}`;
            if (allIn) next.delete(key);
            else next.set(key, {
              key, accountId: targetAccount.id, accountLabel: targetAccount.label || targetAccount.id,
              courseId: courseObj.id, courseTitle: courseObj.title, homeworkId: hw.id, homeworkTitle: hw.title,
            });
          }
          return next;
        });
      }

      function removeCheckedKey(key) {
        setCheckedMap(prev => {
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
      }

      const activeTaskCount = tasks.filter(task => activeStatuses.has(task.status)).length;
      const issueTaskCount = tasks.filter(task => issueStatuses.has(task.status)).length;
      const modeBadge = mode === 'fixture'
        ? { text: '模拟环境', tone: 'slate' }
        : mode === 'live'
          ? { text: tasksEnabled ? '真实账号 · 自动评测' : '真实账号 · 只读浏览', tone: tasksEnabled ? 'blue' : 'amber' }
          : null;

      return h('main', { className: 'edu-panel', 'aria-labelledby': 'edu-heading', 'aria-busy': !loaded },
        h('header', { className: 'edu-topbar' },
          h('div', { className: 'edu-topbar-left' },
            h('div', { className: 'edu-brand' },
              h('span', { className: 'edu-brand-icon', 'aria-hidden': true }, h(SvgIcon, { paths: icons.brand, size: 16 })),
              h('h1', { id: 'edu-heading' }, 'EduCoder')),
            modeBadge && h('span', { className: 'edu-env-badge', 'data-tone': modeBadge.tone }, modeBadge.text)),

          loaded && showQueueTab && h('nav', { className: 'edu-main-tabs', 'aria-label': '主工作区切换' },
            h('button', {
              type: 'button',
              className: ['edu-main-tab', effectiveTab === 'catalog' && 'active'].filter(Boolean).join(' '),
              'aria-current': effectiveTab === 'catalog' ? 'page' : undefined,
              onClick: () => setActiveTab('catalog'),
            }, h(SvgIcon, { paths: icons.book, size: 14 }), h('span', null, '课程与作业')),
            h('button', {
              type: 'button',
              className: ['edu-main-tab', effectiveTab === 'queue' && 'active'].filter(Boolean).join(' '),
              'aria-current': effectiveTab === 'queue' ? 'page' : undefined,
              onClick: () => setActiveTab('queue'),
            },
            h(SvgIcon, { paths: icons.queue, size: 14 }),
            h('span', null, '任务队列'),
            activeTaskCount > 0 && h('span', { className: 'edu-tab-pill' },
              h('span', { className: 'edu-dot edu-dot-running', 'aria-hidden': true }), activeTaskCount),
            issueTaskCount > 0 && h('span', { className: 'edu-tab-pill warn' }, '异常 ', issueTaskCount))),

          h('div', { className: 'edu-topbar-right' },
            lastSyncedAt && h('span', { className: 'edu-sync-status edu-xs', 'data-stale': stale ? 'true' : 'false' },
              h('span', { className: 'edu-sync-dot', 'aria-hidden': true }),
              stale ? '连接已断开' : '已同步 ' + formatClock(lastSyncedAt)),
            h(Button, {
              size: 'sm', disabled: busy,
              onClick: () => perform('refresh', async signal => {
                await readAll(signal);
                setVersion(v => v + 1);
                setToast('已同步最新账号、课程与任务状态');
              }),
            }, h(SvgIcon, { paths: icons.refresh, size: 13, spin: busy && activeKey === 'refresh' }), '刷新'))),

        (error || stale) && h('div', { className: 'edu-banner-strip' },
          error && h('div', { role: 'alert', className: 'edu-inline-alert' },
            h('span', null, error),
            h(Button, { size: 'sm', iconOnly: true, ghost: true, onClick: () => setError(''), 'aria-label': '关闭错误提示' },
              h(SvgIcon, { paths: icons.close, size: 13 }))),
          stale && h('div', { role: 'status', className: 'edu-inline-warn' },
            h('span', null, '实时同步暂未更新，可点击右上角「刷新」恢复连接。'))),

        h('div', { className: 'edu-app-body' },
          !loaded
            ? h('div', { className: 'edu-center-wrap' },
              h('div', { role: 'status', className: 'edu-empty-card' },
                h(SvgIcon, { paths: icons.refresh, size: 18, spin: true }),
                h('span', { className: 'edu-muted' }, '正在加载 EduCoder 工作台…')))
            : effectiveTab === 'queue'
              ? h(QueueStage, {
                tasks, accounts, busy, activeKey, concurrency,
                statusFilter, setStatusFilter, drawerTaskId: log?.id,
                saveConcurrency: value => perform('settings', async signal => {
                  const settings = await request('settings', { concurrency: value }, signal);
                  setConcurrency(settings.concurrency);
                  setToast(`全局并发上限已设为 ${settings.concurrency}`);
                }),
                runCommand: (taskIds, command) => perform('control', async signal => {
                  const updated = await request('control', { taskIds, command }, signal);
                  mergeTasks(updated);
                  setToast(`已执行操作（${updated.length} 项任务）`);
                }),
                inspectTask,
                openSession: sessionId => perform('session', () => navigateSession(sessionId)),
              })
              : accounts.length === 0
                ? h('div', { className: 'edu-center-wrap' },
                  h('div', { className: 'edu-empty-card' },
                    h('span', { className: 'edu-empty-icon', 'aria-hidden': true }, h(SvgIcon, { paths: icons.brand, size: 22 })),
                    h('strong', { className: 'edu-empty-title' }, '尚未绑定任何 EduCoder 账号'),
                    h('p', { className: 'edu-muted edu-sm' }, '绑定头歌账号后，系统将按账号安全隔离会话，自动拉取课程、关卡进度与实训作业。'),
                    h(Button, {
                      primary: true, disabled: busy,
                      onClick: () => { setModalError(''); setModal({ kind: 'add' }); },
                    }, h(SvgIcon, { paths: icons.plus, size: 14 }), '绑定第一个账号')))
                : h(React.Fragment, null,
                  h(AccountRail, {
                    accounts, selectedId: account?.id, tasks, showTaskMetrics: showQueueTab,
                    busy, activeKey, chooseAccount: setAccountId,
                    openAddModal: () => { setModalError(''); setModal({ kind: 'add' }); },
                    openReloginModal: acc => { setModalError(''); setModal({ kind: 'relogin', account: acc }); },
                    checkAccount: id => perform('check:' + id, async signal => {
                      try {
                        const updated = await request('checkAccount', { accountId: id }, signal);
                        updateAccount(updated);
                        setToast('登录状态已核验');
                      } catch (failure) {
                        await readAll(signal).catch(() => {});
                        throw failure;
                      }
                    }),
                    removeAccount: id => perform('remove:' + id, async signal => {
                      await request('removeAccount', { accountId: id }, signal);
                      setAccounts(prev => prev.filter(item => item.id !== id));
                      setCheckedMap(prev => {
                        const next = new Map();
                        for (const [k, v] of prev) if (v.accountId !== id) next.set(k, v);
                        return next;
                      });
                      if (log?.accountId === id) setLog(null);
                      await readAll(signal);
                      setToast('账号已解绑并清除凭据');
                    }),
                  }),
                  h(CatalogStage, {
                    key: account?.id || 'no-account',
                    account, version, refreshCatalog: () => setVersion(v => v + 1),
                    tasks, tasksEnabled, busy, activeKey, checkedMap,
                    onToggleHomework: toggleHomework,
                    onToggleAllVisible: toggleAllVisible,
                    onRemoveCheckedKey: removeCheckedKey,
                    onClearChecked: () => setCheckedMap(new Map()),
                    onAllocateChecked: startNow => allocateTargets(
                      Array.from(checkedMap.values()).map(({ accountId: a, courseId: c, homeworkId: hId }) => ({
                        accountId: a, courseId: c, homeworkId: hId,
                      })),
                      startNow,
                      true,
                    ),
                    onStartCourse: startCourse,
                    onRunSingle: target => allocateTargets([target], true, false),
                    onInspectTask: inspectTask,
                  })),

          log && h(TaskDrawer, {
            task: log, liveTask: liveLogTask, accountsById, busy,
            onClose: () => setLog(null),
            onRefresh: inspectTask,
            onCommand: (taskIds, command) => perform('control', async signal => {
              const updated = await request('control', { taskIds, command }, signal);
              mergeTasks(updated);
              await inspectTask(taskIds[0]).catch(() => {});
              setToast(`已执行操作（${updated.length} 项任务）`);
            }),
            onOpenSession: sessionId => perform('session', () => navigateSession(sessionId)),
          })),

        modal && h(AccountModal, {
          modal, busy, activeKey, modalError,
          onSubmit: handleAccountSubmit,
          onClose: () => { if (!busy) setModal(null); },
        }),

        toast && h('div', { role: 'status', 'aria-live': 'polite', className: 'edu-toast' },
          h(SvgIcon, { paths: icons.check, size: 14 }),
          h('span', null, toast),
          h(Button, { size: 'sm', iconOnly: true, ghost: true, className: 'edu-toast-close', onClick: () => setToast(''), 'aria-label': '关闭提示' },
            h(SvgIcon, { paths: icons.close, size: 13 }))));
    }

    const css = `
      .edu-panel{
        --edu-surface:var(--dsw-alias-bg-base,#ffffff);
        --edu-canvas:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#f8f9fb) 75%,var(--dsw-alias-interactive-bg-hover-solid,#f3f4f6));
        --edu-subtle:color-mix(in srgb,var(--dsw-alias-interactive-bg-hover-solid,#f3f4f6) 65%,var(--edu-surface));
        --edu-hover:var(--dsw-alias-interactive-bg-hover,#f1f3f5);
        --edu-border:var(--dsw-alias-border-l2,#e5e7eb);
        --edu-border-strong:var(--dsw-alias-border-l3,#d1d5db);
        --edu-text:var(--dsw-alias-label-primary,#111827);
        --edu-muted:color-mix(in srgb,var(--edu-text) 64%,var(--edu-surface));
        --edu-faint:var(--dsw-alias-label-tertiary,#9ca3af);
        --edu-accent:var(--dsw-alias-state-business-primary,var(--dsw-alias-link,#2563eb));
        --edu-accent-hover:color-mix(in srgb,var(--edu-accent) 88%,#000);
        --edu-accent-text:var(--dsw-alias-link,var(--edu-accent));
        --edu-accent-soft:color-mix(in srgb,var(--edu-accent) 11%,var(--edu-surface));
        --edu-green:var(--dsw-alias-state-success-primary,#16a34a);
        --edu-green-soft:color-mix(in srgb,var(--edu-green) 13%,var(--edu-surface));
        --edu-amber:var(--dsw-alias-state-warn-primary,#d97706);
        --edu-amber-soft:color-mix(in srgb,var(--edu-amber) 14%,var(--edu-surface));
        --edu-red:var(--dsw-alias-state-error-primary,#dc2626);
        --edu-red-soft:color-mix(in srgb,var(--edu-red) 12%,var(--edu-surface));
        --edu-shadow-md:0 8px 24px rgba(15,23,42,.10),0 1px 3px rgba(15,23,42,.06);
        --edu-shadow-lg:0 18px 48px rgba(15,23,42,.18),0 4px 12px rgba(15,23,42,.08);
        container-type:inline-size;container-name:edu-panel;
        position:relative;height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;
        background:var(--edu-canvas);color:var(--edu-text);font-size:13.5px;line-height:1.45;
        scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2,var(--edu-border-strong)) transparent;
      }
      .edu-panel *{box-sizing:border-box}
      .edu-panel :where(h1,h2,h3,p,ul,ol){margin:0}
      .edu-panel :where(button,input,select,[tabindex]):focus-visible{outline:2px solid var(--edu-accent);outline-offset:2px}
      .edu-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
      .edu-tabular{font-variant-numeric:tabular-nums}
      .edu-truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .edu-wrap{overflow-wrap:break-word;word-break:normal}
      .edu-min0{min-width:0}
      .edu-flex1{flex:1 1 auto}
      .edu-strong{font-weight:600}
      .edu-muted{color:var(--edu-muted)}
      .edu-faint{color:var(--edu-faint)}
      .edu-xs{font-size:12px;line-height:1.4}
      .edu-sm{font-size:13px}
      .edu-mt-2{margin-top:2px}
      .edu-mt-3{margin-top:3px}
      .edu-mt-6{margin-top:6px}
      .edu-text-right{text-align:right}
      .edu-tone-red{color:var(--edu-red)}
      .edu-row-gap-4{display:flex;align-items:center;gap:4px}
      .edu-row-gap-6{display:flex;align-items:center;gap:6px}
      .edu-row-gap-8{display:flex;align-items:center;gap:8px}
      .edu-wrap-row{flex-wrap:wrap}
      .edu-icon{flex:none;display:inline-block;vertical-align:middle}
      @keyframes edu-rotate{to{transform:rotate(360deg)}}
      .edu-spin{animation:edu-rotate .85s linear infinite}
      @keyframes edu-pulse-dot{0%,100%{opacity:1}50%{opacity:.42}}

      /* Topbar */
      .edu-topbar{
        flex:0 0 auto;min-height:54px;background:var(--edu-surface);border-bottom:1px solid var(--edu-border);
        padding:8px 18px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;
      }
      .edu-topbar-left,.edu-topbar-right{display:flex;align-items:center;gap:10px;min-width:0}
      .edu-brand{display:flex;align-items:center;gap:8px}
      .edu-brand h1{font-size:15px;font-weight:650;letter-spacing:-.01em}
      .edu-brand-icon{
        width:28px;height:28px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;
        background:var(--edu-accent-soft);color:var(--edu-accent-text);
      }
      .edu-env-badge{
        font-size:11.5px;font-weight:550;padding:2px 8px;border-radius:999px;white-space:nowrap;
        background:var(--edu-subtle);color:var(--edu-muted);border:1px solid var(--edu-border);
      }
      .edu-env-badge[data-tone=blue]{background:var(--edu-accent-soft);color:var(--edu-accent-text);border-color:transparent}
      .edu-env-badge[data-tone=amber]{background:var(--edu-amber-soft);color:var(--edu-amber);border-color:transparent}
      .edu-sync-status{display:inline-flex;align-items:center;gap:6px;color:var(--edu-faint);white-space:nowrap}
      .edu-sync-dot{width:7px;height:7px;border-radius:999px;background:var(--edu-green)}
      .edu-sync-status[data-stale=true] .edu-sync-dot{background:var(--edu-amber)}

      /* Segmented Main Tabs */
      .edu-main-tabs{
        display:inline-flex;align-items:center;gap:2px;padding:3px;border-radius:9px;
        background:var(--edu-subtle);border:1px solid var(--edu-border);
      }
      .edu-main-tab{
        display:inline-flex;align-items:center;gap:6px;padding:5px 13px;border:none;border-radius:6px;
        background:transparent;color:var(--edu-muted);font:inherit;font-size:13px;font-weight:550;cursor:pointer;
        transition:background-color .14s ease,color .14s ease;white-space:nowrap;
      }
      .edu-main-tab:hover{color:var(--edu-text)}
      .edu-main-tab.active{background:var(--edu-surface);color:var(--edu-text);box-shadow:0 1px 2px rgba(15,23,42,.06)}
      .edu-tab-pill{
        display:inline-flex;align-items:center;gap:4px;padding:1px 6px;border-radius:999px;
        font-size:11px;font-weight:600;background:var(--edu-accent-soft);color:var(--edu-accent-text);
      }
      .edu-tab-pill.warn{background:var(--edu-red-soft);color:var(--edu-red)}

      /* Buttons */
      .edu-btn{
        display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;
        border-radius:8px;border:1px solid var(--edu-border);background:var(--edu-surface);color:var(--edu-text);
        font:inherit;font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap;
        transition:background-color .12s ease,border-color .12s ease;
      }
      .edu-btn:hover:not(:disabled){background:var(--edu-hover);border-color:var(--edu-border-strong)}
      .edu-btn:disabled{opacity:.48;cursor:not-allowed}
      .edu-btn-sm{height:27px;padding:0 9px;font-size:12px;border-radius:6px}
      .edu-btn-icon{width:32px;padding:0}
      .edu-btn-icon.edu-btn-sm{width:27px;height:27px}
      .edu-btn-full{width:100%}
      .edu-btn-primary{background:var(--edu-accent);border-color:var(--edu-accent);color:#fff}
      .edu-btn-primary:hover:not(:disabled){background:var(--edu-accent-hover);border-color:var(--edu-accent-hover)}
      .edu-btn-ghost{background:transparent;border-color:transparent;color:var(--edu-muted)}
      .edu-btn-ghost:hover:not(:disabled){background:var(--edu-hover);border-color:transparent;color:var(--edu-text)}
      .edu-btn-danger{color:var(--edu-red);border-color:color-mix(in srgb,var(--edu-red) 35%,var(--edu-border))}
      .edu-btn-danger:not(.edu-btn-ghost):hover:not(:disabled){background:var(--edu-red-soft)}
      .edu-btn-danger.edu-btn-ghost{border-color:transparent}
      .edu-btn-danger.edu-btn-ghost:hover:not(:disabled){background:var(--edu-red-soft)}

      /* Status Dots & Pills */
      .edu-dot{width:7px;height:7px;border-radius:999px;display:inline-block;flex:none}
      .edu-dot-ready,.edu-dot-passed{background:var(--edu-green)}
      .edu-dot-unverified,.edu-dot-paused{background:var(--edu-amber)}
      .edu-dot-auth_required,.edu-dot-manual,.edu-dot-failed{background:var(--edu-red)}
      .edu-dot-running,.edu-dot-queued{background:var(--edu-accent);box-shadow:0 0 0 3px var(--edu-accent-soft);animation:edu-pulse-dot 1.8s infinite}
      .edu-dot-waiting,.edu-dot-cancelled{background:var(--edu-faint)}

      .edu-pill{
        display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;
        font-size:11.5px;font-weight:550;white-space:nowrap;border:none;
        background:var(--edu-subtle);color:var(--edu-muted);
      }
      .edu-pill[data-tone=green]{background:var(--edu-green-soft);color:var(--edu-green)}
      .edu-pill[data-tone=blue]{background:var(--edu-accent-soft);color:var(--edu-accent-text)}
      .edu-pill[data-tone=amber]{background:var(--edu-amber-soft);color:var(--edu-amber)}
      .edu-pill[data-tone=red]{background:var(--edu-red-soft);color:var(--edu-red)}
      .edu-pill-interactive{cursor:pointer;transition:filter .12s ease}
      .edu-pill-interactive:hover{filter:brightness(.95)}

      /* Alerts Banner Strip */
      .edu-banner-strip{flex:0 0 auto;padding:8px 18px;display:grid;gap:6px;background:var(--edu-canvas);border-bottom:1px solid var(--edu-border)}
      .edu-inline-alert,.edu-inline-warn{
        display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 11px;border-radius:8px;font-size:12.5px;
      }
      .edu-inline-alert{background:var(--edu-red-soft);color:var(--edu-red);border:1px solid color-mix(in srgb,var(--edu-red) 28%,transparent)}
      .edu-inline-warn{background:var(--edu-amber-soft);color:var(--edu-amber);border:1px solid color-mix(in srgb,var(--edu-amber) 28%,transparent)}

      /* Main Body */
      .edu-app-body{flex:1 1 auto;min-height:0;display:flex;position:relative;overflow:hidden}

      /* Left Account Rail */
      .edu-rail{
        width:244px;flex:0 0 244px;background:var(--edu-surface);border-right:1px solid var(--edu-border);
        display:flex;flex-direction:column;min-height:0;
      }
      .edu-rail-head{
        padding:12px 14px 10px;border-bottom:1px solid var(--edu-border);
        display:flex;align-items:center;justify-content:space-between;gap:8px;
      }
      .edu-rail-title{font-size:12px;font-weight:600;color:var(--edu-muted)}
      .edu-rail-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:4px}
      .edu-acc-item{
        border-radius:9px;padding:8px 9px;border:1px solid transparent;transition:background-color .12s ease,border-color .12s ease;
      }
      .edu-acc-item:hover{background:var(--edu-hover)}
      .edu-acc-item.selected{background:var(--edu-accent-soft);border-color:color-mix(in srgb,var(--edu-accent) 28%,transparent)}
      .edu-acc-top{display:flex;align-items:center;justify-content:space-between;gap:6px}
      .edu-acc-trigger{
        display:flex;align-items:center;gap:9px;min-width:0;flex:1;padding:0;border:none;background:transparent;
        color:inherit;font:inherit;text-align:left;cursor:pointer;
      }
      .edu-avatar{
        position:relative;width:30px;height:30px;flex:none;border-radius:8px;
        display:inline-flex;align-items:center;justify-content:center;font-weight:650;font-size:12px;
        background:var(--edu-subtle);color:var(--edu-text);border:1px solid var(--edu-border);
      }
      .edu-acc-item.selected .edu-avatar{background:var(--edu-accent);color:#fff;border-color:var(--edu-accent)}
      .edu-avatar-dot{position:absolute;right:-2px;bottom:-2px;width:8px;height:8px;border:2px solid var(--edu-surface)}
      .edu-acc-meta{display:flex;flex-direction:column;min-width:0;flex:1}
      .edu-acc-name{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .edu-acc-sub{font-size:11.5px;color:var(--edu-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
      .edu-acc-status[data-tone=green]{color:var(--edu-green);font-weight:500}
      .edu-acc-status[data-tone=amber]{color:var(--edu-amber);font-weight:500}
      .edu-acc-status[data-tone=red]{color:var(--edu-red);font-weight:500}

      .edu-acc-menu-wrap{position:relative;flex:none}
      .edu-acc-more{
        width:24px;height:24px;border:none;border-radius:6px;background:transparent;color:var(--edu-muted);
        display:inline-flex;align-items:center;justify-content:center;cursor:pointer;opacity:.7;
      }
      .edu-acc-item:hover .edu-acc-more,.edu-acc-more.open{opacity:1;background:var(--edu-subtle)}
      .edu-popover{
        position:absolute;top:calc(100% + 4px);right:0;min-width:154px;padding:5px;border-radius:10px;
        background:var(--edu-surface);border:1px solid var(--edu-border-strong);box-shadow:var(--edu-shadow-md);
        display:flex;flex-direction:column;gap:2px;z-index:45;
      }
      .edu-popover-item{
        width:100%;padding:7px 9px;border:none;border-radius:6px;background:transparent;color:var(--edu-text);
        font:inherit;font-size:12.5px;font-weight:500;text-align:left;display:flex;align-items:center;gap:8px;cursor:pointer;
      }
      .edu-popover-item:hover{background:var(--edu-hover)}
      .edu-popover-item.danger{color:var(--edu-red)}
      .edu-popover-item.danger:hover{background:var(--edu-red-soft)}
      .edu-popover-sep{height:1px;background:var(--edu-border);margin:3px 4px}
      .edu-acc-running{margin-top:6px;padding-left:39px;display:flex;align-items:center;gap:5px;color:var(--edu-accent-text)}
      .edu-acc-cta{
        margin-top:7px;padding-top:7px;border-top:1px dashed var(--edu-border);
        display:flex;align-items:center;justify-content:space-between;gap:6px;
      }
      .edu-rail-foot{padding:10px 12px;border-top:1px solid var(--edu-border)}

      /* Stage */
      .edu-stage{flex:1 1 auto;min-width:0;min-height:0;display:flex;flex-direction:column;position:relative;overflow:hidden}
      .edu-course-header{flex:0 0 auto;background:var(--edu-surface);border-bottom:1px solid var(--edu-border);padding:8px 20px 0}
      .edu-course-tabs-row{display:flex;align-items:center;justify-content:space-between;gap:12px}
      .edu-course-tabs{display:flex;align-items:center;gap:4px;overflow-x:auto;scrollbar-width:none}
      .edu-course-tabs::-webkit-scrollbar{display:none}
      .edu-course-tab{
        padding:8px 12px 10px;border:none;border-bottom:2px solid transparent;background:transparent;
        color:var(--edu-muted);font:inherit;font-size:13.5px;font-weight:550;white-space:nowrap;
        display:inline-flex;align-items:center;gap:7px;cursor:pointer;transition:color .12s ease,border-color .12s ease;
      }
      .edu-course-tab:hover{color:var(--edu-text)}
      .edu-course-tab.active{color:var(--edu-accent-text);border-bottom-color:var(--edu-accent)}
      .edu-course-tab-count{font-size:11px;padding:1px 6px;border-radius:999px;background:var(--edu-subtle);color:var(--edu-muted)}
      .edu-course-tab.active .edu-course-tab-count{background:var(--edu-accent-soft);color:var(--edu-accent-text)}
      .edu-course-actions{display:flex;align-items:center;gap:6px;flex:none;margin-bottom:5px}

      .edu-catalog-toolbar{
        flex:0 0 auto;padding:10px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;
        border-bottom:1px solid var(--edu-border);background:var(--edu-canvas);
      }
      .edu-course-meter{display:flex;align-items:center;gap:8px}
      .edu-meter-text{font-size:12.5px;font-weight:600}
      .edu-meter-track{width:96px;height:6px;border-radius:999px;background:var(--edu-border);overflow:hidden}
      .edu-meter-fill{height:100%;border-radius:999px;background:var(--edu-accent);transition:width .25s ease}
      .edu-meter-fill.done{background:var(--edu-green)}
      .edu-filter-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}

      .edu-seg-pills{
        display:inline-flex;padding:2px;border-radius:8px;background:var(--edu-surface);border:1px solid var(--edu-border);gap:2px;
      }
      .edu-seg-pill{
        padding:4px 10px;border:none;border-radius:6px;background:transparent;color:var(--edu-muted);
        font:inherit;font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap;
      }
      .edu-seg-pill:hover{color:var(--edu-text)}
      .edu-seg-pill.active{background:var(--edu-subtle);color:var(--edu-text);font-weight:600}

      .edu-search-box{position:relative;display:flex;align-items:center;color:var(--edu-faint)}
      .edu-search-box svg{position:absolute;left:10px;pointer-events:none}
      .edu-search-input{
        height:31px;width:210px;padding:0 10px 0 30px;border-radius:8px;border:1px solid var(--edu-border);
        background:var(--edu-surface);color:var(--edu-text);font:inherit;font-size:12.5px;outline:none;
      }
      .edu-search-input:focus{border-color:var(--edu-accent);box-shadow:0 0 0 3px var(--edu-accent-soft)}

      /* Scroll Container & Homework List */
      .edu-stage-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;padding:14px 20px 24px}
      .edu-stage-scroll.with-float{padding-bottom:84px}
      .edu-hw-list-card,.edu-q-table-card{
        background:var(--edu-surface);border:1px solid var(--edu-border);border-radius:10px;overflow:hidden;
      }
      .edu-hw-head,.edu-hw-row{
        display:grid;grid-template-columns:30px minmax(200px,1fr) 160px 124px 120px;align-items:center;gap:12px;
      }
      .edu-hw-head.readonly,.edu-hw-row.readonly{grid-template-columns:minmax(220px,1fr) 180px 100px}
      .edu-hw-head{
        padding:9px 14px;background:var(--edu-subtle);border-bottom:1px solid var(--edu-border);
        font-size:11.5px;font-weight:600;color:var(--edu-muted);
      }
      .edu-hw-row{padding:11px 14px;border-bottom:1px solid var(--edu-border);transition:background-color .1s ease}
      .edu-hw-row:last-child{border-bottom:none}
      .edu-hw-row:hover{background:var(--edu-hover)}
      .edu-hw-row.checked{background:var(--edu-accent-soft)}
      .edu-hw-title{font-weight:600;font-size:13.5px}
      .edu-hw-progress-cell{display:flex;flex-direction:column;gap:5px}
      .edu-hw-progress-label{display:flex;justify-content:space-between;font-size:11.5px}
      .edu-hw-progress-bar{height:5px;border-radius:999px;background:var(--edu-subtle);border:1px solid var(--edu-border);overflow:hidden}
      .edu-hw-progress-bar > span{display:block;height:100%;border-radius:999px;background:var(--edu-accent)}
      .edu-hw-progress-bar > span.done{background:var(--edu-green)}
      .edu-hw-actions{display:flex;align-items:center;justify-content:flex-end;gap:6px}
      .edu-panel input[type=checkbox]{width:15px;height:15px;accent-color:var(--edu-accent);cursor:pointer;margin:0}

      /* Floating Batch Bar */
      @keyframes edu-slide-up{from{opacity:0;transform:translate(-50%,10px)}to{opacity:1;transform:translate(-50%,0)}}
      .edu-float-bar{
        position:absolute;left:50%;bottom:18px;transform:translateX(-50%);z-index:30;
        background:var(--edu-surface);border:1px solid var(--edu-border-strong);border-radius:12px;
        box-shadow:var(--edu-shadow-lg);padding:8px 10px 8px 14px;display:flex;align-items:center;gap:12px;
        width:max-content;max-width:calc(100% - 28px);animation:edu-slide-up .16s ease-out;
      }
      .edu-float-count{display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px;white-space:nowrap}
      .edu-float-num{
        min-width:22px;height:22px;padding:0 6px;border-radius:999px;background:var(--edu-accent);color:#fff;
        display:inline-flex;align-items:center;justify-content:center;font-size:12px;
      }
      .edu-float-sep{width:1px;height:20px;background:var(--edu-border)}
      .edu-float-drawer{
        position:absolute;left:50%;bottom:68px;transform:translateX(-50%);z-index:31;
        width:min(460px,calc(100% - 28px));max-height:260px;background:var(--edu-surface);
        border:1px solid var(--edu-border-strong);border-radius:12px;box-shadow:var(--edu-shadow-lg);
        padding:12px;display:flex;flex-direction:column;gap:8px;
      }
      .edu-float-drawer-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
      .edu-float-drawer-list{overflow-y:auto;display:flex;flex-direction:column;gap:6px}
      .edu-float-drawer-item{
        display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 10px;
        border-radius:8px;background:var(--edu-subtle);font-size:12.5px;
      }

      /* Queue View */
      .edu-queue-toolbar{
        flex:0 0 auto;padding:11px 20px;background:var(--edu-surface);border-bottom:1px solid var(--edu-border);
        display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;
      }
      .edu-queue-chips{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
      .edu-q-chip{
        display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:8px;
        border:1px solid transparent;background:var(--edu-subtle);color:var(--edu-muted);
        font:inherit;font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap;
      }
      .edu-q-chip:hover{color:var(--edu-text);border-color:var(--edu-border)}
      .edu-q-chip.active{background:var(--edu-accent-soft);color:var(--edu-accent-text);border-color:color-mix(in srgb,var(--edu-accent) 35%,transparent);font-weight:600}
      .edu-q-chip-num{font-size:11px;opacity:.82}
      .edu-queue-right-tools{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
      .edu-stepper{
        display:inline-flex;align-items:center;height:31px;border-radius:8px;
        border:1px solid var(--edu-border);background:var(--edu-surface);overflow:hidden;
      }
      .edu-stepper-label{
        height:100%;padding:0 9px;display:inline-flex;align-items:center;font-size:12px;color:var(--edu-muted);
        background:var(--edu-subtle);border-right:1px solid var(--edu-border);white-space:nowrap;
      }
      .edu-stepper button{
        width:26px;height:100%;border:none;background:transparent;color:var(--edu-muted);
        font:inherit;font-weight:600;cursor:pointer;
      }
      .edu-stepper button:hover:not(:disabled){background:var(--edu-hover);color:var(--edu-text)}
      .edu-stepper button:disabled{opacity:.4;cursor:not-allowed}
      .edu-stepper-val{min-width:24px;text-align:center;font-weight:650;font-size:12.5px}

      .edu-queue-bulk{
        flex:0 0 auto;padding:8px 20px;background:var(--edu-accent-soft);
        border-bottom:1px solid color-mix(in srgb,var(--edu-accent) 25%,transparent);
        display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;
      }
      .edu-table-wrap{overflow-x:auto}
      .edu-q-table{width:100%;border-collapse:collapse}
      .edu-q-table th{
        text-align:left;padding:9px 14px;font-size:11.5px;font-weight:600;color:var(--edu-muted);
        background:var(--edu-subtle);border-bottom:1px solid var(--edu-border);white-space:nowrap;
      }
      .edu-q-table td{padding:11px 14px;border-bottom:1px solid var(--edu-border);vertical-align:middle}
      .edu-q-table tr:last-child td{border-bottom:none}
      .edu-q-table tbody tr{cursor:pointer;transition:background-color .1s ease}
      .edu-q-table tbody tr:hover{background:var(--edu-hover)}
      .edu-q-table tbody tr.active-row{background:var(--edu-accent-soft)}
      .edu-col-check{width:36px;text-align:center}
      .edu-account-chip{
        display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:6px;
        background:var(--edu-subtle);border:1px solid var(--edu-border);font-size:12px;font-weight:500;white-space:nowrap;
      }
      .edu-row-actions{display:flex;align-items:center;justify-content:flex-end;gap:6px;white-space:nowrap}

      /* Slide-Over Task Drawer */
      @keyframes edu-fade-in{from{opacity:0}to{opacity:1}}
      @keyframes edu-slide-right{from{transform:translateX(24px);opacity:.75}to{transform:translateX(0);opacity:1}}
      .edu-drawer-backdrop{
        position:absolute;inset:0;z-index:40;background:rgba(15,23,42,.22);display:flex;justify-content:flex-end;
        animation:edu-fade-in .14s ease;
      }
      .edu-drawer{
        width:min(440px,100%);height:100%;background:var(--edu-surface);border-left:1px solid var(--edu-border-strong);
        box-shadow:var(--edu-shadow-lg);display:flex;flex-direction:column;animation:edu-slide-right .16s ease-out;
      }
      .edu-drawer-head{
        padding:13px 18px;border-bottom:1px solid var(--edu-border);display:flex;align-items:center;justify-content:space-between;gap:10px;
      }
      .edu-drawer-head h3{font-size:14px;font-weight:650}
      .edu-drawer-body{flex:1 1 auto;overflow-y:auto;padding:16px 18px;display:flex;flex-direction:column;gap:14px}
      .edu-drawer-summary{
        padding:12px 14px;border-radius:10px;background:var(--edu-subtle);border:1px solid var(--edu-border);
        display:flex;flex-direction:column;gap:5px;
      }
      .edu-drawer-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:4px;color:var(--edu-muted)}
      .edu-drawer-callout{padding:10px 12px;border-radius:8px;background:var(--edu-red-soft);color:var(--edu-red);font-size:12.5px}
      .edu-drawer-callout.info{background:var(--edu-accent-soft);color:var(--edu-accent-text)}
      .edu-drawer-callout.warn{background:var(--edu-amber-soft);color:var(--edu-amber)}
      .edu-drawer-callout.ok{background:var(--edu-green-soft);color:var(--edu-green)}
      .edu-drawer-callout.neutral{background:var(--edu-subtle);color:var(--edu-muted);border:1px solid var(--edu-border)}

      .edu-timeline-heading{font-size:12px;font-weight:600;color:var(--edu-muted);margin-bottom:10px}
      .edu-timeline{list-style:none;padding:0;display:flex;flex-direction:column;gap:10px}
      .edu-timeline-item{display:grid;grid-template-columns:14px 1fr;gap:10px}
      .edu-timeline-rail{display:flex;flex-direction:column;align-items:center;padding-top:5px}
      .edu-timeline-line{width:1px;flex:1;background:var(--edu-border);margin-top:4px}
      .edu-timeline-item:last-child .edu-timeline-line{display:none}
      .edu-timeline-card{padding:9px 11px;border-radius:9px;border:1px solid var(--edu-border);background:var(--edu-surface)}
      .edu-timeline-head{display:flex;align-items:center;justify-content:space-between;gap:8px}

      /* Account Modal */
      .edu-modal-backdrop{
        position:fixed;inset:0;z-index:70;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;padding:16px;
      }
      .edu-modal{
        width:min(400px,100%);background:var(--edu-surface);border:1px solid var(--edu-border-strong);border-radius:14px;
        box-shadow:var(--edu-shadow-lg);padding:18px 20px;display:flex;flex-direction:column;gap:14px;
      }
      .edu-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
      .edu-modal-head h2{font-size:15px;font-weight:650}
      .edu-modal-error{padding:8px 10px;border-radius:8px;background:var(--edu-red-soft);color:var(--edu-red);font-size:12.5px}
      .edu-modal-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}
      .edu-field{display:flex;flex-direction:column;gap:5px}
      .edu-field label{font-size:12.5px;font-weight:550;color:var(--edu-muted)}
      .edu-input{
        height:36px;width:100%;padding:0 11px;border-radius:8px;border:1px solid var(--edu-border-strong);
        background:var(--edu-surface);color:var(--edu-text);font:inherit;outline:none;
      }
      .edu-input:focus{border-color:var(--edu-accent);box-shadow:0 0 0 3px var(--edu-accent-soft)}
      .edu-password-wrap{position:relative}
      .edu-password-wrap .edu-input{padding-right:36px}
      .edu-eye-btn{
        position:absolute;right:6px;top:50%;transform:translateY(-50%);width:26px;height:26px;border:none;border-radius:6px;
        background:transparent;color:var(--edu-muted);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;
      }
      .edu-eye-btn:hover{background:var(--edu-hover);color:var(--edu-text)}

      /* Empty / Loading / Toast */
      .edu-center-wrap{flex:1;overflow-y:auto;padding:24px;display:flex;align-items:flex-start;justify-content:center}
      .edu-empty-card{
        margin-top:32px;max-width:420px;width:100%;padding:28px 24px;text-align:center;border-radius:14px;
        background:var(--edu-surface);border:1px dashed var(--edu-border-strong);
        display:flex;flex-direction:column;align-items:center;gap:10px;
      }
      .edu-empty-icon{
        width:44px;height:44px;border-radius:12px;background:var(--edu-accent-soft);color:var(--edu-accent-text);
        display:inline-flex;align-items:center;justify-content:center;
      }
      .edu-empty-title{font-size:15.5px}
      .edu-empty-inline{padding:32px 16px;text-align:center;color:var(--edu-muted);font-size:13px}
      .edu-tabs-skeleton{display:flex;gap:8px;padding:10px 0}
      .edu-skeleton-pill{width:110px;height:20px;border-radius:6px;background:var(--edu-subtle)}
      .edu-skeleton-pad{padding:12px;display:grid;gap:10px}
      @keyframes edu-pulse{50%{opacity:.55}}
      .edu-skeleton-row{height:38px;border-radius:8px;background:var(--edu-subtle);animation:edu-pulse 1.3s ease-in-out infinite}

      .edu-toast{
        position:fixed;right:18px;bottom:18px;z-index:90;padding:8px 10px 8px 13px;border-radius:10px;
        background:var(--edu-text);color:var(--edu-surface);font-size:12.5px;font-weight:500;box-shadow:var(--edu-shadow-lg);
        display:flex;align-items:center;gap:8px;
      }
      .edu-toast-close{color:var(--edu-surface) !important;opacity:.75}
      .edu-toast-close:hover{opacity:1;background:rgba(255,255,255,.15) !important}

      @container edu-panel (max-width:860px){
        .edu-panel{height:auto;min-height:100%;overflow:auto}
        .edu-app-body{flex-direction:column;overflow:visible}
        .edu-rail{width:100%;flex:none;border-right:none;border-bottom:1px solid var(--edu-border)}
        .edu-rail-scroll{max-height:220px}
        .edu-stage,.edu-stage-scroll{overflow:visible}
        .edu-hw-head,.edu-hw-row{grid-template-columns:24px minmax(0,1fr) 96px auto;gap:8px;padding:10px 12px}
        .edu-hw-head:not(.readonly) > span:nth-child(4),.edu-hw-row:not(.readonly) > div:nth-child(4){display:none}
        .edu-hw-head.readonly,.edu-hw-row.readonly{grid-template-columns:minmax(0,1fr) 96px auto;gap:8px;padding:10px 12px}
        .edu-float-bar{position:sticky;bottom:12px;margin:12px auto;transform:none;left:auto;animation:none;flex-wrap:wrap;justify-content:space-between;width:min(100%,max-content)}
        .edu-float-sep{display:none}
      }
      @container edu-panel (max-width:640px){
        .edu-topbar{padding:8px 12px;flex-wrap:wrap}
        .edu-course-header,.edu-catalog-toolbar,.edu-queue-toolbar,.edu-stage-scroll{padding-left:12px;padding-right:12px}
        .edu-search-input{width:140px}
        .edu-col-time{display:none}
        .edu-hw-head,.edu-hw-row{grid-template-columns:22px minmax(0,1fr) 84px auto;gap:8px;padding:9px 10px}
        .edu-hw-head.readonly,.edu-hw-row.readonly{grid-template-columns:minmax(0,1fr) 84px auto;gap:8px;padding:9px 10px}
        .edu-hw-actions .edu-btn{padding:4px 8px;font-size:12px}
      }
    `;

    function Icon({ size = 16 }) {
      return h(SvgIcon, { paths: icons.brand, size });
    }

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style');
        style.dataset.pluginCss = '@forst/dsh-educoder';
        style.textContent = css;
        document.head.append(style);
        return () => style.remove();
      }, 'dsh-educoder: styles');
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: panelId,
        inject: () => ({ navigateSession: async sessionId => {
          await ctx.sessions.refresh();
          ctx.uiWorkspace.openSession(sessionId);
        } }),
      }, Page));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: panelId, order: 32, label: 'EduCoder',
      }, Icon));
    }

    return { apply, inject: ['slots', 'sessions', 'uiWorkspace'] };
  },
});
