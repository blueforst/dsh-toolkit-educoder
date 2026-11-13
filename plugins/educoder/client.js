window.__ModuleLoader__.load({
  id: '@forst/dsh-educoder',
  factory: require => {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;
    const panelId = 'dsh-educoder';

    const accountLabels = { ready: '已登录', unverified: '待核验', auth_required: '需重新登录', manual: '需人工处理' };
    const taskLabels = {
      waiting: '待启动', queued: '排队中', running: '运行中', paused: '已暂停',
      manual: '需人工处理', failed: '执行失败', passed: '已通过', cancelled: '已取消',
    };
    const problemLabels = {
      auth_required: '账号会话已失效，请重新登录。',
      invalid_credentials: '登录未通过，请检查账号和密码。',
      live_disabled: '此实例未启用真实 EduCoder 提交。',
      next_stage: '已通过本关，准备读取下一关。',
      stage_limit: '已达到单次任务的关卡上限。',
      signature_error: '平台拒绝了请求签名。',
      manual_required: '平台需要人工处理，请核对登录验证或题型。',
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
      busy: '该账号有任务在运行，请先暂停或等待。',
      stale_scope: '远端任务已变化，请重新读取作业。',
      already_exists: '该账号或任务已存在。',
      not_found: '该账号或任务已被移除。',
      invalid_state: '任务状态已更新，请刷新后重试。',
      retry_limit: '已达到重试上限。',
      recovery_required: '任务有未确认的远端操作，恢复时会先核对状态。',
    };
    const commands = {
      start: { label: '启动', states: ['waiting'] },
      pause: { label: '暂停', states: ['queued', 'running'] },
      resume: { label: '恢复', states: ['paused', 'manual', 'failed'] },
      cancel: { label: '取消任务', states: ['waiting', 'queued', 'running', 'paused', 'manual', 'failed'] },
    };
    const formatDate = value => {
      if (!value) return '';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
    };
    const titleOf = (items, id) => items.find(item => item.id === id)?.title || id;
    const homeworkLabel = item => Number.isSafeInteger(item.taskCount) && item.taskCount > 0
      ? item.title + ' · 已通过 ' + (item.passedCount ?? 0) + '/' + item.taskCount + ' 关'
      : item.title;
    const duration = milliseconds => {
      const seconds = Math.round(milliseconds / 1000);
      if (seconds < 60) return seconds + ' 秒';
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return minutes + ' 分钟';
      return (minutes / 60).toFixed(1) + ' 小时';
    };
    const label = (labels, key, fallback) => Object.hasOwn(labels, key) ? labels[key] : fallback;
    const taskMessage = code => code ? label(problemLabels, code, '查看任务记录以了解详情。') : '';
    const errorMessage = error => label(problemLabels, error?.code, '请求失败，请刷新后重试。');

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

    function Button({ children, primary, danger, ...props }) {
      return h('button', {
        type: 'button', ...props,
        className: ['edu-button', primary && 'edu-primary', danger && 'edu-danger', props.className].filter(Boolean).join(' '),
      }, children);
    }

    function Field({ name, children }) {
      const id = React.useId();
      return h('div', { className: 'edu-field' }, h('label', { htmlFor: id }, name),
        React.cloneElement(children, { id }));
    }

    function CredentialsForm({ account, busy, onSubmit, onCancel }) {
      return h('form', {
        className: 'edu-form',
        onSubmit(event) {
          event.preventDefault();
          const form = event.currentTarget;
          const login = form.elements.namedItem('login').value.trim();
          const passwordInput = form.elements.namedItem('password');
          const password = passwordInput.value;
          passwordInput.value = '';
          if (login && password) onSubmit(account, login, password);
        },
      },
      h(Field, { name: '用户名、手机号或邮箱' }, h('input', { name: 'login', autoComplete: 'off', maxLength: 255, required: true })),
      h(Field, { name: '密码' }, h('input', { name: 'password', type: 'password', autoComplete: 'off', maxLength: 1024, required: true })),
      h('div', { className: 'edu-actions' },
        h(Button, { type: 'submit', primary: true, disabled: busy }, account ? '验证并重新登录' : '添加账号'),
        account && h(Button, { onClick: onCancel, disabled: busy }, '取消')));
    }

    function AccountSummary({ tasks }) {
      const completed = tasks.filter(task => ['passed', 'failed'].includes(task.status));
      const passed = completed.filter(task => task.status === 'passed').length;
      const elapsed = completed.map(task => Date.parse(task.finishedAt) - Date.parse(task.startedAt))
        .filter(value => Number.isFinite(value) && value >= 0);
      return h('p', { className: 'edu-muted' },
        '本地记录 ', tasks.length, ' 项',
        completed.length > 0 && (' · 有通过或失败结果 ' + completed.length + ' 项，已通过 ' + passed + ' 项'),
        elapsed.length > 0 && (' · 末次执行平均耗时 ' + duration(elapsed.reduce((sum, value) => sum + value, 0) / elapsed.length)));
    }

    function Accounts({ accounts, selected, tasks, busy, chooseAccount, checkAccount, saveAccount, removeAccount }) {
      const [editing, setEditing] = useState(null);
      const [removing, setRemoving] = useState(null);
      const editingAccount = accounts.find(account => account.id === editing);
      return h('section', { className: 'edu-card', 'aria-labelledby': 'edu-account-heading' },
        h('h2', { id: 'edu-account-heading' }, '账号'),
        accounts.length === 0 && h('p', { className: 'edu-muted' }, '添加账号后可读取该账号的课程和作业。'),
        h('ul', { className: 'edu-accounts' }, accounts.map(account => h('li', { key: account.id },
          h(Button, {
            className: 'edu-account-button', 'aria-pressed': selected === account.id,
            onClick: () => chooseAccount(account.id),
          }, h('span', { className: 'edu-wrap' }, account.label || account.id),
          h('span', { className: 'edu-pill', 'data-status': account.status }, label(accountLabels, account.status, '状态待确认'))),
          selected === account.id && h(AccountSummary, { tasks: tasks.filter(task => task.accountId === selected) }),
          h('div', { className: 'edu-actions' },
            h(Button, { onClick: () => checkAccount(account.id), disabled: busy }, '检查登录'),
            h(Button, { onClick: () => setEditing(account.id), disabled: busy }, '重新登录'),
            h(Button, { danger: true, onClick: () => setRemoving(account.id), disabled: busy }, '解绑并删除')),
          removing === account.id && h('div', { className: 'edu-confirm' },
            h('p', null, '解绑会清除该账号的会话凭据并取消未完成的任务。'),
            h('div', { className: 'edu-actions' },
              h(Button, {
                danger: true, disabled: busy,
                onClick: async () => { if (await removeAccount(account.id)) setRemoving(null); },
              }, '确认解绑'),
              h(Button, { onClick: () => setRemoving(null), disabled: busy }, '取消')))))),
        h('h3', null, editingAccount ? '重新登录 ' + (editingAccount.label || editingAccount.id) : '添加账号'),
        h(CredentialsForm, {
          key: editingAccount?.id || 'new', account: editingAccount, busy,
          onCancel: () => setEditing(null),
          onSubmit: async (account, login, password) => {
            if (await saveAccount(account?.id, login, password)) setEditing(null);
          },
        }));
    }

    function useCatalog(action, scope, fields, version) {
      const [entry, setEntry] = useState(null);
      useEffect(() => {
        if (!scope) return;
        const controller = new AbortController();
        request(action, fields, controller.signal)
          .then(items => {
            if (!controller.signal.aborted) setEntry({ scope, version, items });
          })
          .catch(error => {
            if (!controller.signal.aborted) setEntry({ scope, version, items: [], error: errorMessage(error) });
          });
        return () => controller.abort();
      }, [action, scope, version]);
      if (!scope) return { items: [] };
      return entry?.scope === scope && entry?.version === version ? entry : { items: [], loading: true };
    }

    function Picker({ account, version, busy, batch, setBatch, allocate }) {
      const [courseId, setCourseId] = useState('');
      const [homeworkId, setHomeworkId] = useState('');
      const id = account && ['ready', 'unverified'].includes(account.status) ? account.id : '';
      const courses = useCatalog('courses', id, { accountId: id }, version);
      const currentCourse = courses.items.some(item => item.id === courseId) ? courseId : '';
      const homeworks = useCatalog('homeworks', currentCourse && JSON.stringify([id, currentCourse]), {
        accountId: id, courseId: currentCourse,
      }, version);
      const currentHomework = homeworks.items.some(item => item.id === homeworkId) ? homeworkId : '';
      const target = id && currentCourse && currentHomework
        ? { accountId: id, courseId: currentCourse, homeworkId: currentHomework } : null;
      const targetKey = value => JSON.stringify([value.accountId, value.courseId, value.homeworkId]);
      const isInBatch = target && batch.some(item => targetKey(item.target) === targetKey(target));
      return h('section', { className: 'edu-card', 'aria-labelledby': 'edu-picker-heading' },
        h('h2', { id: 'edu-picker-heading' }, '选择作业'),
        !account && h('p', { className: 'edu-muted' }, '选择一个账号以加载课程。'),
        account && !id && h('p', { className: 'edu-muted' }, label(problemLabels,
          account.status === 'manual' ? 'manual_required' : 'auth_required', '账号状态待确认。')),
        id && h(React.Fragment, null,
          h('p', { className: 'edu-muted' }, account.label || account.id),
          h('div', { className: 'edu-fields-row' },
            h(Field, { name: '课程' },
              h('select', {
                value: currentCourse, disabled: courses.loading || !courses.items.length,
                onChange: event => { setCourseId(event.target.value); setHomeworkId(''); },
              },
              h('option', { value: '' }, courses.loading ? '正在读取课程…' : (courses.items.length ? '选择课程' : '暂无可用课程')),
              courses.items.map(item => h('option', { key: item.id, value: item.id }, item.title)))),
            h(Field, { name: '作业' },
              h('select', {
                value: currentHomework, disabled: !currentCourse || homeworks.loading || !homeworks.items.length,
                onChange: event => setHomeworkId(event.target.value),
              },
              h('option', { value: '' }, homeworks.loading ? '正在读取作业…' : (homeworks.items.length ? '选择作业' : '暂无可用作业')),
              homeworks.items.map(item => h('option', { key: item.id, value: item.id }, homeworkLabel(item)))))),
          (courses.error || homeworks.error) && h('p', { role: 'alert', className: 'edu-error' }, courses.error || homeworks.error),
          h('div', { className: 'edu-actions' },
            h(Button, { primary: true, disabled: busy || !target, onClick: () => allocate([target], true) }, '启动此作业'),
            h(Button, {
              disabled: busy || !target || isInBatch,
              onClick: () => setBatch(items => items.some(item => targetKey(item.target) === targetKey(target))
                ? items
                : [...items, {
                  target, accountLabel: account.label || id,
                  courseTitle: titleOf(courses.items, currentCourse),
                  homeworkTitle: titleOf(homeworks.items, currentHomework),
                }]),
            }, isInBatch ? '已加入批量' : '加入批量'))),
        h('div', { className: 'edu-batch' },
          h('h3', null, '批量分配'),
          batch.length === 0 && h('p', { className: 'edu-muted' }, '在每个账号下选择作业，再把它加入批量。'),
          batch.length > 0 && h(React.Fragment, null,
            h('ul', { className: 'edu-batch-list' }, batch.map(item => h('li', { key: targetKey(item.target) },
              h('span', { className: 'edu-wrap' }, item.accountLabel, ' · ', item.courseTitle, ' · ', item.homeworkTitle),
              h(Button, {
                disabled: busy,
                onClick: () => setBatch(items => items.filter(value => targetKey(value.target) !== targetKey(item.target))),
                'aria-label': '移除 ' + item.homeworkTitle,
              }, '移除')))),
            h('div', { className: 'edu-actions' },
              h(Button, { disabled: busy, onClick: () => allocate(batch.map(item => item.target), false, true) }, '分配为待启动'),
              h(Button, { primary: true, disabled: busy, onClick: () => allocate(batch.map(item => item.target), true, true) }, '分配并启动')))));
    }

    function TaskRow({ task, account, checked, toggle, busy, run, detail, openSession }) {
      const statusLabel = label(taskLabels, task.status, '待确认');
      const title = task.homeworkTitle || '作业 ' + task.homeworkId;
      const code = taskMessage(task.code);
      return h('tr', null,
        h('td', null, h('input', { type: 'checkbox', 'aria-label': '选择 ' + title, checked, onChange: toggle })),
        h('td', { className: 'edu-wrap' }, account?.label || '账号 ' + task.accountId.slice(0, 8)),
        h('td', { className: 'edu-wrap' }, h('strong', null, title),
          h('div', { className: 'edu-muted' }, task.courseTitle || '课程 ' + task.courseId)),
        h('td', null, h('span', { className: 'edu-pill', 'data-status': task.status }, statusLabel),
          code && h('div', { className: 'edu-muted' }, code),
          task.retryAt && h('div', { className: 'edu-muted' }, '下次核对 ', formatDate(task.retryAt))),
        h('td', null, formatDate(task.verifiedAt || task.updatedAt) || '—'),
        h('td', null, h('div', { className: 'edu-actions' },
          Object.entries(commands).filter(([, command]) => command.states.includes(task.status)).map(([command, { label }]) =>
            h(Button, { key: command, disabled: busy, onClick: () => run([task.id], command) }, label)),
          h(Button, { onClick: () => detail(task.id), disabled: busy }, '记录'),
          task.sessionId && h(Button, { onClick: () => openSession(task.sessionId), disabled: busy }, '会话'))));
    }

    function TaskLog({ task, busy, close, openSession }) {
      return h('section', { className: 'edu-log', 'aria-labelledby': 'edu-log-heading' },
        h('div', { className: 'edu-heading-row' },
          h('h3', { id: 'edu-log-heading' }, '任务记录'),
          h(Button, { onClick: close }, '关闭记录')),
        h('p', { className: 'edu-muted' }, task.homeworkTitle || '作业 ' + task.homeworkId,
          ' · 尝试 ', task.attempts || 0, ' 次', task.verifiedAt ? ' · 核验于 ' + formatDate(task.verifiedAt) : ''),
        task.events?.length ? h('ol', { className: 'edu-event-list' }, [...task.events].reverse().map((event, index) => h('li', { key: index },
          h('time', { dateTime: event.at }, formatDate(event.at)),
          h('span', null, label(taskLabels, event.status, '状态已更新'), event.code && ' · ' + taskMessage(event.code)),
          event.sessionId && h(Button, { onClick: () => openSession(event.sessionId), disabled: busy }, '会话'))))
          : h('p', { className: 'edu-muted' }, '暂无记录。'));
    }

    function Queue({ tasks, accounts, busy, concurrency, saveConcurrency, run, detail, log, closeLog, openSession }) {
      const [query, setQuery] = useState('');
      const [status, setStatus] = useState('');
      const [checked, setChecked] = useState([]);
      const selected = tasks.filter(task => checked.includes(task.id));
      const accountsById = new Map(accounts.map(account => [account.id, account]));
      const search = query.trim().toLocaleLowerCase();
      const visible = tasks.filter(task => (!status || status === task.status)
        && (!search || [task.id, task.courseId, task.homeworkId, task.courseTitle, task.homeworkTitle, accountsById.get(task.accountId)?.label]
          .some(value => typeof value === 'string' && value.toLocaleLowerCase().includes(search))));
      const running = tasks.filter(task => task.status === 'running').length;
      const waiting = tasks.filter(task => task.status === 'queued').length;
      return h('section', { className: 'edu-card edu-queue', 'aria-labelledby': 'edu-queue-heading' },
        h('div', { className: 'edu-heading-row' },
          h('div', null,
            h('h2', { id: 'edu-queue-heading' }, '任务队列'),
            h('p', { className: 'edu-muted' }, '运行中 ', running, ' · 排队中 ', waiting)),
          concurrency && h('form', {
            className: 'edu-inline-form', key: concurrency,
            onSubmit: event => {
              event.preventDefault();
              saveConcurrency(event.currentTarget.elements.namedItem('concurrency').valueAsNumber);
            },
          },
          h(Field, { name: '全局并发上限' }, h('input', {
            name: 'concurrency', type: 'number', min: 1, max: 8, defaultValue: concurrency, required: true,
          })),
          h(Button, { type: 'submit', disabled: busy }, '保存'))),
        h('div', { className: 'edu-fields-row edu-queue-controls' },
          h(Field, { name: '搜索任务' }, h('input', {
            type: 'search', placeholder: '账号、课程、作业或任务编号', value: query,
            onChange: event => setQuery(event.target.value),
          })),
          h(Field, { name: '状态' }, h('select', { value: status, onChange: event => setStatus(event.target.value) },
            h('option', { value: '' }, '全部状态'),
            Object.entries(taskLabels).map(([value, label]) => h('option', { key: value, value }, label))))),
        selected.length > 0 && h('div', { className: 'edu-actions edu-selection' },
          h('span', null, '已选 ', selected.length, ' 项'),
          Object.entries(commands).filter(([, command]) => selected.every(task => command.states.includes(task.status)))
            .map(([command, { label }]) => h(Button, {
              key: command, disabled: busy, onClick: () => run(selected.map(task => task.id), command),
            }, '批量' + label)),
          h(Button, { onClick: () => setChecked([]) }, '清除选择')),
        visible.length ? h('div', { className: 'edu-table-scroll', tabIndex: 0, role: 'region', 'aria-label': '任务列表' },
          h('table', null,
            h('thead', null, h('tr', null, ['选择', '账号', '作业', '状态', '更新时间', '操作'].map(label => h('th', { key: label, scope: 'col' }, label)))),
            h('tbody', null, visible.map(task => h(TaskRow, {
              key: task.id, task, account: accountsById.get(task.accountId), checked: checked.includes(task.id),
              toggle: () => setChecked(ids => ids.includes(task.id) ? ids.filter(id => id !== task.id) : [...ids, task.id]),
              busy, run, detail, openSession,
            }))))) : h('p', { className: 'edu-empty' }, tasks.length ? '没有符合条件的任务。' : '选择作业后可创建任务。'),
        log && h(TaskLog, { task: log, busy, close: closeLog, openSession }));
    }

    function Page({ navigateSession }) {
      const [accounts, setAccounts] = useState([]);
      const [tasks, setTasks] = useState([]);
      const [accountId, setAccountId] = useState('');
      const [version, setVersion] = useState(0);
      const [batch, setBatch] = useState([]);
      const [concurrency, setConcurrency] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [stale, setStale] = useState(false);
      const [log, setLog] = useState(null);
      const [loaded, setLoaded] = useState(false);
      const operation = useRef(null);
      const revision = useRef(0);
      const account = accounts.find(item => item.id === accountId) || accounts[0];

      async function readAll(signal) {
        const token = ++revision.current;
        const [accountList, taskList, settings] = await Promise.all([
          request('accounts', {}, signal), request('tasks', {}, signal), request('settings', {}, signal),
        ]);
        if (signal.aborted || token !== revision.current) return;
        setAccounts(accountList);
        setTasks(taskList);
        setConcurrency(settings.concurrency);
        setStale(false);
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
            }
            else {
              const values = await request('tasks', {}, controller.signal);
              if (!controller.signal.aborted && token === revision.current) {
                setTasks(values);
                setStale(false);
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
          clearInterval(timer);
        };
      }, []);

      async function perform(callback) {
        if (operation.current) return false;
        const controller = new AbortController();
        operation.current = controller;
        ++revision.current;
        setBusy(true);
        setError('');
        try {
          await callback(controller.signal);
          return true;
        } catch (failure) {
          if (!controller.signal.aborted) setError(errorMessage(failure));
          return false;
        } finally {
          if (operation.current === controller) operation.current = null;
          if (!controller.signal.aborted) setBusy(false);
        }
      }

      function updateAccount(updated) {
        setAccounts(previous => previous.some(item => item.id === updated.id)
          ? previous.map(item => item.id === updated.id ? updated : item) : [...previous, updated]);
        setVersion(value => value + 1);
      }

      function mergeTasks(updated) {
        setTasks(previous => [...updated, ...previous.filter(task => !updated.some(value => value.id === task.id))]);
      }

      async function allocate(targets, start, fromBatch) {
        return perform(async signal => {
          mergeTasks(await request('allocate', { targets, start }, signal));
          if (fromBatch) setBatch([]);
        });
      }

      function openSession(sessionId) {
        return perform(() => navigateSession(sessionId));
      }

      return h('main', { className: 'edu-panel', 'aria-labelledby': 'edu-heading', 'aria-busy': !loaded },
        h('div', { className: 'edu-content' },
          h('header', { className: 'edu-heading-row edu-page-heading' },
            h('h1', { id: 'edu-heading' }, 'EduCoder'),
            h(Button, {
              disabled: busy,
              onClick: () => perform(async signal => {
                await readAll(signal);
                setVersion(value => value + 1);
              }),
            }, '刷新')),
          error && h('div', { role: 'alert', className: 'edu-notice edu-error' }, error),
          stale && h('div', { role: 'status', className: 'edu-notice' }, '数据暂未更新。可用「刷新」重新连接。'),
          !loaded ? (!stale && h('p', { role: 'status', className: 'edu-muted' }, '正在读取 EduCoder 数据…'))
            : h(React.Fragment, null,
              h('div', { className: 'edu-grid' },
                h(Accounts, {
                  accounts, selected: account?.id, tasks, busy, chooseAccount: setAccountId,
                  checkAccount: id => perform(async signal => {
                    try {
                      updateAccount(await request('checkAccount', { accountId: id }, signal));
                    } catch (failure) {
                      await readAll(signal).catch(() => {});
                      throw failure;
                    }
                  }),
                  saveAccount: (id, login, password) => perform(async signal => {
                    const updated = await request(id ? 'relogin' : 'addAccount', {
                      ...(id ? { accountId: id } : {}), login, password,
                    }, signal);
                    updateAccount(updated);
                    setAccountId(updated.id);
                  }),
                  removeAccount: id => perform(async signal => {
                    await request('removeAccount', { accountId: id }, signal);
                    setAccounts(previous => previous.filter(item => item.id !== id));
                    setBatch(items => items.filter(item => item.target.accountId !== id));
                    await readAll(signal);
                  }),
                }),
                h(Picker, { key: account?.id || 'no-account', account, version, busy, batch, setBatch, allocate })),
              h(Queue, {
                tasks, accounts, busy, concurrency, log, openSession, closeLog: () => setLog(null),
                saveConcurrency: value => perform(async signal => {
                  const settings = await request('settings', { concurrency: value }, signal);
                  setConcurrency(settings.concurrency);
                }),
                run: (taskIds, command) => perform(async signal => mergeTasks(await request('control', { taskIds, command }, signal))),
                detail: taskId => perform(async signal => setLog(await request('task', { taskId }, signal))),
              }))));
    }

    const css = `
      .edu-panel{height:100%;min-height:0;overflow:auto;color:var(--dsw-alias-label-primary,#172033);background:var(--dsw-alias-bg-base,#fff);font-size:14px;line-height:1.55}
      .edu-content{max-width:1240px;margin:auto;padding:clamp(16px,4vw,44px);display:grid;gap:16px}
      .edu-content :where(h1,h2,h3,p,ul,ol){margin:0}
      .edu-content h1{font-size:clamp(24px,4vw,32px);line-height:1.25;letter-spacing:-.025em}
      .edu-content h2{font-size:17px;line-height:1.4}
      .edu-content h3{font-size:14px;line-height:1.4}
      .edu-muted{color:var(--dsw-alias-label-secondary,#525d70)}
      .edu-heading-row,.edu-actions,.edu-batch-list li{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .edu-heading-row,.edu-batch-list li{justify-content:space-between}
      .edu-page-heading{padding-bottom:8px}
      .edu-page-heading p,.edu-heading-row p{margin-top:3px}
      .edu-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:16px}
      .edu-card{min-width:0;padding:clamp(12px,2vw,20px);border:1px solid var(--dsw-alias-border-l2,#dce1e8);border-radius:12px;display:grid;gap:14px;align-content:start}
      .edu-form,.edu-field{display:grid;gap:6px;min-width:0}
      .edu-form,.edu-fields-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,170px),1fr));gap:10px}
      .edu-form>.edu-actions{grid-column:1/-1}
      .edu-field label{font-size:13px;font-weight:500}
      .edu-panel :where(input:not([type=checkbox]),select){box-sizing:border-box;width:100%;min-height:36px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,#cbd2df);padding:6px 9px;color:inherit;background:var(--dsw-alias-bg-base,#fff);font:inherit}
      .edu-panel input[type=checkbox]{accent-color:var(--dsw-alias-brand-primary,#3864e6)}
      .edu-panel :where(button,input,select,[tabindex]):focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3864e6);outline-offset:2px}
      .edu-button{min-height:30px;max-width:100%;border:1px solid var(--dsw-alias-border-l2,#cbd2df);border-radius:7px;padding:4px 9px;font:inherit;font-size:13px;color:inherit;background:var(--dsw-alias-bg-base,#fff);cursor:pointer}
      .edu-button:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover,#f0f3fa)}
      .edu-primary,.edu-primary:not(:disabled):hover{color:#fff;background:var(--dsw-alias-brand-primary,#2852c9);border-color:transparent}
      .edu-primary:not(:disabled):hover{filter:brightness(.92)}
      .edu-button:disabled{opacity:.5;cursor:default}
      .edu-danger,.edu-error{color:var(--dsw-alias-state-error-primary,#b3261e)}
      .edu-accounts,.edu-batch-list,.edu-event-list{padding:0;display:grid;gap:8px;list-style:none}
      .edu-accounts li{padding:8px;border:1px solid var(--dsw-alias-border-l2,#dce1e8);border-radius:8px}
      .edu-accounts li>p{font-size:12px;margin:0 0 7px}
      .edu-account-button{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;text-align:left;margin-bottom:6px}
      .edu-account-button[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary,#3864e6);font-weight:600}
      .edu-wrap{overflow-wrap:anywhere}
      .edu-pill{display:inline-flex;align-items:center;min-height:22px;padding:0 7px;border-radius:20px;background:var(--dsw-alias-bg-layer-2,#eff1f6);white-space:nowrap;font-size:12px}
      .edu-pill[data-status=ready],.edu-pill[data-status=passed]{color:var(--dsw-alias-state-success-primary,#11613d)}
      .edu-pill[data-status=manual],.edu-pill[data-status=auth_required],.edu-pill[data-status=failed]{color:var(--dsw-alias-state-error-primary,#b3261e)}
      .edu-pill[data-status=queued],.edu-pill[data-status=running]{color:var(--dsw-alias-brand-text,#2852c9)}
      .edu-batch,.edu-log{display:grid;gap:10px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2,#dce1e8)}
      .edu-batch-list li,.edu-notice,.edu-confirm,.edu-empty{padding:8px;border-radius:7px;background:var(--dsw-alias-bg-layer-1,#f6f7fb)}
      .edu-confirm{margin-top:8px}
      .edu-confirm p{margin-bottom:6px}
      .edu-inline-form{display:flex;gap:6px;align-items:end}
      .edu-inline-form input{max-width:110px}
      .edu-inline-form button{min-height:36px}
      .edu-queue-controls{grid-template-columns:minmax(0,1fr) minmax(110px,180px)}
      .edu-selection{padding:4px 0}
      .edu-table-scroll{overflow:auto}
      .edu-queue table{width:100%;border-collapse:collapse;text-align:left;font-size:13px}
      .edu-queue :where(th,td){padding:8px 6px;border-bottom:1px solid var(--dsw-alias-border-l2,#dce1e8);vertical-align:middle}
      .edu-queue th{white-space:nowrap;font-weight:500;color:var(--dsw-alias-label-secondary,#525d70)}
      .edu-queue td:nth-child(2){min-width:74px}
      .edu-queue td:nth-child(3){min-width:100px}
      .edu-queue td:nth-child(5){min-width:114px}
      .edu-queue td:nth-child(6){min-width:106px}
      .edu-event-list li{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px}
      .edu-event-list time{color:var(--dsw-alias-label-secondary,#525d70)}
      @media(max-width:480px){.edu-queue-controls{grid-template-columns:1fr}.edu-page-heading{align-items:flex-start}}
    `;

    function Icon({ size = 16 }) {
      return h('span', { 'aria-hidden': true, style: { fontSize: size, lineHeight: 1 } }, '▤');
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
