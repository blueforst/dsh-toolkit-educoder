// 使用 Chromium 与 Playwright 验收隔离 DSH 实例。
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';

const url = process.env.DSH_EDUCODER_SMOKE_URL;

function fixtureIdentity(group, name) {
  const login = 'educoder-' + group + '-' + name;
  const user = Number.parseInt(createHash('sha256').update(login).digest('hex').slice(0, 11), 16) + 1;
  const key = 'fixture-' + user;
  return {
    login, user, password: 'fake-password-' + login,
    course: 'course-' + key, courseTitle: '模拟课程 ' + key,
    homework: String(user + 1), homeworkTitle: '模拟作业 ' + key,
    game: 'game-' + key,
  };
}

async function fixtureEvidence(group) {
  const evidence = await fetch('http://127.0.0.1:9299/fixture/evidence?group=' + group, {
    signal: AbortSignal.timeout(4000),
  });
  assert.equal(evidence.status, 200, '需要测试替身');
  return evidence.json();
}

test('DSH 原生 EduCoder 面板支持跨账号批量和指定课程一键通关', { skip: !url, timeout: 150_000 }, async () => {
  const bootstrap = new URL(url);
  const token = bootstrap.searchParams.get('token');
  assert.equal(bootstrap.protocol, 'http:', '浏览器验收仅限隔离 DSH 实例');
  assert.equal(bootstrap.hostname, '127.0.0.1', '浏览器验收仅限回环地址');
  assert.equal(bootstrap.pathname, '/');
  assert.match(token || '', /^[A-Za-z0-9_-]+$/, '需要测试实例启动凭据');

  const group = 'ui-' + randomBytes(5).toString('hex');
  const identities = ['alice', 'bob'].map(name => fixtureIdentity(group, name));
  const courseGroup = 'course-ui-' + randomBytes(5).toString('hex');
  const courseIdentities = ['alice', 'bob'].map(name => fixtureIdentity(courseGroup, name));
  const initial = await fixtureEvidence(group);
  assert.deepEqual(initial.accounts, [], '测试账号应独立于已有验收状态');
  const playwright = process.env.DSH_EDUCODER_PLAYWRIGHT || 'playwright-core';
  const { chromium } = await import(playwright);
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox'],
  });

  let stage = 'load';
  const pageErrors = [];
  try {
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => pageErrors.push(error.message));
    const responses = [];
    const changes = [];
    const reads = new Set(['accounts', 'courses', 'homeworks', 'tasks', 'task']);
    function actionOf(request) {
      return new URL(request.url()).pathname === '/dsh-educoder/api' ? request.postDataJSON() : null;
    }
    page.on('request', request => {
      const data = actionOf(request);
      if (data && !reads.has(data.action) && !(data.action === 'settings' && !Object.hasOwn(data, 'concurrency'))) {
        changes.push(data.action);
      }
    });
    page.on('response', response => {
      if (new URL(response.url()).pathname === '/dsh-educoder/api') {
        responses.push(response.text().catch(() => ''));
      }
    });
    const button = name => page.getByRole('button', { name, exact: true });
    const panel = page.locator('.edu-panel');
    const mainNav = panel.getByRole('navigation', { name: '主工作区切换' });
    const matchingRows = () => identities.map(identity =>
      panel.getByRole('row').filter({ hasText: identity.homeworkTitle }));

    async function readAction(action, trigger) {
      const response = await Promise.all([
        page.waitForResponse(item => actionOf(item.request())?.action === action),
        trigger(),
      ]).then(([item]) => item);
      assert.equal(response.status(), 200);
      return (await response.json()).data;
    }

    async function openPanel() {
      const continueButton = button('继续');
      if (await continueButton.isVisible()) await continueButton.click();
      await button('EduCoder').click();
      await page.locator('.edu-panel[aria-busy="false"]').waitFor();
    }

    async function bind(identity) {
      const addTrigger = button('绑定第一个账号').or(button('添加 EduCoder 账号'));
      await addTrigger.first().click();
      const dialog = page.getByRole('dialog');
      const login = dialog.getByLabel('用户名、手机号或邮箱');
      const password = dialog.getByLabel('密码', { exact: true });
      assert.equal(await password.getAttribute('type'), 'password');
      await login.fill(identity.login);
      await password.fill(identity.password);
      const account = await readAction('addAccount', () => dialog.getByRole('button', { name: '验证并绑定', exact: true }).click());
      await dialog.waitFor({ state: 'hidden' });
      return account;
    }

    await page.goto(bootstrap.href, { waitUntil: 'domcontentloaded' });
    const settings = await readAction('settings', openPanel);
    assert.equal(settings.mode, 'fixture', '只能在模拟实例上添加测试账号');
    assert.equal(settings.tasksEnabled, true, '模拟实例需要启用作业执行');
    assert.equal(changes.length, 0);

    stage = 'select_two_accounts';
    const accounts = [];
    for (const identity of identities) {
      accounts.push(await bind(identity));

      const courseTabs = panel.getByRole('tablist', { name: '课程快速切换' });
      const course = courseTabs.getByRole('tab', { name: new RegExp(identity.courseTitle) });
      await course.click();
      assert.equal(await course.getAttribute('aria-selected'), 'true');
      assert.equal(await courseTabs.getByRole('tab').count(), 1, '当前账号只显示自己的课程');

      const homeworkList = panel.getByRole('listbox', { name: '作业列表' });
      const homework = homeworkList.getByRole('option', { name: new RegExp(identity.homeworkTitle) });
      await homework.waitFor();
      assert.equal(await homeworkList.getByRole('option').count(), 1, '当前账号只显示自己的作业');
      await homework.getByRole('checkbox').check();
      assert.equal(await homework.getAttribute('aria-selected'), 'true');
    }
    assert.notEqual(accounts[0].id, accounts[1].id);
    const batchBar = panel.getByRole('region', { name: '批量作业操作' });
    await batchBar.getByText('跨 2 个账号').waitFor();

    stage = 'allocate';
    const allocationRequest = page.waitForRequest(item => actionOf(item)?.action === 'allocate');
    const tasks = await readAction('allocate', () => batchBar.getByRole('button', { name: '待启动', exact: true }).click());
    assert.deepEqual((await allocationRequest).postDataJSON(), {
      action: 'allocate',
      start: false,
      targets: identities.map((identity, index) => ({
        accountId: accounts[index].id, courseId: identity.course, homeworkId: identity.homework,
      })),
    });
    await mainNav.getByRole('button', { name: /任务队列/ }).click();
    const rows = matchingRows();
    for (const row of rows) {
      await row.getByText('待启动', { exact: true }).waitFor();
      await row.getByRole('checkbox').check();
    }

    stage = 'start_and_verify';
    const startRequest = page.waitForRequest(item => actionOf(item)?.action === 'control');
    await readAction('control', () => button('批量启动').click());
    const { command, taskIds } = (await startRequest).postDataJSON();
    assert.equal(command, 'start');
    assert.deepEqual(new Set(taskIds), new Set(tasks.map(task => task.id)));
    for (const row of rows) await row.getByText('已通过', { exact: true }).waitFor({ timeout: 75000 });
    const verified = await fixtureEvidence(group);
    assert.equal(verified.accounts.length, 2);
    assert.ok(verified.accounts.every(account => account.saves === 1 && account.builds === 1 && account.readback > 0));

    stage = 'native_session';
    const detail = await readAction('task', () => rows[0].getByRole('button', { name: '记录', exact: true }).click());
    assert.equal(detail.id, tasks.find(task => task.homeworkId === identities[0].homework).id);
    assert.match(detail.sessionId, /^[0-9a-f-]{36}$/iu);
    const log = panel.getByRole('region', { name: '任务记录' });
    await log.getByText('已通过', { exact: true }).first().waitFor();
    await log.getByRole('button', { name: /进入 Agent 会话/ }).click();
    await panel.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: /收到执行请求/ }).click();
    await page.getByText('SMOKE_TARGET=' + identities[0].game, { exact: false }).first().waitFor();
    await page.getByText('模拟平台已返回评测结果。', { exact: true }).last().waitFor();

    stage = 'reload_and_redaction';
    const previous = changes.length;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openPanel();
    await mainNav.getByRole('button', { name: /任务队列/ }).click();
    for (const row of matchingRows()) await row.getByText('已通过', { exact: true }).waitFor();
    assert.equal(changes.length, previous, '刷新不应触发任何写操作');

    stage = 'start_selected_course';
    assert.deepEqual((await fixtureEvidence(courseGroup)).accounts, []);
    await mainNav.getByRole('button', { name: '课程与作业', exact: true }).click();
    await bind(courseIdentities[1]);
    const selectedAccount = await bind(courseIdentities[0]);
    const selected = courseIdentities[0];
    const otherCourse = 'course-fixture-' + (selected.user + 30);
    const completedId = String(selected.user + 21);
    const targetIds = [selected.homework, String(selected.user + 11)];
    const targetTitles = [selected.homeworkTitle, '模拟作业 fixture-' + (selected.user + 10)];
    const tabs = panel.getByRole('tablist', { name: '课程快速切换' });
    await tabs.getByRole('tab', { name: new RegExp('模拟课程 fixture-' + (selected.user + 30)) }).click();
    const selectedTab = tabs.getByRole('tab', { name: new RegExp(selected.courseTitle) });
    await selectedTab.click();
    assert.equal(await selectedTab.getAttribute('aria-selected'), 'true');
    const list = panel.getByRole('listbox', { name: '作业列表' });
    await list.getByRole('option', { name: new RegExp(selected.homeworkTitle) }).waitFor();
    assert.equal(await list.getByRole('option').count(), 3);
    await panel.getByRole('button', { name: /^已通关\s+1$/u }).click();
    await list.getByRole('option', { name: new RegExp('模拟作业 fixture-' + (selected.user + 20)) }).waitFor();
    assert.equal(await list.getByRole('option').count(), 1);

    const courseRequest = page.waitForRequest(item => actionOf(item)?.action === 'startCourse');
    const courseResult = await readAction('startCourse', () => button('一键通关').click());
    assert.deepEqual((await courseRequest).postDataJSON(), {
      action: 'startCourse', accountId: selectedAccount.id, courseId: selected.course,
    });
    assert.equal(courseResult.started, 2);
    assert.equal(courseResult.skippedCompleted, 1);
    assert.equal(courseResult.skippedExisting, 0);
    assert.deepEqual(new Set(courseResult.tasks.map(task => task.homeworkId)), new Set(targetIds));
    assert.ok(courseResult.tasks.every(task => task.accountId === selectedAccount.id && task.courseId === selected.course));
    await page.getByText(/已启动 2 项作业.*已通关 1 项/u).waitFor();
    await mainNav.getByRole('button', { name: /任务队列/ }).click();
    for (const title of targetTitles) {
      await panel.getByRole('row').filter({ hasText: title }).getByText('已通过', { exact: true }).waitFor({ timeout: 75000 });
    }
    const courseEvidence = await fixtureEvidence(courseGroup);
    assert.equal(courseEvidence.accounts.length, 5);
    for (const assignment of courseEvidence.accounts) {
      if (targetIds.includes(assignment.homework)) {
        assert.equal(assignment.course, selected.course);
        assert.equal(assignment.passed, true);
        assert.equal(assignment.saves, 1);
        assert.equal(assignment.builds, 1);
        assert.ok(assignment.readback > 0);
      } else {
        assert.ok([selected.course, otherCourse, courseIdentities[1].course].includes(assignment.course));
        assert.equal(assignment.passed, assignment.homework === completedId);
        assert.equal(assignment.saves, 0);
        assert.equal(assignment.builds, 0);
        assert.equal(assignment.modelCalls, 0);
      }
    }

    const sensitive = [token, ...[...identities, ...courseIdentities].flatMap(({ login, password }) => [login, password]),
      'private-auto-', 'private-session-', 'private-proof-', 'never-project-private-test'];
    const values = [await panel.innerText(), ...await Promise.all(responses)];
    assert.ok(values.every(value => sensitive.every(secret => !value.includes(secret))), '浏览器收到了不应显示的字段');
    assert.deepEqual(pageErrors, []);
    console.log(JSON.stringify({ status: 'passed', accounts: 2, verifiedSubmissions: 2, nativeSession: true,
      courseSubmissions: 2, courseSkippedCompleted: 1, courseScoped: true, reloadReadOnly: true, credentialsRedacted: true }));
  } catch (failure) {
    let message = String(failure.message || '');
    for (const secret of [token, ...[...identities, ...courseIdentities].flatMap(({ login, password }) => [login, password])]) {
      message = message.replaceAll(secret, '[已隐藏]');
    }
    throw new Error(stage + ' · ' + message.slice(0, 600));
  } finally {
    await browser.close();
  }
});
