import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createBrowserInspector } from './browser.mjs';
import { UsageError, parseArgv, redactText, resolveCliConfig } from './config.mjs';
import { resolveDshModule } from './dsh-require.mjs';
import { createEduCoderProxy } from './proxy.mjs';
import { cliDiff, cliRestore, cliStatePath, cliStatus, readCliState, writeCliState } from './state.mjs';
import { createTerminalRunner } from './terminal.mjs';
import { createTransport } from './transport.mjs';

export function helpText() {
  return [
    'EduCoder CLI (可编辑自愈命令行工具)',
    '',
    '用法:',
    '  node "$DSH_EDUCODER_CLI" <command> [options]',
    '',
    '常用命令:',
    '  inspect [--json]                                  查看当前关卡状态、代码文件路径、选择题和题面',
    '  read-file [remotePath] [--out <localFile>]        读取平台代码文件，可选同步到本地工作区文件',
    '  save-file [remotePath] --from <localFile>         从本地文件上传保存到 EduCoder 代码区（不触发评测）',
    '  save-file [remotePath] --content <text>|--stdin   直接传入内容保存到 EduCoder 代码区',
    '  evaluate [--no-wait] [--from <localFile>]         提交评测并等待结果（可先 --from 自动 save-file）',
    '  submit-choices --answers <json|csv> [--from <f>]  按题序提交选择/判断/填空答案',
    '  terminal [--] <command...>                        在关卡远端终端执行命令（受终端开关限制）',
    '  browser [--screenshot <pngPath>]                  无头 Chromium 查看关卡网页并可截图给 read_image',
    '  images [--download <dir>]                         列出或下载题面附图到目录以供 read_image 查看',
    '  doctor [--json]                                   检查 CLI 路径、运行依赖、代理、开关与改动状态',
    '  cli-diff [file...]                                对比相对基线备份 (.baseline) 的本地源码改动',
    '  cli-restore [file...]                             从 .baseline 恢复指定或全部 CLI 文件',
    '',
    '常用环境变量 (由 DSH 按当前任务隔离注入):',
    '  DSH_EDUCODER_API_URL / DSH_EDUCODER_SESSION / DSH_EDUCODER_TARGET / DSH_EDUCODER_WORKDIR',
  ].join('\n');
}

function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function saveWithState(transport, config, remotePath, content, task) {
  const safeContent = redactText(content, config);
  const prevState = await readCliState(config);
  const targetKey = digestTarget(config.target);
  await writeCliState(config, {
    ...prevState,
    targetKey,
    pendingSave: {
      path: remotePath,
      marker: task.marker,
      content: safeContent,
      contentSha256: sha256Text(safeContent),
      startedAt: new Date().toISOString(),
    },
  });
  const proof = await transport.saveFile(config.session, config.target, remotePath, content);
  const exported = transport.exportProof(proof);
  const { pendingSave: _done, ...rest } = await readCliState(config);
  await writeCliState(config, {
    ...rest,
    targetKey,
    lastSave: {
      path: remotePath,
      marker: task.marker,
      content: safeContent,
      contentSha256: sha256Text(safeContent),
      savedAt: new Date().toISOString(),
    },
    proof: exported,
  });
  return proof;
}

function digestTarget(target) {
  if (!target) return '';
  return `${target.courseId}:${target.homeworkId}:${target.taskId}:${target.advanceTo || ''}`;
}

async function writeLocalFile(path, data) {
  const dest = resolve(path);
  await mkdir(dirname(dest), { recursive: true });
  const handle = await open(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close().catch(() => {});
  }
  return dest;
}

function resolveRemotePath(explicitPath, task) {
  if (typeof explicitPath === 'string' && explicitPath.trim() !== '') return explicitPath;
  if (Array.isArray(task?.paths) && task.paths.length === 1) return task.paths[0];
  const candidates = Array.isArray(task?.paths) && task.paths.length > 0 ? task.paths.join(', ') : '无';
  throw new UsageError(`请指定 remotePath；当前关卡可写路径: ${candidates}`);
}

