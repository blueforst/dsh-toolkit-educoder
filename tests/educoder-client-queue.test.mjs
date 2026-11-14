import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';

function createClientHarness(initialTasks, { courses = [], homeworks = {} } = {}) {
  let tasks = structuredClone(initialTasks);
  const accounts = [
    { id: 'acc-1', label: 'al***1', status: 'ready', updatedAt: '2026-11-14T00:00:00.000Z' },
  ];
  const componentStates = new Map();
  let activeState = null;
  let hookCursor = 0;
  const cleanups = [];
  let pendingEffects = [];
  let tree = null;
  let rootComponent = null;
  let rootProps = null;
  let scheduled = false;

  function stateFor(path, type) {
    let entry = componentStates.get(path);
    if (!entry || entry.type !== type) {
      entry?.hooks?.forEach(hook => hook?.cleanup?.());
      entry = { type, hooks: [] };
      componentStates.set(path, entry);
    }
    return entry;
  }

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      const flat = [];
      const push = item => {
        if (Array.isArray(item)) item.forEach(push);
        else if (item !== null && item !== undefined && item !== false && item !== true) flat.push(item);
      };
      children.forEach(push);
      return { type, props: props || {}, children: flat };
    },
    useState(initial) {
      const hooks = activeState.hooks;
      const index = hookCursor++;
      if (!(index in hooks)) {
        hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      }
      const slot = hooks[index];
      const setState = value => {
        const next = typeof value === 'function' ? value(slot.value) : value;
        if (!Object.is(next, slot.value)) {
          slot.value = next;
          scheduleRender();
        }
      };
      return [slot.value, setState];
    },
    useRef(initial) {
      const hooks = activeState.hooks;
      const index = hookCursor++;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    },
    useMemo(factory, deps) {
      const hooks = activeState.hooks;
      const index = hookCursor++;
      const prev = hooks[index];
      if (!prev || !deps || deps.some((dep, i) => !Object.is(dep, prev.deps[i]))) {
        hooks[index] = { value: factory(), deps };
      }
      return hooks[index].value;
    },
    useEffect(effect, deps) {
      const hooks = activeState.hooks;
      const index = hookCursor++;
      const prev = hooks[index];
      const changed = !prev || !deps || deps.some((dep, i) => !Object.is(dep, prev.deps[i]));
      if (changed) {
        pendingEffects.push(() => {
          prev?.cleanup?.();
          const cleanup = effect();
          hooks[index] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
        });
      }
    },
    useId() {
      const hooks = activeState.hooks;
      const index = hookCursor++;
      if (!(index in hooks)) hooks[index] = `edu-id-${activeState.type.name}-${index}`;
      return hooks[index];
    },
  };

  function expand(node, path, visited) {
    if (node === null || node === undefined || typeof node === 'string' || typeof node === 'number') return node;
    if (Array.isArray(node)) {
      return node.map((child, idx) => expand(child, `${path}[${idx}]`, visited));
    }
    if (node.type === React.Fragment) {
      return {
        type: 'fragment',
        props: {},
        children: node.children.map((child, idx) => expand(child, `${path}.f[${idx}]`, visited)).flat(),
      };
    }
    if (typeof node.type === 'function') {
      const key = node.props?.key !== undefined ? `${path}#${node.props.key}` : path;
      visited.add(key);
      const prevState = activeState;
      const prevCursor = hookCursor;
      activeState = stateFor(key, node.type);
      hookCursor = 0;
      const rendered = node.type({ ...node.props, children: node.children });
      activeState = prevState;
      hookCursor = prevCursor;
      return expand(rendered, `${key}.c`, visited);
    }
    return {
      type: node.type,
      props: node.props,
      children: node.children.map((child, idx) => expand(child, `${path}.${String(node.type)}[${idx}]`, visited)).flat(),
    };
  }

  function renderNow() {
    scheduled = false;
    pendingEffects = [];
    const visited = new Set();
    tree = expand(React.createElement(rootComponent, rootProps), 'root', visited);
    for (const [key, entry] of componentStates) {
      if (!visited.has(key)) {
        entry.hooks.forEach(hook => hook?.cleanup?.());
        componentStates.delete(key);
      }
    }
    const effects = pendingEffects;
    pendingEffects = [];
    for (const runEffect of effects) runEffect();
  }

  function scheduleRender() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      if (scheduled) renderNow();
    });
  }

  function findAll(node, predicate, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (predicate(node)) out.push(node);
    if (Array.isArray(node.children)) node.children.forEach(child => findAll(child, predicate, out));
    return out;
  }

  function textOf(node) {
    if (node === null || node === undefined || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(textOf).join('');
    return (node.children || []).map(textOf).join('');
  }

  let definition;
  const styles = [];
  const slots = [];
  const timers = new Set();
  const sandbox = {
    URL,
    AbortController,
    AbortSignal,
    Date,
    Map,
    Set,
    Math,
    Number,
    String,
    Array,
    Object,
    JSON,
    Promise,
    Error,
    RegExp,
    queueMicrotask,
    setTimeout(fn, ms) {
      const id = globalThis.setTimeout(fn, ms);
      timers.add(id);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
      globalThis.clearTimeout(id);
    },
    setInterval(fn, ms) {
      const id = globalThis.setInterval(fn, ms);
      timers.add(id);
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
      globalThis.clearInterval(id);
    },
    window: { __ModuleLoader__: { load: value => { definition = value; } } },
    document: {
      visibilityState: 'visible',
      createElement: () => ({ dataset: {}, textContent: '', remove() { this.removed = true; } }),
      head: { append: element => styles.push(element) },
      addEventListener() {},
      removeEventListener() {},
    },
    async fetch(_url, options) {
      const { action, ...fields } = JSON.parse(options.body);
      let data;
      if (action === 'accounts') data = structuredClone(accounts);
      else if (action === 'tasks') data = structuredClone(tasks);
      else if (action === 'task') data = structuredClone(tasks.find(item => item.id === fields.taskId));
      else if (action === 'settings') data = { concurrency: 2, mode: 'fixture', tasksEnabled: true };
      else if (action === 'courses') data = structuredClone(courses);
      else if (action === 'homeworks') data = structuredClone(homeworks[fields.courseId] || []);
      else if (action === 'control') {
        const updatedAt = '2026-11-14T02:00:00.000Z';
        const updated = [];
        tasks = tasks.map(task => {
          if (!fields.taskIds.includes(task.id)) return task;
          const next = { ...task, status: fields.command === 'start' ? 'queued' : task.status, updatedAt };
          updated.push(next);
          return next;
        });
        data = structuredClone(updated);
      } else {
        throw new Error(`unexpected action: ${action}`);
      }
      return { ok: true, async json() { return { ok: true, data }; } };
    },
  };

  const source = readFileSync(new URL('../plugins/educoder/client.js', import.meta.url), 'utf8');
  runInNewContext(source, sandbox);
  const plugin = definition.factory(name => {
    if (name === 'react') return React;
    throw new Error(`unexpected dependency: ${name}`);
  });
  plugin.apply({
    effect: cb => cleanups.push(cb()),
    slots: {
      inject: (_name, cb) => cb(),
      register: (spec, component) => {
        slots.push({ spec, component });
        return spec;
      },
    },
    sessions: { async refresh() {} },
    uiWorkspace: { openSession() {} },
  });

  const mainSlot = slots.find(slot => slot.spec.name === 'main');
  rootComponent = mainSlot.component;
  rootProps = mainSlot.spec.inject();
  renderNow();

  return {
    getTree: () => tree,
    findAll: predicate => findAll(tree, predicate),
    textOf,
    async flush() {
      await delay(15);
      if (scheduled) renderNow();
    },
    dispose() {
      scheduled = false;
      for (const entry of componentStates.values()) {
        entry.hooks.forEach(hook => hook?.cleanup?.());
      }
      componentStates.clear();
      for (const id of timers) {
        globalThis.clearTimeout(id);
        globalThis.clearInterval(id);
      }
      for (const cleanup of cleanups) cleanup?.();
    },
  };
}

