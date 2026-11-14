import { resolve } from 'node:path';

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

const FLAG_VALUE = new Set([
  '--api-url',
  '--proxy',
  '--workdir',
  '--cli-root',
  '--account',
  '--course-id',
  '--homework-id',
  '--task-id',
  '--advance-to',
  '--remote-user-id',
  '--session-token',
  '--autologin',
  '--zzud',
  '--out',
  '--from',
  '--content',
  '--answers',
  '--screenshot',
  '--download',
  '--cmd',
  '--poll-ms',
  '--poll-attempts',
]);

/** Parse CLI argv into subcommand, positional args, and normalized flags. */
export function parseArgv(argv) {
  const positionals = [];
  const flags = {};
  let afterDoubleDash = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!afterDoubleDash && token === '--') {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq > 0) {
        flags[token.slice(0, eq)] = token.slice(eq + 1);
      } else if (FLAG_VALUE.has(token)) {
        if (i + 1 >= argv.length) throw new UsageError(`参数 ${token} 缺少值。`);
        flags[token] = argv[++i];
      } else {
        flags[token] = true;
      }
      continue;
    }
    if (!afterDoubleDash && token === '-h') {
      flags['--help'] = true;
      continue;
    }
    positionals.push(token);
  }

  const command = positionals[0] || (flags['--help'] ? 'help' : undefined);
  return { command, args: positionals.slice(1), flags };
}

function parseJsonEnv(raw, label) {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new UsageError(`环境变量 ${label} 不是合法的 JSON。`);
  }
}

function parseBooleanFlag(flagVal, envVal, fallback = false) {
  if (flagVal === true) return true;
  if (flagVal === false) return false;
  if (typeof flagVal === 'string') return ['1', 'true', 'yes'].includes(flagVal.toLowerCase());
  if (typeof envVal === 'string' && envVal !== '') return envVal === '1' || envVal.toLowerCase() === 'true';
  return fallback;
}

function parsePositiveInt(raw, fallback, label) {
  if (raw === undefined || raw === true) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new UsageError(`${label} 必须是正整数。`);
  return value;
}

function normalizeAccounts(raw) {
  if (!Array.isArray(raw)) return [];
  const items = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const remoteUserId = item.remoteUserId != null ? String(item.remoteUserId).trim() : '';
    if (!id || !remoteUserId) continue;
    const rawSession = item.session && typeof item.session === 'object' ? item.session : undefined;
    const session = rawSession &&
      rawSession.remoteUserId != null &&
      typeof rawSession.session === 'string' && rawSession.session &&
      typeof rawSession.autologin === 'string' && rawSession.autologin &&
      typeof rawSession.zzud === 'string' && rawSession.zzud
      ? {
        remoteUserId: String(rawSession.remoteUserId),
        session: rawSession.session,
        autologin: rawSession.autologin,
        zzud: rawSession.zzud,
      }
      : undefined;
    items.push({
      id,
      remoteUserId,
      label: typeof item.label === 'string' && item.label.trim() ? item.label.trim() : '***',
      status: typeof item.status === 'string' && item.status.trim() ? item.status.trim() : 'unknown',
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : undefined,
      hasSession: Boolean(session),
      ...(session ? { session } : {}),
    });
  }
  return items;
}

function findAccountBySelector(accounts, selector) {
  const byId = accounts.find(acc => acc.id === selector);
  if (byId) return byId;
  const byRemote = accounts.find(acc => acc.remoteUserId === selector);
  if (byRemote) return byRemote;
  const byLabel = accounts.filter(acc => acc.label === selector);
  if (byLabel.length === 1) return byLabel[0];
  if (byLabel.length > 1) {
    throw new UsageError(`存在多个相同显示名 "${selector}" 的账号，请运行 \`accounts\` 查看列表后改用账号 id 或 remoteUserId。`);
  }
  throw new UsageError(`找不到匹配的 EduCoder 账号: ${selector}。请运行 \`accounts\` 查看可用账号。`);
}

