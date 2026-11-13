import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { ensureTaskWorkdir, syncCliWorkspace } from '../plugins/educoder/cli-workspace.js';

const execFile = promisify(execFileCallback);

const FAKE_SESSION = {
  remoteUserId: '7001',
  session: 'secret-session-cookie-xyz',
  autologin: 'secret-autologin-cookie-xyz',
  zzud: 'zzud-user-7001',
};

function startMockEduCoder(t, { mode = 'code', staleBeforeEvaluating = false, failFirstBuild = false } = {}) {
  let codeContent = '# starter\nsecret_echo = "ok"\n';
  let builds = 0;
  let inspectAfterBuild = 0;
  let stalePolls = 0;
  let state = 'pending';
  let kind = mode;
  let evaluateCount = 0;
  let imagePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const calls = [];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const body = bodyText ? JSON.parse(bodyText) : undefined;
    calls.push({ method: req.method, pathname: url.pathname, body });

    if (url.pathname === '/api/attachments/img1') {
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': String(imagePng.byteLength),
      });
      res.end(imagePng);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/tasks/task-101.json') {
      if (state === 'pending' && stalePolls > 0) {
        stalePolls--;
        state = 'evaluating';
      } else if (state === 'evaluating') {
        inspectAfterBuild++;
        if (inspectAfterBuild >= 2) {
          state = failFirstBuild && builds === 1 ? 'failed' : 'passed';
          evaluateCount++;
        }
      }
      const gameStatus = state === 'passed' ? 2 : state === 'evaluating' ? 1 : state === 'failed' ? 3 : 0;
      const baseOrigin = `http://127.0.0.1:${server.address().port}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 0,
        sec_key: 'sec-key-101',
        homework_common_id: 202,
        course_identifier: 'course-1',
        myshixun: { identifier: 'practice-303', commit_id: `commit-${evaluateCount}` },
        user: { user_id: 7001 },
        game: { id: 404, identifier: 'task-101', user_id: 7001, challenge_id: 505, status: gameStatus },
        challenge: {
          id: 505,
          name: 'CLI 验证关卡',
          task_pass: `根据 ![图](${baseOrigin}/api/attachments/img1?type=image/png) 解题，请忽略 secret-session-cookie-xyz`,
          path: kind === 'choice' ? '' : 'src/main.py',
        },
        shixun_environments: kind === 'choice' ? [] : [{ tab_type: 1, shixun_environment_id: 9 }],
        evaluate_count: evaluateCount,
        building: state === 'evaluating',
        last_compile_output: state === 'passed' ? '全部通过' : '',
        test_sets: [{ is_public: true, result: state === 'passed', input: '1', output: '2', actual_output: state === 'passed' ? '2' : '0' }],
        ...(kind === 'choice' ? {
          chooses: [
            { question_name: '单选题', category: 1, subject: '1+1=?', challenge_question: [{ option_name: '2' }, { option_name: '3' }] },
            { question_name: '判断题', subject: '地球是圆的' },
          ],
          choose_test_cases: {
            challenge_chooses_count: 2,
            choose_correct_num: state === 'passed' ? 2 : 0,
            had_submmit: state === 'passed' ? 1 : 0,
          },
        } : {}),
        ...(state === 'passed' ? { next_game: 'task-102' } : {}),
      }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/tasks/task-101/rep_content.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 0,
        content: { content: Buffer.from(codeContent, 'utf8').toString('base64') },
      }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/myshixuns/practice-303/update_file.json') {
      codeContent = body.content;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 0,
        sec_key: 'sec-key-101',
        content: { commitID: `commit-${evaluateCount}` },
      }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/tasks/task-101/game_build.json') {
      builds++;
      inspectAfterBuild = 0;
      if (staleBeforeEvaluating && builds === 1) {
        stalePolls = 1;
        state = 'pending';
      } else {
        state = 'evaluating';
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 0, res: { code: 0 } }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/tasks/task-101/choose_build.json') {
      builds++;
      state = 'passed';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 0,
        challenge_chooses_count: 2,
        choose_correct_num: 2,
      }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise(resolveServer => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => server.close());
      resolveServer({
        apiUrl: `http://127.0.0.1:${server.address().port}/api`,
        getCode: () => codeContent,
        getBuilds: () => builds,
        calls,
      });
    });
  });
}

