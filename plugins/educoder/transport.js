// EduCoder protocol reference (MIT, © 2026 chumeng):
// https://github.com/lihaoze123/educoder-cli/tree/5e76e15ffcb364edecde74381577d8f7f4470dcf
// Additional protocol observations (HTTP 200 with status 401, choice shape, staged writes):
// https://github.com/isheng-eqi/dsh-educoder/tree/392a88bcb695f8a12ad2b7d76e2ea455105e092f
import { createHash } from 'node:crypto'

const productionUrl = 'https://data.educoder.net/api'
const maxResponseBytes = 4 * 1024 * 1024
const maxCodeBytes = 1024 * 1024
const maxTerminalOutput = 16_000

const errorMessages = {
  aborted: 'EduCoder 操作已取消。',
  auth_required: 'EduCoder 登录已失效，请重新登录。',
  invalid_credentials: 'EduCoder 拒绝了账号或密码。',
  invalid_scope: 'EduCoder 返回的账号、课程、作业或关卡与选定范围不符。',
  manual_required: 'EduCoder 需要人工处理当前账号或任务。',
  signature_error: 'EduCoder 请求签名校验失败，请核对配置与系统时间。',
  unavailable: 'EduCoder 暂时不可用或返回了无法识别的数据。',
  uncertain: 'EduCoder 写入结果未知，请先核对远端状态。',
}

export class TransportError extends Error {
  constructor(code) {
    super(errorMessages[code] ?? errorMessages.unavailable)
    this.name = 'TransportError'
    this.code = code
  }
}

function fail(code) {
  throw new TransportError(code)
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function identifier(value, code = 'invalid_scope') {
  if ((typeof value !== 'string' && !Number.isSafeInteger(value)) ||
      !/^[a-zA-Z0-9_-]{1,120}$/.test(String(value))) fail(code)
  return String(value)
}

function positiveId(value, code = 'invalid_scope') {
  const valueId = identifier(value, code)
  if (!/^[1-9][0-9]{0,14}$/.test(valueId)) fail(code)
  return valueId
}

function checkedToken(value, code) {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(value) || /[;,]/.test(value)) {
    fail(code)
  }
  return value
}

function cleanSession(value) {
  if (!record(value)) fail('auth_required')
  return {
    zzud: checkedToken(value.zzud, 'auth_required'),
    autologin: checkedToken(value.autologin, 'auth_required'),
    session: checkedToken(value.session, 'auth_required'),
    remoteUserId: positiveId(value.remoteUserId, 'auth_required'),
  }
}

function readSignal(options) {
  return options instanceof AbortSignal ? options : options?.signal
}

function withDeadline(timeoutMs, signal) {
  const deadline = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, deadline]) : deadline
}

function readCookie(headers, name) {
  const values = headers.getSetCookie().filter(value => value.startsWith(name + '='))
  if (values.length !== 1) fail('manual_required')
  return checkedToken(values[0].split(';', 1)[0].slice(name.length + 1), 'manual_required')
}

function text(value, limit = 500) {
  return typeof value === 'string' ? value.slice(0, limit) : ''
}

function maskedLogin(value) {
  if (value.length < 5) return '***'
  return value.slice(0, 2) + '***' + value.slice(-2)
}

function safePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 &&
    !/[\\:\u0000-\u001f\u007f]|%[a-f\d]{2}/i.test(value) &&
    value.split('/').every(segment => segment && segment !== '.' && segment !== '..')
}

function taskPaths(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return []
  const paths = raw.split(/[;；]/u).map(path => path.trim()).filter(Boolean)
  return paths.length <= 128 && paths.every(safePath) ? [...new Set(paths)] : []
}

function readScope(target) {
  if (!record(target)) fail('invalid_scope')
  return {
    courseId: identifier(target.courseId),
    homeworkId: positiveId(target.homeworkId),
  }
}

function readBinding(target) {
  const value = target?.binding ?? target
  const scope = readScope(value)
  if (target?.binding && ((target.courseId !== undefined && identifier(target.courseId) !== scope.courseId) ||
      (target.homeworkId !== undefined && positiveId(target.homeworkId) !== scope.homeworkId))) fail('invalid_scope')
  return {
    ...scope,
    taskId: identifier(value.taskId),
    practiceId: identifier(value.practiceId),
    remoteUserId: positiveId(value.remoteUserId),
    gameId: positiveId(value.gameId),
    challengeId: positiveId(value.challengeId),
  }
}