function parseChoicesInput(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new UsageError('请通过 --answers 或 --from 提供选择/判断/填空答案。');
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    const list = Array.isArray(parsed) ? parsed : parsed?.answers;
    if (!Array.isArray(list)) throw new UsageError('--answers JSON 必须是数组或包含 answers 数组的对象。');
    return list;
  }
  return trimmed.split(',').map(part => part.trim()).filter(Boolean).map(token => {
    if (token === 'true') return true;
    if (token === 'false') return false;
    return token;
  });
}

function printOutput(value, config, formatter) {
  if (config.json) {
    process.stdout.write(redactText(JSON.stringify(value, null, 2), config) + '\n');
    return;
  }
  const formatted = typeof formatter === 'function' ? formatter(value) : String(value ?? '');
  process.stdout.write(redactText(formatted, config).trimEnd() + '\n');
}

function formatInspect(task) {
  const lines = [
    `标题: ${task.title || '未命名关卡'}`,
    `类型: ${task.kind}  状态: ${task.state}${task.evaluating ? ' (评测中)' : ''}`,
    `关卡ID: ${task.binding?.taskId || ''}  nextTaskId: ${task.nextTaskId || '无'}`,
  ];
  if (task.paths?.length) lines.push(`允许编辑文件 (${task.paths.length}): ${task.paths.join(', ')}`);
  if (task.terminalAvailable) lines.push('远端终端: 可用');
  if (task.imageCount > 0 || task.imagesUnavailable) {
    lines.push(`题面附图: ${task.imageCount || 0} 张${task.imagesUnavailable ? ' (部分图片不可读取)' : ''}`);
  }
  if (task.questions?.length) {
    lines.push(`选择题/客观题数量: ${task.questions.length}`);
    for (const [index, q] of task.questions.entries()) {
      lines.push(`  Q${index + 1} (${q.type}): ${q.prompt || ''}`);
      if (Array.isArray(q.options)) {
        for (const opt of q.options) lines.push(`    ${opt.id}. ${opt.text}`);
      }
    }
  }
  if (task.feedback?.compiler) lines.push('', '上次编译/运行输出:', task.feedback.compiler);
  if (task.feedback?.publicTests?.length) {
    lines.push('', `公开测试点 (${task.feedback.publicTests.length}):`);
    for (const [index, item] of task.feedback.publicTests.entries()) {
      lines.push(`  - 用例 ${index + 1}: ${item.passed ? 'PASS' : 'FAIL'}`);
      if (!item.passed && item.input) lines.push(`    输入: ${item.input}`);
      if (!item.passed && item.expected) lines.push(`    期望: ${item.expected}`);
      if (!item.passed && item.actual) lines.push(`    实际: ${item.actual}`);
    }
  }
  if (task.instructions) {
    lines.push('', '题面内容:', task.instructions);
  }
  return lines.join('\n');
}

function formatEvaluationResult(result) {
  if (!result || typeof result !== 'object') return '评测已触发。';
  const passed = result.state === 'passed' || result.passed === true;
  const lines = [
    `评测状态: ${result.state ?? (passed ? 'passed' : 'failed')}${result.evaluating ? ' (仍在评测中)' : ''}`,
  ];
  if (result.total !== undefined) lines.push(`题数/得分: ${result.correct ?? 0}/${result.total}`);
  if (result.feedback?.choice) {
    const c = result.feedback.choice;
    lines.push(`客观题结果: ${c.correct ?? 0}/${c.total ?? '?'}`);
  }
  if (result.feedback?.compiler) lines.push(`编译/运行输出:\n${result.feedback.compiler}`);
  if (result.feedback?.publicTests?.length) {
    lines.push(`公开测试点 (${result.feedback.publicTests.length}):`);
    for (const [index, item] of result.feedback.publicTests.entries()) {
      lines.push(`  - 用例 ${index + 1}: ${item.passed ? 'PASS' : 'FAIL'}`);
      if (!item.passed && item.input) lines.push(`    输入: ${item.input}`);
      if (!item.passed && item.expected) lines.push(`    期望: ${item.expected}`);
      if (!item.passed && item.actual) lines.push(`    实际: ${item.actual}`);
    }
  }
  if (result.nextTaskId) lines.push(`下一关 taskId: ${result.nextTaskId}`);
  return lines.join('\n');
}