function selectAccount(accounts, selector) {
  const matched = findAccountBySelector(accounts, selector);
  if (!matched.hasSession || !['ready', 'unverified'].includes(matched.status)) {
    throw new UsageError(`账号 ${matched.label} (${matched.id}) 当前状态为 ${matched.status}，缺少可用登录态，请先重新登录。`);
  }
  return matched;
}

/** Build resolved runtime configuration from CLI flags and DSH_EDUCODER_* environment variables. */
export function resolveCliConfig(flags = {}, env = process.env, { requireSession = false, requireTarget = false } = {}) {
  const apiUrl = (typeof flags['--api-url'] === 'string' ? flags['--api-url'] : undefined)
    || env.DSH_EDUCODER_API_URL
    || 'https://data.educoder.net/api';

  const proxyUrl = (typeof flags['--proxy'] === 'string' ? flags['--proxy'] : undefined)
    || env.DSH_EDUCODER_HTTPS_PROXY
    || env.HTTPS_PROXY
    || env.https_proxy
    || undefined;

  const accounts = normalizeAccounts(parseJsonEnv(env.DSH_EDUCODER_ACCOUNTS, 'DSH_EDUCODER_ACCOUNTS'));
  const envSession = parseJsonEnv(env.DSH_EDUCODER_SESSION, 'DSH_EDUCODER_SESSION');
  if (flags['--account'] === true) {
    throw new UsageError('--account 需要传入账号 id、remoteUserId 或 label。');
  }
  const explicitAccountSelector = typeof flags['--account'] === 'string' && flags['--account'].trim()
    ? flags['--account'].trim()
    : undefined;

  let selectedAccount;
  if (explicitAccountSelector) {
    selectedAccount = selectAccount(accounts, explicitAccountSelector);
  } else if (!envSession && accounts.length) {
    const usable = accounts.filter(acc => acc.hasSession && ['ready', 'unverified'].includes(acc.status));
    if (usable.length === 1) selectedAccount = usable[0];
  }

  const baseSession = selectedAccount?.session ?? (!explicitAccountSelector ? envSession : undefined);
  const session = {
    remoteUserId: (typeof flags['--remote-user-id'] === 'string' ? flags['--remote-user-id'] : undefined) ?? baseSession?.remoteUserId,
    session: (typeof flags['--session-token'] === 'string' ? flags['--session-token'] : undefined) ?? baseSession?.session,
    autologin: (typeof flags['--autologin'] === 'string' ? flags['--autologin'] : undefined) ?? baseSession?.autologin,
    zzud: (typeof flags['--zzud'] === 'string' ? flags['--zzud'] : undefined) ?? baseSession?.zzud,
  };
  const hasSession = Boolean(session.remoteUserId && session.session && session.autologin && session.zzud);
  if (requireSession && !hasSession) {
    const usable = accounts.filter(acc => acc.hasSession && ['ready', 'unverified'].includes(acc.status));
    if (usable.length > 1) {
      throw new UsageError('当前工作区绑定了多个可用账号，请先运行 `accounts` 查看列表，再通过 `--account <id|remoteUserId|label>` 指定账号。');
    }
    if (accounts.length > 0 && usable.length === 0) {
      throw new UsageError('当前工作区没有状态可用的 EduCoder 已登录账号，请先检查登录状态或重新登录。');
    }
    throw new UsageError('缺少当前任务的 EduCoder 会话上下文（需通过 DSH_EDUCODER_SESSION、--account 或显式会话参数提供）。');
  }

  const envTarget = parseJsonEnv(env.DSH_EDUCODER_TARGET, 'DSH_EDUCODER_TARGET');
  const switchedAccount = Boolean(
    hasSession && envSession?.remoteUserId && String(session.remoteUserId) !== String(envSession.remoteUserId),
  ) || Boolean(explicitAccountSelector && !envSession);
  const flagCourseId = typeof flags['--course-id'] === 'string' ? flags['--course-id'] : undefined;
  const flagHomeworkId = typeof flags['--homework-id'] === 'string' ? flags['--homework-id'] : undefined;
  const flagTaskId = typeof flags['--task-id'] === 'string' ? flags['--task-id'] : undefined;
  const flagAdvanceTo = typeof flags['--advance-to'] === 'string' ? flags['--advance-to'] : undefined;

  const baseTarget = (!switchedAccount && envTarget && typeof envTarget === 'object') ? { ...envTarget } : {};
  const courseChanged = Boolean(flagCourseId !== undefined && flagCourseId !== baseTarget.courseId);
  const homeworkChanged = Boolean(flagHomeworkId !== undefined && flagHomeworkId !== baseTarget.homeworkId);
  const taskChanged = Boolean(flagTaskId !== undefined && flagTaskId !== baseTarget.taskId);
  if (courseChanged || homeworkChanged) {
    delete baseTarget.taskId;
    delete baseTarget.advanceTo;
    delete baseTarget.binding;
  } else if (taskChanged) {
    delete baseTarget.binding;
  }

  const target = {
    ...baseTarget,
    ...(flagCourseId !== undefined ? { courseId: flagCourseId } : {}),
    ...(flagHomeworkId !== undefined ? { homeworkId: flagHomeworkId } : {}),
    ...(flagTaskId !== undefined ? { taskId: flagTaskId } : {}),
    ...(flagAdvanceTo !== undefined ? { advanceTo: flagAdvanceTo } : {}),
  };
  const hasTarget = Boolean(target.courseId && target.homeworkId);
  if (requireTarget && !hasTarget) {
    throw new UsageError('缺少关卡目标参数（需提供 --course-id 与 --homework-id，或使用当前任务绑定；可先运行 courses / homeworks 查询）。');
  }

  const cliRoot = resolve(
    (typeof flags['--cli-root'] === 'string' ? flags['--cli-root'] : undefined)
      || env.DSH_EDUCODER_CLI_ROOT
      || new URL('..', import.meta.url).pathname,
  );
  const workdir = (typeof flags['--workdir'] === 'string' ? flags['--workdir'] : undefined)
    || env.DSH_EDUCODER_WORKDIR
    || undefined;

  return {
    apiUrl,
    proxyUrl,
    accounts,
    session: hasSession ? session : undefined,
    target: hasTarget ? target : undefined,
    signingAccessKey: env.DSH_EDUCODER_SIGNING_AK || env.EDUCODER_SIGNING_ACCESS_KEY || undefined,
    signingSecretKey: env.DSH_EDUCODER_SIGNING_SK || env.EDUCODER_SIGNING_SECRET_KEY || undefined,
    readOnly: parseBooleanFlag(flags['--readonly'], env.DSH_EDUCODER_READONLY, false),
    terminalEnabled: parseBooleanFlag(flags['--terminal-enabled'], env.DSH_EDUCODER_TERMINAL_ENABLED, false),
    browserInspection: parseBooleanFlag(flags['--browser-inspection'], env.DSH_EDUCODER_BROWSER_INSPECTION, false),
    workdir: workdir ? resolve(workdir) : undefined,
    cliRoot,
    json: Boolean(flags['--json']),
    wait: flags['--no-wait'] ? false : true,
    pollMs: parsePositiveInt(flags['--poll-ms'], 1500, '--poll-ms'),
    pollAttempts: parsePositiveInt(flags['--poll-attempts'], 60, '--poll-attempts'),
  };
}

/** Redact session cookies and signing secrets before emitting CLI diagnostics or errors. */
export function redactText(text, config = {}) {
  let output = String(text ?? '');
  const accountSecrets = Array.isArray(config.accounts)
    ? config.accounts.flatMap(item => [item?.session?.session, item?.session?.autologin, item?.session?.zzud])
    : [];
  const secrets = [
    config.session?.session,
    config.session?.autologin,
    config.session?.zzud,
    ...accountSecrets,
    config.signingAccessKey,
    config.signingSecretKey,
  ];
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) {
      output = output.replaceAll(secret, '[已脱敏]').replaceAll(encodeURIComponent(secret), '[已脱敏]');
    }
  }
  return output;
}