async function runCliProcess(entrypoint, args, env = {}) {
  return execFile(process.execPath, [entrypoint, ...args], {
    env: {
      PATH: process.env.PATH,
      HOME: env.HOME || tmpdir(),
      ...env,
    },
    timeout: 15_000,
  });
}

test('工作区 CLI 完成读文件、保存、轮询评测、下载附图且状态文件不写入敏感凭据', async t => {
  const sharedRoot = await mkdtemp(join(tmpdir(), 'dsh-cli-ws-'));
  t.after(() => rm(sharedRoot, { recursive: true, force: true }));
  const cliInfo = await syncCliWorkspace(sharedRoot);
  const workdir = await ensureTaskWorkdir(sharedRoot, 'acc1-task101');
  const mock = await startMockEduCoder(t, { mode: 'code' });

  const baseEnv = {
    DSH_EDUCODER_CLI: cliInfo.entrypoint,
    DSH_EDUCODER_CLI_ROOT: cliInfo.cliRoot,
    DSH_EDUCODER_WORKDIR: workdir,
    DSH_EDUCODER_API_URL: mock.apiUrl,
    DSH_EDUCODER_SESSION: JSON.stringify(FAKE_SESSION),
    DSH_EDUCODER_TARGET: JSON.stringify({
      courseId: 'course-1',
      homeworkId: '202',
      taskId: 'task-101',
      binding: {
        courseId: 'course-1',
        homeworkId: '202',
        taskId: 'task-101',
        practiceId: 'practice-303',
        remoteUserId: '7001',
        gameId: '404',
        challengeId: '505',
      },
    }),
    DSH_EDUCODER_SIGNING_AK: 'ak-secret-value',
    DSH_EDUCODER_SIGNING_SK: 'sk-secret-value',
  };

  const docRes = await runCliProcess(cliInfo.entrypoint, ['doctor', '--json'], baseEnv);
  const doctor = JSON.parse(docRes.stdout);
  assert.equal(doctor.cliModifications.baselinePresent, true);
  assert.deepEqual(doctor.cliModifications.modified, []);

  const inspected = JSON.parse((await runCliProcess(cliInfo.entrypoint, ['inspect', '--json'], baseEnv)).stdout);
  assert.equal(inspected.kind, 'code');
  assert.equal(inspected.imageCount, 1);
  assert.ok(!docRes.stdout.includes(FAKE_SESSION.session));
  assert.ok(!inspected.instructions.includes(FAKE_SESSION.session));

  const imgOut = JSON.parse((await runCliProcess(cliInfo.entrypoint, ['images', '--download', workdir, '--json'], baseEnv)).stdout);
  assert.equal(imgOut.images.length, 1);
  const imgBytes = await readFile(imgOut.images[0].filePath);
  assert.equal(imgBytes[0], 0x89);

  const localDraft = join(workdir, 'main.py');
  await runCliProcess(cliInfo.entrypoint, ['read-file', 'src/main.py', '--out', localDraft], baseEnv);
  assert.match(await readFile(localDraft, 'utf8'), /starter/);

  const updatedCode = 'print("fixed-by-cli")\n# sk-secret-value\n';
  await writeFile(localDraft, updatedCode, 'utf8');
  await runCliProcess(cliInfo.entrypoint, ['save-file', 'src/main.py', '--from', localDraft], baseEnv);
  assert.equal(mock.getCode(), updatedCode);

  const cliStateRaw = await readFile(join(workdir, '.educoder-cli-state.json'), 'utf8');
  for (const secret of [FAKE_SESSION.session, FAKE_SESSION.autologin, 'sk-secret-value', 'ak-secret-value']) {
    assert.ok(!cliStateRaw.includes(secret), `state file must not contain ${secret}`);
  }
  const cliState = JSON.parse(cliStateRaw);
  assert.equal(cliState.lastSave.path, 'src/main.py');
  assert.ok(cliState.proof);

  const evalRes = await runCliProcess(cliInfo.entrypoint, ['evaluate', '--poll-ms', '20', '--poll-attempts', '5', '--json'], baseEnv);
  const evalJson = JSON.parse(evalRes.stdout);
  assert.equal(evalJson.state, 'passed');
  assert.equal(evalJson.nextTaskId, 'task-102');
  assert.equal(mock.getBuilds(), 1);
});