test('前端任务队列默认按更新时间倒序显示，支持切换排序方式并实时维持时间顺序', async t => {
  const unsortedFromApi = [
    {
      id: 't-old',
      accountId: 'acc-1',
      courseId: 'c1',
      homeworkId: '1',
      courseTitle: '课程 A',
      homeworkTitle: '旧作业',
      status: 'passed',
      code: null,
      createdAt: '2026-11-13T08:00:00.000Z',
      updatedAt: '2026-11-13T08:05:00.000Z',
    },
    {
      id: 't-wait',
      accountId: 'acc-1',
      courseId: 'c1',
      homeworkId: '2',
      courseTitle: '课程 A',
      homeworkTitle: '待启动旧作业',
      status: 'waiting',
      code: null,
      createdAt: '2026-11-13T09:00:00.000Z',
      updatedAt: '2026-11-13T09:00:00.000Z',
    },
    {
      id: 't-oldest-create-newest-update',
      accountId: 'acc-1',
      courseId: 'c1',
      homeworkId: '3',
      courseTitle: '课程 A',
      homeworkTitle: '最早创建但刚更新',
      status: 'failed',
      code: 'verification_failed',
      createdAt: '2026-11-13T07:00:00.000Z',
      updatedAt: '2026-11-14T01:15:00.000Z',
    },
    {
      id: 't-new-create',
      accountId: 'acc-1',
      courseId: 'c1',
      homeworkId: '4',
      courseTitle: '课程 A',
      homeworkTitle: '最新创建运行中',
      status: 'running',
      code: null,
      createdAt: '2026-11-14T01:05:00.000Z',
      updatedAt: '2026-11-14T01:10:00.000Z',
    },
  ];

  const harness = createClientHarness(unsortedFromApi);
  t.after(() => harness.dispose());
  await harness.flush();

  const queueTab = harness.findAll(node => node.type === 'button' && harness.textOf(node).includes('任务队列'))[0];
  assert.ok(queueTab);
  queueTab.props.onClick();
  await harness.flush();

  const rowTitles = () => harness.findAll(node => node.type === 'tbody')[0]
    .children.map(row => harness.textOf(row.children[1].children[0]));

  assert.deepEqual(rowTitles(), [
    '最早创建但刚更新',
    '最新创建运行中',
    '待启动旧作业',
    '旧作业',
  ]);

  const sortSelect = harness.findAll(node => node.type === 'select' && node.props['aria-label'] === '队列排序')[0];
  assert.equal(sortSelect.props.value, 'updated-desc');

  const timeHeaderTh = harness.findAll(node => node.type === 'th' && node.props.className === 'edu-col-time')[0];
  assert.equal(timeHeaderTh.props['aria-sort'], 'descending');

  const timeHeaderButton = harness.findAll(node => node.type === 'button' && node.props.className === 'edu-th-sort')[0];
  timeHeaderButton.props.onClick();
  await harness.flush();
  assert.equal(
    harness.findAll(node => node.type === 'th' && node.props.className === 'edu-col-time')[0].props['aria-sort'],
    'ascending',
  );
  assert.deepEqual(rowTitles(), [
    '旧作业',
    '待启动旧作业',
    '最新创建运行中',
    '最早创建但刚更新',
  ]);

  harness.findAll(node => node.type === 'select' && node.props['aria-label'] === '队列排序')[0]
    .props.onChange({ target: { value: 'created-desc' } });
  await harness.flush();
  assert.deepEqual(rowTitles(), [
    '最新创建运行中',
    '待启动旧作业',
    '旧作业',
    '最早创建但刚更新',
  ]);

  harness.findAll(node => node.type === 'select' && node.props['aria-label'] === '队列排序')[0]
    .props.onChange({ target: { value: 'created-asc' } });
  await harness.flush();
  assert.deepEqual(rowTitles(), [
    '最早创建但刚更新',
    '旧作业',
    '待启动旧作业',
    '最新创建运行中',
  ]);

  harness.findAll(node => node.type === 'select' && node.props['aria-label'] === '队列排序')[0]
    .props.onChange({ target: { value: 'status' } });
  await harness.flush();
  assert.deepEqual(rowTitles(), [
    '最新创建运行中',
    '待启动旧作业',
    '最早创建但刚更新',
    '旧作业',
  ]);

  harness.findAll(node => node.type === 'select' && node.props['aria-label'] === '队列排序')[0]
    .props.onChange({ target: { value: 'updated-desc' } });
  await harness.flush();

  const waitRow = harness.findAll(node => node.type === 'tbody')[0].children
    .find(row => harness.textOf(row).includes('待启动旧作业'));
  const startButton = harness.findAll(node => node.type === 'button' && harness.textOf(node) === '启动')
    .find(btn => waitRow.children.at(-1).children[0].children.includes(btn));
  assert.ok(startButton);
  startButton.props.onClick();
  await harness.flush();

  assert.deepEqual(rowTitles(), [
    '待启动旧作业',
    '最早创建但刚更新',
    '最新创建运行中',
    '旧作业',
  ]);
});