function sameTask(actual, expected) {
  for (const key of ['courseId', 'homeworkId', 'taskId', 'practiceId', 'remoteUserId', 'gameId', 'challengeId']) {
    if (actual[key] !== expected[key]) fail('invalid_scope')
  }
}

function terminalEnvironment(raw) {
  const environments = Array.isArray(raw.shixun_environments) ? raw.shixun_environments : []
  const options = environments.filter(item => item?.tab_type === 4)
  if (options.length !== 1 || !Number.isSafeInteger(options[0].shixun_environment_id) ||
      options[0].shixun_environment_id < 1) return null
  return options[0]
}

function redact(value, secrets) {
  const tokens = new Set()
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret) {
      tokens.add(secret)
      tokens.add(encodeURIComponent(secret))
    }
  }
  for (const token of [...tokens].sort((a, b) => b.length - a.length)) {
    value = value.replaceAll(token, '[已脱敏]')
  }
  return value
}

function accountSecrets(account) {
  return [account.zzud, account.autologin, account.session]
}

function normalizeTask(raw, scope, account, taskId, practiceId, supportsTerminal) {
  const { game, challenge, user } = raw
  if (!record(game) || !record(challenge) || !record(user)) fail('unavailable')
  const ownerId = positiveId(user.user_id)
  if (ownerId !== account.remoteUserId || identifier(game.identifier) !== taskId ||
      positiveId(raw.homework_common_id) !== scope.homeworkId) fail('invalid_scope')
  if (game.user_id && positiveId(game.user_id) !== ownerId) fail('invalid_scope')
  if (game.challenge_id && positiveId(game.challenge_id) !== positiveId(challenge.id)) fail('invalid_scope')
  if (raw.myshixun?.identifier && identifier(raw.myshixun.identifier) !== practiceId) fail('invalid_scope')

  if (![0, 1, 2, 3].includes(game.status)) fail('manual_required')
  const binding = {
    ...scope,
    taskId,
    practiceId,
    remoteUserId: ownerId,
    gameId: positiveId(game.id),
    challengeId: positiveId(challenge.id),
  }
  const secrets = [...accountSecrets(account), raw.sec_key]
  const remotePaths = taskPaths(challenge.path)
  const paths = remotePaths.every(path => redact(path, secrets) === path) ? remotePaths : []
  const environments = Array.isArray(raw.shixun_environments) ? raw.shixun_environments : []
  const gui = environments.some(env => env?.tab_type === 3)
  const terminal = environments.some(env => env?.tab_type === 4)
  const choice = Boolean(raw.choose_test_cases?.test_sets?.length ||
    raw.choose_test_cases?.choose_test_cases?.length || raw.choose_test_cases?.choose_test_cases_count > 0)
  const kind = gui || choice ? 'manual' : terminal ? 'terminal' : paths.length ? 'code' : 'manual'
  const evaluateCount = Number.isSafeInteger(game.evaluate_count) && game.evaluate_count >= 0
    ? game.evaluate_count : null
  const publicText = (value, limit) => typeof value === 'string' ? text(redact(value, secrets), limit) : ''
  const task = {
    binding,
    kind,
    state: game.status === 2 ? 'passed' : game.status === 3 ? 'failed' : 'pending',
    evaluating: game.status === 1,
    title: publicText(challenge.subject),
    instructions: publicText(challenge.task_pass, 24_000),
    terminalAvailable: kind === 'terminal' && supportsTerminal && terminalEnvironment(raw) !== null,
    paths: kind === 'code' ? paths : [],
    marker: evaluateCount === null ? '' : String(evaluateCount),
    feedback: {
      compiler: publicText(raw.last_compile_output, 6_000),
      publicTests: (Array.isArray(raw.test_sets) ? raw.test_sets : []).filter(item => item?.is_public === true)
        .slice(0, 16).map(item => ({
          passed: item.result === true,
          expected: publicText(item.output),
          actual: publicText(item.actual_output),
        })),
    },
  }
  if (task.state === 'passed' && raw.next_game) {
    task.nextTaskId = identifier(raw.next_game)
    if (task.nextTaskId === taskId) fail('manual_required')
  }
  return task
}