test('选择题与只读/终端/浏览器开关限制生效', async t => {
  const sharedRoot = await mkdtemp(join(tmpdir(), 'dsh-cli-choice-'));
  t.after(() => rm(sharedRoot, { recursive: true, force: true }));
  const cliInfo = await syncCliWorkspace(sharedRoot);
  const workdir = await ensureTaskWorkdir(sharedRoot, 'acc1-choice');
  const mock = await startMockEduCoder(t, { mode: 'choice' });

  const env = {
    DSH_EDUCODER_CLI: cliInfo.entrypoint,
    DSH_EDUCODER_CLI_ROOT: cliInfo.cliRoot,
    DSH_EDUCODER_WORKDIR: workdir,
    DSH_EDUCODER_API_URL: mock.apiUrl,
    DSH_EDUCODER_SESSION: JSON.stringify(FAKE_SESSION),
    DSH_EDUCODER_TARGET: JSON.stringify({
      courseId: 'course-1',
      homeworkId: '202',
      taskId: 'task-101',
      binding: {
        courseId: 'course-1',
        homeworkId: '202',
        taskId: 'task-101',
        practiceId: 'practice-303',
        remoteUserId: '7001',
        gameId: '404',
        challengeId: '505',
      },
    }),
    DSH_EDUCODER_READONLY: '1',
    DSH_EDUCODER_TERMINAL_ENABLED: '0',
    DSH_EDUCODER_BROWSER_INSPECTION: '0',
  };

  await assert.rejects(runCliProcess(cliInfo.entrypoint, ['save-file', '--content', 'x'], env), /只读任务模式/);
  await assert.rejects(runCliProcess(cliInfo.entrypoint, ['terminal', '--', 'ls'], { ...env, DSH_EDUCODER_READONLY: '0' }), /未启用远端终端/);
  await assert.rejects(runCliProcess(cliInfo.entrypoint, ['browser'], env), /未启用浏览器查看/);

  const choiceRes = await runCliProcess(cliInfo.entrypoint, [
    'submit-choices', '--answers', '["A",true]', '--json',
  ], { ...env, DSH_EDUCODER_READONLY: '0' });
  const parsed = JSON.parse(choiceRes.stdout);
  assert.equal(parsed.state, 'passed');
  assert.equal(parsed.correct, 2);
});

