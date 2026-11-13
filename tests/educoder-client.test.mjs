// 在装有 Chromium 与 Playwright 的隔离 DSH 测试容器内运行。
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';

const url = process.env.DSH_EDUCODER_SMOKE_URL;

test('DSH 原生 EduCoder 面板独立读取两个账号并显示真实会话', { skip: !url, timeout: 150_000 }, async () => {
  const bootstrap = new URL(url);
  const token = bootstrap.searchParams.get('token');
  assert.equal(bootstrap.origin, 'http://127.0.0.1:3080', '浏览器验收仅限 DSH 容器内回环地址');
  assert.equal(bootstrap.pathname, '/');
  assert.match(token || '', /^[A-Za-z0-9_-]+$/, '需要测试实例启动凭据');

  const group = 'ui-' + randomBytes(5).toString('hex');
  const identities = ['alice', 'bob'].map(name => {
    const login = 'educoder-' + group + '-' + name;
    const user = Number.parseInt(createHash('sha256').update(login).digest('hex').slice(0, 11), 16) + 1;
    return { login, password: 'fake-password-' + login, course: 'course-fixture-' + user, homework: String(user + 1) };
  });
  const evidence = await fetch('http://127.0.0.1:9299/fixture/evidence?group=' + group, {
    signal: AbortSignal.timeout(4000),
  });
  assert.equal(evidence.status, 200, '需要测试替身');
  const initial = await evidence.json();
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
    const loginForm = page.locator('.edu-form');
    const picker = panel.getByRole('region', { name: '选择作业' });
    const course = picker.getByRole('combobox', { name: '课程', exact: true });
    const homework = picker.getByRole('combobox', { name: '作业', exact: true });
    const batch = panel.locator('.edu-batch-list');
    const matchingRows = () => identities.map(identity =>
      panel.getByRole('row').filter({ hasText: '模拟作业 fixture-' + (Number(identity.homework) - 1) }));

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
      await panel.getByRole('heading', { name: '账号', exact: true }).waitFor();
    }

    await page.goto(bootstrap.href, { waitUntil: 'domcontentloaded' });
    await openPanel();
    assert.equal(changes.length, 0);

    stage = 'select_two_accounts';
    const accounts = [];
    for (const identity of identities) {
      const login = loginForm.getByLabel('用户名、手机号或邮箱');
      const password = loginForm.getByLabel('密码', { exact: true });
      assert.equal(await password.getAttribute('type'), 'password');
      await login.fill(identity.login);
      await password.fill(identity.password);
      accounts.push(await readAction('addAccount', () => loginForm.getByRole('button', { name: '添加账号', exact: true }).click()));
      assert.equal(await password.inputValue(), '');
      await course.selectOption(identity.course);
      await homework.selectOption(identity.homework);
      await button('加入批量').click();
      assert.equal(await course.getByRole('option').count(), 2, '当前账号只显示自己的课程');
      assert.equal(await homework.getByRole('option').count(), 2, '当前账号只显示自己的作业');
    }
    assert.notEqual(accounts[0].id, accounts[1].id);
    assert.equal(await batch.getByRole('listitem').count(), 2);

    stage = 'allocate';
    const allocationRequest = page.waitForRequest(item => actionOf(item)?.action === 'allocate');
    await readAction('allocate', () => button('分配为待启动').click());
    assert.deepEqual((await allocationRequest).postDataJSON(), {
      action: 'allocate',
      start: false,
      targets: identities.map((identity, index) => ({
        accountId: accounts[index].id, courseId: identity.course, homeworkId: identity.homework,
      })),
    });
    const rows = matchingRows();
    for (const row of rows) {
      await row.getByText('待启动', { exact: true }).waitFor();
      await row.getByRole('checkbox').check();
    }

    stage = 'start_and_verify';
    await readAction('control', () => button('批量启动').click());
    for (const row of rows) await row.getByText('已通过', { exact: true }).waitFor({ timeout: 75000 });
    const after = await fetch('http://127.0.0.1:9299/fixture/evidence?group=' + group, { signal: AbortSignal.timeout(4000) });
    assert.equal(after.status, 200);
    const verified = await after.json();
    assert.equal(verified.accounts.length, 2);
    assert.ok(verified.accounts.every(account => account.saves === 1 && account.builds === 1 && account.readback > 0));

    stage = 'native_session';
    await rows[0].getByRole('button', { name: '记录', exact: true }).click();
    const log = panel.getByRole('region', { name: '任务记录' });
    await log.getByText('已通过', { exact: true }).first().waitFor();
    await rows[0].getByRole('button', { name: '会话', exact: true }).click();
    await panel.waitFor({ state: 'hidden' });
    await page.getByText('模拟平台已返回评测结果。', { exact: true }).last().waitFor();

    stage = 'reload_and_redaction';
    const previous = changes.length;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openPanel();
    for (const row of matchingRows()) await row.getByText('已通过', { exact: true }).waitFor();
    assert.equal(changes.length, previous, '刷新不应触发任何写操作');
    const sensitive = [token, ...identities.flatMap(({ login, password }) => [login, password]),
      'private-auto-', 'private-session-', 'private-proof-', 'never-project-private-test'];
    const values = [await panel.innerText(), ...await Promise.all(responses)];
    assert.ok(values.every(value => sensitive.every(secret => !value.includes(secret))), '浏览器收到了不应显示的字段');
    assert.deepEqual(pageErrors, []);
    console.log(JSON.stringify({ status: 'passed', accounts: 2, verifiedSubmissions: 2, nativeSession: true,
      reloadReadOnly: true, credentialsRedacted: true }));
  } catch (failure) {
    let message = String(failure.message || '');
    for (const secret of [token, ...identities.flatMap(({ login, password }) => [login, password])]) {
      message = message.replaceAll(secret, '[已隐藏]');
    }
    throw new Error(stage + ' · ' + message.slice(0, 600));
  } finally {
    await browser.close();
  }
});