async function readJson(response, code) {
  let size = 0
  const chunks = []
  if (!response.body) fail(code)
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > maxResponseBytes) fail(code)
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function responseStatus(data, login, mutation) {
  if (!record(data)) fail(mutation ? 'uncertain' : 'unavailable')
  if ([401, 403, '401', '403'].includes(data.status)) fail(login ? 'manual_required' : 'auth_required')
  if (data.status === -102) fail('signature_error')
  if (login && data.status === -3) fail('invalid_credentials')
  if (login && Number.isInteger(data.status) && data.status < 0) fail('manual_required')
  if (Number.isInteger(data.status) && data.status < 0) fail(mutation ? 'uncertain' : 'manual_required')
}

export function createTransport({
  baseUrl = productionUrl,
  fetch: request = globalThis.fetch,
  timeoutMs = 15_000,
  signingAccessKey = process.env.EDUCODER_SIGNING_ACCESS_KEY,
  signingSecretKey = process.env.EDUCODER_SIGNING_SECRET_KEY,
  terminalRunner,
  terminalHosts = ['webssh.educoder.net'],
} = {}) {
  const base = new URL(baseUrl)
  const production = base.href === productionUrl
  const loopback = base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
  if ((!production && !loopback) || base.username || base.password || base.search || base.hash ||
      base.pathname !== '/api') throw new TypeError('无效的 EduCoder 服务地址。')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new TypeError('无效的 EduCoder 请求超时。')
  }

  if (terminalRunner !== undefined && (typeof terminalRunner !== 'function' || !Array.isArray(terminalHosts) ||
      !terminalHosts.length || terminalHosts.some(host => typeof host !== 'string' ||
        !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/.test(host) || !host.includes('.')))) {
    throw new TypeError('无效的 EduCoder 终端配置。')
  }
  const allowedTerminalHosts = new Set(terminalHosts)
  const proofs = new WeakMap()

  async function call(method, path, { account, body, query, signal, login = false, mutation = false } = {}) {
    if (signal?.aborted) fail('aborted')
    if (production && (!signingAccessKey || !signingSecretKey)) fail('signature_error')
    const url = new URL(base.origin + '/api' + path)
    if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    if (account) url.searchParams.set('zzud', account.zzud)

    const headers = { accept: 'application/json', 'X-EDU-Type': 'pc' }
    if (signingAccessKey && signingSecretKey) {
      const now = String(Date.now())
      const input = Buffer.from('method=' + method + '&ak=' + signingAccessKey +
        '&sk=' + signingSecretKey + '&time=' + now).toString('base64')
      headers['X-EDU-Timestamp'] = now
      headers['X-EDU-Signature'] = createHash('md5').update(input).digest('hex')
    }
    if (body !== undefined) headers['content-type'] = 'application/json; charset=utf-8'
    if (login) {
      headers['Pc-Authorization'] = 'null'
      headers.Origin = 'https://www.educoder.net'
      headers.Referer = 'https://www.educoder.net/login'
    } else if (account) {
      headers['Pc-Authorization'] = account.session
      headers.Cookie = 'autologin_trustie=' + account.autologin + '; _educoder_session=' + account.session
    }
    const failure = mutation ? 'uncertain' : 'unavailable'
    try {
      const response = await request(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: withDeadline(timeoutMs, signal),
      })
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => {})
        fail(login ? 'manual_required' : 'auth_required')
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        fail(failure)
      }
      const data = await readJson(response, failure)
      responseStatus(data, login, mutation)
      if (account && data.user_id !== undefined && positiveId(data.user_id) !== account.remoteUserId) {
        fail('invalid_scope')
      }
      return { data, response }
    } catch (error) {
      if (error instanceof TransportError) throw error
      fail(signal?.aborted && !mutation ? 'aborted' : failure)
    }
  }

  async function coursePage(account, page, limit, signal) {
    const { data } = await call('GET', '/courses.json', {
      account, signal, query: { page, limit, order: 'mine', search: '' },
    })
    if (!Array.isArray(data.courses) || data.login === 'guest' ||
        (data.login !== undefined && data.login !== account.zzud)) fail('auth_required')
    return { courses: data.courses, verified: data.user_id !== undefined }
  }

  async function courses(session, options) {
    const signal = readSignal(options)
    const account = cleanSession(session)
    const result = new Map()
    const pageSize = 20
    for (let page = 1; page <= 50; page++) {
      const { courses: list } = await coursePage(account, page, pageSize, signal)
      const before = result.size
      for (const item of list) {
        if (!record(item)) fail('unavailable')
        const id = identifier(item.identifier)
        result.set(id, { id, title: text(redact(typeof item.name === 'string' ? item.name : '', accountSecrets(account))) || id })
      }
      if (list.length < pageSize || result.size === before) break
    }
    return [...result.values()]
  }

  async function homeworks(session, courseId, options) {
    const signal = readSignal(options)
    const account = cleanSession(session)
    const id = identifier(courseId)
    const result = new Map()
    const pageSize = 50
    for (let page = 1; page <= 20; page++) {
      const { data } = await call('GET', '/courses/' + id + '/homework_commons.json', {
        account, signal, query: { page, limit: pageSize, status: 0, id, type: 4, order: 0 },
      })
      if (!Array.isArray(data.homeworks)) fail('unavailable')
      const before = result.size
      for (const item of data.homeworks) {
        if (!record(item)) fail('unavailable')
        const id = positiveId(item.homework_id)
        result.set(id, {
          id,
          title: text(redact(typeof item.name === 'string' ? item.name : '', accountSecrets(account))) || id,
          taskCount: Number.isSafeInteger(item.challenge_count) ? item.challenge_count : 0,
          passedCount: Number.isSafeInteger(item.finished_challenge_count) ? item.finished_challenge_count : 0,
          practiceId: item.myshixun_identifier ? identifier(item.myshixun_identifier) : undefined,
        })
      }
      if (data.homeworks.length < pageSize || result.size === before) break
    }
    return [...result.values()]
  }

  async function rawTask(account, scope, taskId, practiceId, signal) {
    const { data } = await call('GET', '/tasks/' + taskId + '.json', {
      account, signal, query: { homework_common_id: scope.homeworkId },
    })
    return { raw: data, task: normalizeTask(data, scope, account, taskId, practiceId, Boolean(terminalRunner)) }
  }

  async function pinnedTask(session, target, signal) {
    const account = cleanSession(session)
    const binding = readBinding(target)
    if (binding.remoteUserId !== account.remoteUserId) fail('invalid_scope')
    const response = await rawTask(account, binding, binding.taskId, binding.practiceId, signal)
    sameTask(response.task.binding, binding)
    return { account, ...response }
  }

  async function inspect(session, target, options) {
    const signal = readSignal(options)
    if (target?.binding || target?.taskId) {
      const { account, task } = await pinnedTask(session, target, signal)
      if (target.advanceTo === undefined) return task
      const nextId = identifier(target.advanceTo)
      if (task.state !== 'passed' || task.nextTaskId !== nextId) fail('invalid_scope')
      return (await rawTask(account, task.binding, nextId, task.binding.practiceId, signal)).task
    }
    const account = cleanSession(session)
    const scope = readScope(target)
    if (!(await courses(account, signal)).some(course => course.id === scope.courseId)) fail('invalid_scope')
    const homework = (await homeworks(account, scope.courseId, signal)).find(item => item.id === scope.homeworkId)
    if (!homework) fail('invalid_scope')
    if (!homework.practiceId) fail('manual_required')
    const { data } = await call('GET', '/myshixuns/' + homework.practiceId + '.json', { account, signal })
    if (!data.game_identifier) fail('manual_required')
    let taskId = identifier(data.game_identifier)
    const visited = new Set()
    // The platform can return the last visited level. Walk only the selected
    // practice's previous links so a previously skipped level is not lost.
    while (visited.size < 100) {
      if (visited.has(taskId)) fail('manual_required')
      visited.add(taskId)
      const { raw, task } = await rawTask(account, scope, taskId, homework.practiceId, signal)
      if (!raw.prev_game) return task
      taskId = identifier(raw.prev_game)
    }
    fail('manual_required')
  }

  function checkPath(task, path) {
    if (task.kind !== 'code') fail('manual_required')
    if (!safePath(path) || !task.paths.includes(path)) fail('invalid_scope')
  }

  function mutationAllowed(task) {
    if (task.evaluating || task.state === 'passed') fail('uncertain')
  }

  async function readFile(session, target, path, options) {
    const signal = readSignal(options)
    const { account, raw, task } = await pinnedTask(session, target, signal)
    checkPath(task, path)
    const { data } = await call('GET', '/tasks/' + task.binding.taskId + '/rep_content.json', {
      account, signal, query: { path, homework_common_id: task.binding.homeworkId, exercise_id: '' },
    })
    const content = data.content?.content
    if (typeof content !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(content) ||
        content.length > maxCodeBytes * 2) fail('unavailable')
    try {
      const decoded = Buffer.from(content, 'base64')
      if (decoded.byteLength > maxCodeBytes || decoded.toString('base64') !== content) fail('unavailable')
      const code = new TextDecoder('utf-8', { fatal: true }).decode(decoded)
      if (redact(code, [...accountSecrets(account), raw.sec_key]) !== code) fail('manual_required')
      return code
    } catch (error) {
      if (error instanceof TransportError) throw error
      fail('unavailable')
    }
  }

  function rememberProof(binding, value) {
    const proof = Object.freeze({ kind: value.kind })
    proofs.set(proof, { binding, ...value })
    return proof
  }

  async function saveFile(session, target, path, content, options) {
    const signal = readSignal(options)
    if (typeof content !== 'string' || Buffer.byteLength(content) > maxCodeBytes) fail('invalid_scope')
    const { account, raw, task } = await pinnedTask(session, target, signal)
    checkPath(task, path)
    mutationAllowed(task)
    const binding = task.binding
    const { data } = await call('POST', '/myshixuns/' + binding.practiceId + '/update_file.json', {
      account,
      signal,
      mutation: true,
      body: {
        path,
        evaluate: task.paths.length > 1 ? 0 : 1,
        content,
        game_id: Number(binding.gameId),
        tab_type: 1,
        homework_common_id: Number(binding.homeworkId),
        extras: buildExtras(binding),
      },
    })
    return rememberProof(binding, {
      kind: 'code',
      commitId: checkedToken(data.content?.commitID, 'uncertain'),
      secKey: checkedToken(data.sec_key || raw.sec_key, 'uncertain'),
    })
  }

  async function runTerminal(session, target, command, options) {
    const signal = readSignal(options)
    if (!terminalRunner) fail('manual_required')
    if (typeof command !== 'string' || !command.trim() || Buffer.byteLength(command) > 8192 ||
        /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(command)) fail('invalid_scope')
    const { account, raw, task } = await pinnedTask(session, target, signal)
    if (!task.terminalAvailable) fail('manual_required')
    mutationAllowed(task)
    const binding = task.binding
    const { shixun_environment_id: environmentId } = terminalEnvironment(raw)
    const { data } = await call('GET', '/myshixuns/' + binding.practiceId + '/start.json', {
      account,
      signal,
      mutation: true,
      query: {
        shixun_environment_id: environmentId,
        tab_type: 4,
        game_id: binding.gameId,
        homework_common_id: binding.homeworkId,
      },
    })
    if (data.status !== 0 || !record(data.data)) fail('uncertain')
    const connection = data.data
    let endpoint
    try {
      endpoint = new URL(connection.webssh_url || connection.link_url)
    } catch {
      fail('manual_required')
    }
    if (endpoint.protocol !== 'wss:' || (endpoint.port && endpoint.port !== '443') ||
        endpoint.username || endpoint.password || endpoint.hash ||
        !allowedTerminalHosts.has(endpoint.hostname)) fail('manual_required')
    const host = checkedToken(connection.ssh_address || connection.host, 'manual_required')
    if (!/^[a-zA-Z0-9:.-]+$/.test(host)) fail('manual_required')
    const port = Number(connection.port)
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) fail('manual_required')
    const username = checkedToken(connection.username, 'manual_required')
    const password = checkedToken(connection.password, 'manual_required')
    const runnerSignal = withDeadline(timeoutMs, signal)
    if (runnerSignal.aborted) fail('uncertain')
    let result
    let onAbort
    try {
      const deadline = new Promise((_, reject) => {
        onAbort = () => reject(new TransportError('uncertain'))
        runnerSignal.addEventListener('abort', onAbort, { once: true })
      })
      // The trusted runner must only connect through the validated WSS endpoint.
      // SSH metadata belongs in the EduCoder gateway handshake.
      result = await Promise.race([
        deadline,
        terminalRunner({ endpoint: endpoint.href, host, port, username, password, command, signal: runnerSignal }),
      ])
    } catch {
      fail('uncertain')
    } finally {
      runnerSignal.removeEventListener('abort', onAbort)
    }
    if (runnerSignal.aborted || !record(result) || typeof result.output !== 'string' ||
        Buffer.byteLength(result.output) > maxResponseBytes || !Number.isInteger(result.exitCode)) fail('uncertain')
    const cleanOutput = result.output
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    return {
      output: redact(cleanOutput, [...accountSecrets(account), password, endpoint.href,
        ...endpoint.searchParams.values()]).slice(0, maxTerminalOutput),
      exitCode: result.exitCode,
      proof: result.exitCode === 0 ? rememberProof(binding, { kind: 'terminal', environmentId }) : undefined,
    }
  }

  async function evaluate(session, target, proof, options) {
    const signal = readSignal(options)
    const { account, raw, task } = await pinnedTask(session, target, signal)
    if (task.kind !== 'code' && !task.terminalAvailable) fail('manual_required')
    mutationAllowed(task)
    const binding = task.binding
    const receipt = proofs.get(proof)
    if (!receipt || receipt.kind !== task.kind) fail('invalid_scope')
    sameTask(receipt.binding, binding)
    const terminal = task.kind === 'terminal'
    const env = terminal ? terminalEnvironment(raw) :
      (Array.isArray(raw.shixun_environments) ? raw.shixun_environments : []).find(item => item?.tab_type === 1)
    const environmentId = env?.shixun_environment_id ?? 0
    if (!Number.isSafeInteger(environmentId) || environmentId < 0 ||
        (terminal && environmentId !== receipt.environmentId)) fail('manual_required')
    const secKey = terminal ? checkedToken(raw.sec_key, 'manual_required') : receipt.secKey
    proofs.delete(proof)
    const { data } = await call('POST', '/tasks/' + binding.taskId + '/game_build.json', {
      account,
      signal,
      mutation: true,
      body: {
        sec_key: secKey,
        resubmit: '',
        first: 1,
        content_modified: 0,
        shixun_environment_id: environmentId,
        tab_type: terminal ? 4 : 1,
        extras: { ...buildExtras(binding), commitID: receipt.commitId ?? '' },
      },
    })
    if (data.res?.code !== undefined && data.res.code !== 0) fail('uncertain')
  }

  return {
    async login(login, password) {
      if (typeof login !== 'string' || !login.trim() || login.length > 254 ||
          typeof password !== 'string' || !password || password.length > 1024) fail('invalid_credentials')
      const { data, response } = await call('POST', '/accounts/login.json', {
        login: true, body: { login: login.trim(), password, autologin: true, tl: null, source: null },
      })
      const remoteUserId = positiveId(data.user_id, 'manual_required')
      const session = {
        zzud: checkedToken(data.login || login.trim(), 'manual_required'),
        autologin: readCookie(response.headers, 'autologin_trustie'),
        session: readCookie(response.headers, '_educoder_session'),
        remoteUserId,
      }
      await coursePage(session, 1, 1)
      return { session, remoteUserId, label: maskedLogin(session.zzud), verified: true }
    },
    async status(session, target) {
      const account = cleanSession(session)
      const label = maskedLogin(account.zzud)
      if (target !== undefined) {
        await inspect(account, target)
        return { remoteUserId: account.remoteUserId, label, verified: true }
      }
      const { verified } = await coursePage(account, 1, 1)
      return { remoteUserId: account.remoteUserId, label, verified }
    },
    courses,
    async homeworks(session, courseId, options) {
      if (!(await courses(session, options)).some(course => course.id === identifier(courseId))) fail('invalid_scope')
      return (await homeworks(session, courseId, options)).map(({ practiceId, ...safe }) => safe)
    },
    inspect,
    readFile,
    saveFile,
    runTerminal,
    evaluate,
  }
}

function buildExtras(binding) {
  return {
    challenge_id: Number(binding.challengeId),
    homework_common_id: Number(binding.homeworkId),
    currentUserId: Number(binding.remoteUserId),
    exercise_id: '',
    question_id: '',
    subject_id: '',
    competition_entry_id: '',
  }
}
