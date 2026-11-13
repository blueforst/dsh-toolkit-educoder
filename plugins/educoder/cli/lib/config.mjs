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

  const envSession = parseJsonEnv(env.DSH_EDUCODER_SESSION, 'DSH_EDUCODER_SESSION');
  const session = {
    remoteUserId: (typeof flags['--remote-user-id'] === 'string' ? flags['--remote-user-id'] : undefined) ?? envSession?.remoteUserId,
    session: (typeof flags['--session-token'] === 'string' ? flags['--session-token'] : undefined) ?? envSession?.session,
    autologin: (typeof flags['--autologin'] === 'string' ? flags['--autologin'] : undefined) ?? envSession?.autologin,
    zzud: (typeof flags['--zzud'] === 'string' ? flags['--zzud'] : undefined) ?? envSession?.zzud,
  };
  const hasSession = Boolean(session.remoteUserId && session.session && session.autologin && session.zzud);
  if (requireSession && !hasSession) {
    throw new UsageError('缺少当前任务的 EduCoder 会话上下文（需通过 DSH_EDUCODER_SESSION 或显式会话参数提供）。');
  }

  const envTarget = parseJsonEnv(env.DSH_EDUCODER_TARGET, 'DSH_EDUCODER_TARGET');
  const target = {
    ...(envTarget && typeof envTarget === 'object' ? envTarget : {}),
    ...(typeof flags['--course-id'] === 'string' ? { courseId: flags['--course-id'] } : {}),
    ...(typeof flags['--homework-id'] === 'string' ? { homeworkId: flags['--homework-id'] } : {}),
    ...(typeof flags['--task-id'] === 'string' ? { taskId: flags['--task-id'] } : {}),
    ...(typeof flags['--advance-to'] === 'string' ? { advanceTo: flags['--advance-to'] } : {}),
  };
  const hasTarget = Boolean(target.courseId && target.homeworkId && target.taskId);
  if (requireTarget && !hasTarget) {
    throw new UsageError('缺少当前关卡绑定参数（courseId / homeworkId / taskId）。');
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
    pollAttempts: parsePositiveInt(flags['--poll-attempts'], 20, '--poll-attempts'),
  };
}

/** Redact session cookies and signing secrets before emitting CLI diagnostics or errors. */
export function redactText(text, config = {}) {
  let output = String(text ?? '');
  const secrets = [
    config.session?.session,
    config.session?.autologin,
    config.session?.zzud,
    config.signingAccessKey,
    config.signingSecretKey,
  ];
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) {
      output = output.replaceAll(secret, '[已脱敏]').replaceAll(encodeURIComponent(secret), '[已脱敏]');
    }
  }
  return output;
}