test('pending_review 状态显示为琥珀色「待评审」和客观题待评审说明，不计入异常角标且保留恢复与取消操作', async t => {
  const harness = createClientHarness([
    {
      id: 't-review',
      accountId: 'acc-1',
      courseId: 'c1',
      homeworkId: '5',
      courseTitle: '课程 A',
      homeworkTitle: '作业 5',
      status: 'pending_review',
      code: 'choice_result_hidden',
      createdAt: '2026-11-14T01:00:00.000Z',
      updatedAt: '2026-11-14T01:05:00.000Z',
      attempts: 1,
      sessionId: 'sess-review-1',
    },
  ]);
  t.after(() => harness.dispose());
  await harness.flush();

  const queueTab = harness.findAll(node => node.type === 'button' && harness.textOf(node).includes('任务队列'))[0];
  assert.ok(queueTab);
  assert.equal(harness.textOf(queueTab).includes('异常'), false);
  queueTab.props.onClick();
  await harness.flush();

  const reviewChip = harness.findAll(node => node.type === 'button' &&
    node.props.className?.includes('edu-q-chip') && harness.textOf(node).includes('待评审'))[0];
  assert.ok(reviewChip);
  assert.match(harness.textOf(reviewChip), /待评审\s*1/);

  const row = harness.findAll(node => node.type === 'tbody')[0].children[0];
  const pill = harness.findAll(node => node.type === 'span' && node.props.className?.includes('edu-pill'))
    .find(node => harness.textOf(node) === '待评审');
  assert.ok(pill);
  assert.equal(pill.props['data-tone'], 'amber');
  assert.ok(harness.textOf(row).includes('客观题已提交，平台未公开结果，待评审。'));

  const rowResume = harness.findAll(node => node.type === 'button' && harness.textOf(node) === '恢复')[0];
  assert.ok(rowResume);

  row.props.onClick({ target: {} });
  await harness.flush();

  const callout = harness.findAll(node => node.type === 'div' && node.props.className?.includes('edu-drawer-callout'))[0];
  assert.ok(callout);
  assert.ok(callout.props.className.includes('warn'));
  assert.ok(harness.textOf(callout).includes('客观题已提交，平台未公开结果，待评审。'));
  assert.ok(harness.findAll(node => node.type === 'button' && harness.textOf(node) === '恢复执行')[0]);
  assert.ok(harness.findAll(node => node.type === 'button' && harness.textOf(node) === '取消任务')[0]);
});