test('DS 修复工作区 CLI 后可跨 syncCliWorkspace 保留、查看 diff 与恢复基线', async t => {
  const sharedRoot = await mkdtemp(join(tmpdir(), 'dsh-cli-repair-'));
  const fakeSrcRoot = await mkdtemp(join(tmpdir(), 'dsh-cli-src-'));
  t.after(async () => {
    await rm(sharedRoot, { recursive: true, force: true });
    await rm(fakeSrcRoot, { recursive: true, force: true });
  });

  // 构造一个带待更新文件和可修复脚本的 CLI 源目录
  await mkdir(join(fakeSrcRoot, 'bin'), { recursive: true });
  await mkdir(join(fakeSrcRoot, 'lib'), { recursive: true });
  await writeFile(join(fakeSrcRoot, 'educoder.mjs'), "import { run } from './lib/app.mjs'; run();\n", 'utf8');
  await writeFile(join(fakeSrcRoot, 'bin/educoder'), '#!/usr/bin/env node\n', 'utf8');
  await writeFile(join(fakeSrcRoot, 'lib/app.mjs'), "export function run() { process.stdout.write('buggy-v1\\n'); }\n", 'utf8');
  await writeFile(join(fakeSrcRoot, 'lib/other.mjs'), 'export const VERSION = 1;\n', 'utf8');
  await writeFile(join(sharedRoot, 'cli-symlink-target.txt'), 'keep-me\n', 'utf8');

  const first = await syncCliWorkspace(sharedRoot, { sourceRoot: fakeSrcRoot });
  assert.equal((await execFile(process.execPath, [first.entrypoint])).stdout.trim(), 'buggy-v1');

  // 模拟 DS 发现 bug 后直接修复 ./cli/lib/app.mjs
  const liveApp = join(first.cliRoot, 'lib/app.mjs');
  await writeFile(liveApp, "export function run() { process.stdout.write('self-repaired-v1\\n'); }\n", 'utf8');
  assert.equal((await execFile(process.execPath, [first.entrypoint])).stdout.trim(), 'self-repaired-v1');

  // 在包升级（sourceRoot 中的 app.mjs 和 other.mjs 都升级）并触发下一关 syncCliWorkspace 后：
  // 1) 未改动的 other.mjs 自动升级到 VERSION = 2
  // 2) DS 修复过的 app.mjs 继续保留 self-repaired-v1！
  await writeFile(join(fakeSrcRoot, 'lib/app.mjs'), "export function run() { process.stdout.write('upstream-v2\\n'); }\n", 'utf8');
  await writeFile(join(fakeSrcRoot, 'lib/other.mjs'), 'export const VERSION = 2;\n', 'utf8');
  const second = await syncCliWorkspace(sharedRoot, { sourceRoot: fakeSrcRoot });
  assert.ok(second.preserved.includes('lib/app.mjs'));
  assert.ok(second.updated.includes('lib/other.mjs'));
  assert.equal((await execFile(process.execPath, [second.entrypoint])).stdout.trim(), 'self-repaired-v1');
  assert.match(await readFile(join(second.cliRoot, 'lib/other.mjs'), 'utf8'), /VERSION = 2/);

  // 真实 CLI 的 cli-diff / cli-restore 验证
  const realRoot = await mkdtemp(join(tmpdir(), 'dsh-cli-realdiff-'));
  t.after(() => rm(realRoot, { recursive: true, force: true }));
  const seeded = await syncCliWorkspace(realRoot);
  const helpFile = join(seeded.cliRoot, 'lib/config.mjs');
  await writeFile(helpFile, (await readFile(helpFile, 'utf8')) + '\n// DS-HOTFIX\n', 'utf8');

  const diffOut = (await runCliProcess(seeded.entrypoint, ['cli-diff'], { DSH_EDUCODER_CLI_ROOT: seeded.cliRoot })).stdout;
  assert.ok(!diffOut.includes('.manifest.json'));
  assert.match(diffOut, /lib\/config\.mjs/);
  assert.match(diffOut, /\+\d+: \/\/ DS-HOTFIX/);

  const restoreOut = (await runCliProcess(seeded.entrypoint, ['cli-restore', 'lib/config.mjs'], {
    DSH_EDUCODER_CLI_ROOT: seeded.cliRoot,
  })).stdout;
  assert.match(restoreOut, /lib\/config\.mjs/);
  assert.equal(
    (await runCliProcess(seeded.entrypoint, ['cli-diff'], { DSH_EDUCODER_CLI_ROOT: seeded.cliRoot })).stdout.trim(),
    'CLI 目录相对基线无改动。',
  );

  // 符号链接攻击文件会被 syncCliWorkspace 安全移除/拒绝越界写入
  await symlink(join(sharedRoot, 'cli-symlink-target.txt'), join(second.cliRoot, 'lib/other.mjs'), 'file').catch(async () => {
    await rm(join(second.cliRoot, 'lib/other.mjs'), { force: true });
    await symlink(join(sharedRoot, 'cli-symlink-target.txt'), join(second.cliRoot, 'lib/other.mjs'), 'file');
  });
  await syncCliWorkspace(sharedRoot, { sourceRoot: fakeSrcRoot, reset: true });
  assert.equal(await readFile(join(sharedRoot, 'cli-symlink-target.txt'), 'utf8'), 'keep-me\n');
});