async function waitForEvaluation(transport, config, priorMarker) {
  for (let attempt = 0; attempt < config.pollAttempts; attempt++) {
    const task = await transport.inspect(config.session, config.target);
    const markerAdvanced = !priorMarker || task.marker !== priorMarker;
    if (task.state === 'passed') return task;
    if (!task.evaluating && (markerAdvanced || attempt > 0)) return task;
    if (attempt + 1 < config.pollAttempts) {
      await new Promise(resolveTimer => setTimeout(resolveTimer, config.pollMs));
    }
  }
  return await transport.inspect(config.session, config.target);
}

async function readStdinUtf8() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function withTransport(config, fn) {
  const proxy = createEduCoderProxy(config.proxyUrl);
  const terminalRunner = config.terminalEnabled ? createTerminalRunner({ proxyUrl: config.proxyUrl }) : undefined;
  const transport = createTransport({
    baseUrl: config.apiUrl,
    fetch: proxy.fetch,
    terminalRunner,
    signingAccessKey: config.signingAccessKey,
    signingSecretKey: config.signingSecretKey,
  });
  try {
    return await fn(transport);
  } finally {
    await proxy.close().catch(() => {});
  }
}

export async function runCli(argv = process.argv.slice(2), env = process.env) {
  const { command, args, flags } = parseArgv(argv);
  if (!command || command === 'help' || flags['--help']) {
    process.stdout.write(helpText() + '\n');
    return 0;
  }

  if (command === 'cli-diff') {
    const config = resolveCliConfig(flags, env);
    const diff = await cliDiff(config.cliRoot, args);
    process.stdout.write((diff || 'CLI 目录相对基线无改动。') + '\n');
    return 0;
  }

  if (command === 'cli-restore') {
    const config = resolveCliConfig(flags, env);
    const result = await cliRestore(config.cliRoot, args);
    printOutput(result, config, val => `已从基线恢复 ${val.restored.length} 个文件: ${val.restored.join(', ')}`);
    return 0;
  }

  if (command === 'doctor') {
    const config = resolveCliConfig(flags, env);
    const status = await cliStatus(config.cliRoot);
    const checkModule = (name, overrideEnv) => {
      try {
        return { available: true, path: resolveDshModule(name, overrideEnv) };
      } catch (error) {
        return { available: false, error: error.message };
      }
    };
    const report = {
      node: process.version,
      cliRoot: config.cliRoot,
      workdir: config.workdir || null,
      stateFile: cliStatePath(config),
      apiUrl: config.apiUrl,
      proxyConfigured: Boolean(config.proxyUrl),
      sessionConfigured: Boolean(config.session),
      targetConfigured: Boolean(config.target),
      signingConfigured: Boolean(config.signingAccessKey && config.signingSecretKey),
      readOnly: config.readOnly,
      terminalEnabled: config.terminalEnabled,
      browserInspection: config.browserInspection,
      modules: {
        undici: checkModule('undici', 'DSH_EDUCODER_UNDICI'),
        playwrightCore: checkModule('playwright-core', 'DSH_EDUCODER_PLAYWRIGHT'),
      },
      cliModifications: {
        baselinePresent: status.baselinePresent,
        modified: status.modified,
        added: status.added,
        missing: status.missing,
      },
    };
    printOutput(report, config, val => JSON.stringify(val, null, 2));
    return 0;
  }

  const config = resolveCliConfig(flags, env, { requireSession: true, requireTarget: true });

  if (command === 'inspect') {
    const task = await withTransport(config, t => t.inspect(config.session, config.target));
    printOutput(task, config, formatInspect);
    return 0;
  }

  if (command === 'images') {
    const outDir = typeof flags['--download'] === 'string' ? resolve(flags['--download']) : undefined;
    const result = await withTransport(config, async t => {
      const task = await t.inspect(config.session, config.target);
      if (!task.imageCount) return { imageCount: 0, images: [], unavailable: Boolean(task.imagesUnavailable) };
      if (!outDir) {
        return {
          imageCount: task.imageCount,
          images: [],
          unavailable: Boolean(task.imagesUnavailable),
        };
      }
      const buffers = await t.readStatementImages(task);
      const saved = [];
      const extMap = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
      for (const [idx, item] of buffers.entries()) {
        const ext = extMap[item.mediaType] || 'png';
        const filePath = await writeLocalFile(join(outDir, `statement-${idx + 1}.${ext}`), item.data);
        saved.push({ index: idx + 1, name: item.name, mediaType: item.mediaType, filePath, bytes: item.data.byteLength });
      }
      return { imageCount: task.imageCount, images: saved, unavailable: Boolean(task.imagesUnavailable) };
    });
    printOutput(result, config, val => val.images.length
      ? val.images.map(img => `#${img.index} (${img.mediaType}): ${img.filePath}`).join('\n')
      : val.imageCount > 0
        ? `当前关卡包含 ${val.imageCount} 张题面附图；请传入 --download <目录> 下载后用 read_image 查看。`
        : (val.unavailable ? '题面包含无法直接读取的图片。' : '当前关卡没有题面附图。'));
    return 0;
  }

  if (command === 'browser') {
    if (!config.browserInspection) {
      throw new UsageError('当前未启用浏览器查看（DSH_EDUCODER_BROWSER_INSPECTION != 1）。');
    }
    const screenshotPath = typeof flags['--screenshot'] === 'string' ? resolve(flags['--screenshot']) : undefined;
    const inspectBrowser = createBrowserInspector({ proxy: config.proxyUrl });
    const result = await inspectBrowser({
      session: config.session,
      binding: {
        ...(config.target.binding && typeof config.target.binding === 'object' ? config.target.binding : {}),
        courseId: config.target.courseId,
        homeworkId: config.target.homeworkId,
        taskId: config.target.taskId,
        remoteUserId: config.session.remoteUserId,
      },
      screenshotPath,
    });
    printOutput(result, config, val => [
      val.screenshotPath ? `已保存网页截图: ${val.screenshotPath}` : undefined,
      '网页可见文本:',
      val.text,
    ].filter(Boolean).join('\n'));
    return 0;
  }

  if (command === 'read-file') {
    const outFile = typeof flags['--out'] === 'string' ? resolve(flags['--out']) : undefined;
    const result = await withTransport(config, async t => {
      const task = await t.inspect(config.session, config.target);
      const remotePath = resolveRemotePath(args[0], task);
      const content = await t.readFile(config.session, config.target, remotePath);
      const writtenPath = outFile ? await writeLocalFile(outFile, content) : undefined;
      return { path: remotePath, content, savedTo: writtenPath };
    });
    printOutput(result, config, val => [
      val.savedTo ? `已保存到本地文件: ${val.savedTo}` : undefined,
      `=== ${val.path} ===`,
      val.content,
    ].filter(Boolean).join('\n'));
    return 0;
  }

  if (command === 'save-file') {
    if (config.readOnly) throw new UsageError('当前为只读任务模式，禁止调用 save-file。');
    let content;
    if (typeof flags['--from'] === 'string') {
      content = await readFile(resolve(flags['--from']), 'utf8');
    } else if (typeof flags['--content'] === 'string') {
      content = flags['--content'];
    } else if (flags['--stdin']) {
      content = await readStdinUtf8();
    } else {
      throw new UsageError('save-file 需要 --from <localFile>、--content <text> 或 --stdin。');
    }

    const saved = await withTransport(config, async t => {
      const task = await t.inspect(config.session, config.target);
      const remotePath = resolveRemotePath(args[0], task);
      await saveWithState(t, config, remotePath, content, task);
      return { ok: true, path: remotePath, bytes: Buffer.byteLength(content, 'utf8') };
    });
    printOutput(saved, config, val => `已保存远程文件 ${val.path} (${val.bytes} bytes)。下一步请运行 evaluate 提交评测。`);
    return 0;
  }

  if (command === 'terminal') {
    if (config.readOnly) throw new UsageError('当前为只读任务模式，禁止调用 terminal。');
    if (!config.terminalEnabled) throw new UsageError('当前未启用远端终端（DSH_EDUCODER_TERMINAL_ENABLED != 1）。');
    const cmd = typeof flags['--cmd'] === 'string' ? flags['--cmd'] : args.join(' ');
    if (!cmd.trim()) throw new UsageError('请提供要执行的终端命令，例如: terminal -- ls -la');
    const res = await withTransport(config, async t => {
      const output = await t.runTerminal(config.session, config.target, cmd);
      if (output.proof) {
        const exported = t.exportProof(output.proof);
        const prevState = await readCliState(config);
        await writeCliState(config, {
          ...prevState,
          targetKey: digestTarget(config.target),
          proof: exported,
        });
      }
      return { exitCode: output.exitCode, output: output.output, hasProof: Boolean(output.proof) };
    });
    printOutput(res, config, val => `exitCode=${val.exitCode}\n${val.output || ''}`);
    return 0;
  }

  if (command === 'submit-choices') {
    if (config.readOnly) throw new UsageError('当前为只读任务模式，禁止调用 submit-choices。');
    let rawAnswers = typeof flags['--answers'] === 'string' ? flags['--answers'] : args[0];
    if (!rawAnswers && typeof flags['--from'] === 'string') {
      rawAnswers = await readFile(resolve(flags['--from']), 'utf8');
    }
    const answers = parseChoicesInput(rawAnswers);
    const result = await withTransport(config, async t => {
      const score = await t.submitChoices(config.session, config.target, answers);
      const latest = await t.inspect(config.session, config.target).catch(() => undefined);
      return { ...(latest ?? {}), ...score };
    });
    printOutput(result, config, formatEvaluationResult);
    return 0;
  }

  if (command === 'evaluate') {
    if (config.readOnly) throw new UsageError('当前为只读任务模式，禁止调用 evaluate。');
    const result = await withTransport(config, async t => {
      let proof;
      let priorMarker;
      const state = await readCliState(config);
      if (typeof flags['--from'] === 'string') {
        const content = await readFile(resolve(flags['--from']), 'utf8');
        const task = await t.inspect(config.session, config.target);
        priorMarker = task.marker;
        const remotePath = resolveRemotePath(args[0], task);
        proof = await saveWithState(t, config, remotePath, content, task);
      } else {
        if (!state?.proof || (state.targetKey && state.targetKey !== digestTarget(config.target))) {
          throw new UsageError('当前任务尚未保存可评测的变更，请先执行 save-file、terminal，或使用 evaluate --from <localFile>。');
        }
        priorMarker = state.lastSave?.marker;
        proof = t.restoreProof(state.proof);
      }
      await t.evaluate(config.session, config.target, proof);
      const latest = config.wait
        ? await waitForEvaluation(t, config, priorMarker)
        : await t.inspect(config.session, config.target);
      const afterState = await readCliState(config);
      const { proof: _consumed, ...restState } = afterState;
      await writeCliState(config, {
        ...restState,
        lastEvaluation: {
          state: latest.state,
          evaluating: Boolean(latest.evaluating),
          evaluatedAt: new Date().toISOString(),
        },
      });
      return latest;
    });
    printOutput(result, config, formatEvaluationResult);
    return 0;
  }

  throw new UsageError(`未知子命令: ${command}。运行 --help 查看可用命令。`);
}