test('pending_review 在课程目录中计入已完成进度、已通关筛选，并使全部完成/待评审课程禁用一键通关', async t => {
  const harness = createClientHarness(
    [
      {
        id: 't-review',
        accountId: 'acc-1',
        courseId: 'c1',
        homeworkId: '5',
        courseTitle: '课程 A',
        homeworkTitle: '客观选择题 5',
        status: 'pending_review',
        code: 'choice_result_hidden',
        createdAt: '2026-11-14T01:00:00.000Z',
        updatedAt: '2026-11-14T01:05:00.000Z',
        attempts: 1,
      },
    ],
    {
      courses: [{ id: 'c1', title: '课程 A' }],
      homeworks: {
        c1: [
          { id: '5', title: '客观选择题 5', taskCount: 1, passedCount: 0 },
          { id: '6', title: '编程作业 6', taskCount: 2, passedCount: 2 },
        ],
      },
    },
  );
  t.after(() => harness.dispose());
  await harness.flush();

  const meterText = harness.findAll(node => node.type === 'span' && node.props.className?.includes('edu-meter-text'))[0];
  assert.equal(harness.textOf(meterText), '3/3 关');

  const pendingPill = harness.findAll(node => node.type === 'button' &&
    node.props.className?.includes('edu-seg-pill') && harness.textOf(node).includes('未通关'))[0];
  const donePill = harness.findAll(node => node.type === 'button' &&
    node.props.className?.includes('edu-seg-pill') && harness.textOf(node).includes('已通关'))[0];
  assert.match(harness.textOf(pendingPill), /未通关\s*0/);
  assert.match(harness.textOf(donePill), /已通关\s*2/);

  const startCourseBtn = harness.findAll(node => node.type === 'button' && harness.textOf(node).includes('一键通关'))[0];
  assert.equal(startCourseBtn.props.disabled, true);

  donePill.props.onClick();
  await harness.flush();
  const options = harness.findAll(node => node.type === 'div' && node.props.role === 'option');
  assert.equal(options.length, 2);
  assert.ok(harness.textOf(options[0]).includes('客观选择题 5'));
  assert.ok(harness.textOf(options[0]).includes('已完成'));
  assert.ok(harness.textOf(options[0]).includes('待评审'));
});