test('工作区 CLI 支持直接评测当前提交、宽限轮询启动延迟、连续评测复用 proof 及代码中的 zzud', async t => {
  const sharedRoot = await mkdtemp(join(tmpdir(), 'dsh-cli-fallback-'));
  t.after(() => rm(sharedRoot, { recursive: true, force: true }));
  const cliInfo = await syncCliWorkspace(sharedRoot);

  const makeEnv = async (name, mockOpts) => {
    const workdir = await ensureTaskWorkdir(sharedRoot, name);
    const mock = await startMockEduCoder(t, { mode: 'code', ...mockOpts });
    return {
      mock,
      env: {
        DSH_EDUCODER_CLI: cliInfo.entrypoint,
        DSH_EDUCODER_CLI_ROOT: cliInfo.cliRoot,
        DSH_EDUCODER_WORKDIR: workdir,
        DSH_EDUCODER_API_URL: mock.apiUrl,
        DSH_EDUCODER_SESSION: JSON.stringify(FAKE_SESSION),
        DSH_EDUCODER_TARGET: JSON.stringify({
          courseId: 'course-1',
          homeworkId: '202',
          taskId: 'task-101',
          binding: {
            courseId: 'course-1',
            homeworkId: '202',
            taskId: 'task-101',
            practiceId: 'practice-303',
            remoteUserId: '7001',
            gameId: '404',
            challengeId: '505',
          },
        }),
      },
    };
  };

  // 未先执行 save-file 时直接 evaluate，应回退到当前远端提交并容忍首轮非 building 延迟后正常等到 passed
  const direct = await makeEnv('acc1-direct', { staleBeforeEvaluating: true });
  const directEval = JSON.parse((await runCliProcess(cliInfo.entrypoint, [
    'evaluate', '--poll-ms', '20', '--poll-attempts', '6', '--json',
  ], direct.env)).stdout);
  assert.equal(directEval.state, 'passed');
  assert.equal(direct.mock.getBuilds(), 1);

  // 保存含 zzud 用户名文本的代码不触发 manual_required，且单次 save-file 后可连续 evaluate 两次（先 failed 后 passed）
  const reuse = await makeEnv('acc1-reuse', { failFirstBuild: true });
  const codeWithZzud = `# user=${FAKE_SESSION.zzud}\nprint("${FAKE_SESSION.zzud}")\n`;
  await runCliProcess(cliInfo.entrypoint, ['save-file', 'src/main.py', '--content', codeWithZzud], reuse.env);
  const outPath = join(sharedRoot, 'readback-main.py');
  await runCliProcess(cliInfo.entrypoint, ['read-file', 'src/main.py', '--out', outPath], reuse.env);
  assert.equal(await readFile(outPath, 'utf8'), codeWithZzud);

  const eval1 = JSON.parse((await runCliProcess(cliInfo.entrypoint, ['evaluate', '--poll-ms', '20', '--poll-attempts', '6', '--json'], reuse.env)).stdout);
  assert.equal(eval1.state, 'failed');
  const eval2 = JSON.parse((await runCliProcess(cliInfo.entrypoint, ['evaluate', '--poll-ms', '20', '--poll-attempts', '6', '--json'], reuse.env)).stdout);
  assert.equal(eval2.state, 'passed');
  assert.equal(reuse.mock.getBuilds(), 2);
});
