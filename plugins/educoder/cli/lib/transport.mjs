// EduCoder protocol reference (MIT, © 2026 chumeng):
// https://github.com/lihaoze123/educoder-cli/tree/5e76e15ffcb364edecde74381577d8f7f4470dcf
// Additional protocol observations (HTTP 200 with status 401, choice shape, staged writes):
// https://github.com/isheng-eqi/dsh-educoder/tree/392a88bcb695f8a12ad2b7d76e2ea455105e092f
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { TerminalNotReadyError } from './terminal.mjs'
import { createStatementImageParser, fetchStatementImage, maxImageBatchBytes } from './images.mjs'

const productionUrl = 'https://data.educoder.net/api'
const maxResponseBytes = 4 * 1024 * 1024
const maxCodeBytes = 1024 * 1024
const maxTerminalOutput = 16_000
const maxChoiceQuestions = 200
const choiceOptionIds = 'ABCDEFGHIJKLMN'

const errorMessages = {
  aborted: 'EduCoder 操作已取消。',
  auth_required: 'EduCoder 登录已失效，请重新登录。',
  choice_changed: 'EduCoder 题目或选项已更新，请重新读取关卡。',
  choice_closed: 'EduCoder 已关闭当前关卡的评测。',
  invalid_credentials: 'EduCoder 拒绝了账号或密码。',
  invalid_input: '请按当前关卡的题目顺序提供完整且有效的答案。',
  invalid_scope: 'EduCoder 返回的账号、课程、作业或关卡与选定范围不符。',
  manual_required: 'EduCoder 需要人工处理当前账号或任务。',
  not_found: 'EduCoder 未找到指定的实训入口。',
  image_unavailable: 'EduCoder 题面图片暂不可用。',
  course_limit: '该课程作业超过一键通关的 1000 项上限。',
  signature_error: 'EduCoder 请求签名校验失败，请核对配置与系统时间。',
  unavailable: 'EduCoder 暂时不可用或返回了无法识别的数据。',
  uncertain: 'EduCoder 写入结果未知，请先核对远端状态。',
  already_passed: '头歌已确认当前关卡通过。',
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

function visibleField(value, visible, project) {
  if (typeof value !== 'string' || !(visible == null || visible === true || visible === 1)) return undefined
  return project(value)
}

function choiceQuestions(raw, project) {
  if (!Array.isArray(raw) || !raw.length || raw.length > maxChoiceQuestions) return null
  const questions = []
  for (const question of raw) {
    if (typeof question?.subject !== 'string' || !question.subject.trim()) return null
    const prompt = project(question.subject, 8_000)
    if (question.question_name === '判断题') {
      questions.push({ type: 'judge', prompt })
    } else if (question.question_name === '填空题') {
      const blankCount = question.multi_count
      if (!Number.isSafeInteger(blankCount) || blankCount < 1 || blankCount > 30) return null
      questions.push({ type: 'fill', prompt, blankCount })
    } else if (['单选题/多选题', '单选题', '多选题'].includes(question.question_name)) {
      const options = question.challenge_question
      if (!Array.isArray(options) || options.length < 2 || options.length > choiceOptionIds.length ||
          !options.every(option => typeof option?.option_name === 'string' && option.option_name.trim())) return null
      const single = question.question_name === '单选题' ||
        (question.question_name === '单选题/多选题' && question.category === 1)
      questions.push({
        type: single ? 'single' : 'multiple',
        prompt,
        options: options.map((option, index) => ({ id: choiceOptionIds[index], text: project(option.option_name, 4_000) })),
      })
    } else {
      return null
    }
  }
  return questions
}

function choiceScore(raw, count, publicResults) {
  const total = raw?.challenge_chooses_count
  const correct = raw?.choose_correct_num
  if (!Number.isSafeInteger(total) || total < 1 || total > maxChoiceQuestions ||
      (count !== undefined && total !== count) ||
      !Number.isSafeInteger(correct) || correct < 0 || correct > total) return null
  const tests = raw.test_sets
  const results = Array.isArray(tests) && tests.length === total &&
    tests.every(item => typeof item?.result === 'boolean') ? tests.map(item => item.result) : null
  if (results && results.filter(Boolean).length !== correct) return null
  return { correct, total, publicResults, ...(publicResults && results ? { results } : {}) }
}

function choiceAnswers(questions, answers) {
  if (!Array.isArray(answers) || answers.length !== questions.length) fail('invalid_input')
  return questions.map((question, index) => {
    const answer = answers[index]
    if (question.type === 'fill') {
      if (!Array.isArray(answer) || answer.length !== question.blankCount ||
          ![...answer].every(value => typeof value === 'string' && value.length <= 2_000 && value.trim())) {
        fail('invalid_input')
      }
      return [...answer]
    }
    if (question.type === 'judge') {
      if (typeof answer === 'boolean') return String(answer)
      if (answer !== 'true' && answer !== 'false') fail('invalid_input')
      return answer
    }
    const selections = question.type === 'multiple' && Array.isArray(answer) ? [...answer] :
      typeof answer === 'string' ? [...answer] : []
    if (!selections.length || selections.length > question.options.length ||
        (question.type === 'single' && selections.length !== 1)) fail('invalid_input')
    const selected = new Set(selections)
    if (selected.size !== selections.length || selections.some(id => !question.options.some(option => option.id === id))) {
      fail('invalid_input')
    }
    return [...selected].sort().join('')
  })
}

function choiceState(score, submitted) {
  if (score && score.correct === score.total) return 'passed'
  if (score && submitted) return 'failed'
  return 'pending'
}

function normalizeTask(raw, scope, account, taskId, practiceId, supportsTerminal) {
  const { game, challenge, user } = raw
  if (!record(game) || !record(challenge) || !record(user)) fail('unavailable')
  const ownerId = positiveId(user.user_id)
  if (ownerId !== account.remoteUserId || identifier(game.identifier) !== taskId ||
      positiveId(raw.homework_common_id) !== scope.homeworkId) fail('invalid_scope')
  if (raw.course_identifier && identifier(raw.course_identifier) !== scope.courseId) fail('invalid_scope')
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
  const editor = environments.some(env => env?.tab_type === 1)
  const gui = environments.some(env => env?.tab_type === 3)
  const terminal = environments.some(env => env?.tab_type === 4)
  const choice = Boolean(raw.choose_test_cases?.test_sets?.length || raw.choose_test_cases?.challenge_chooses_count > 0 ||
    raw.choose_test_cases?.choose_test_cases?.length || raw.choose_test_cases?.choose_test_cases_count > 0 ||
    (Array.isArray(raw.chooses) && raw.chooses.length))
  const publicText = (value, limit) => typeof value === 'string' ? text(redact(value, secrets), limit) : ''
  const questions = choice ? choiceQuestions(raw.chooses, publicText) : null
  const count = Array.isArray(raw.chooses) && raw.chooses.length ? raw.chooses.length : undefined
  const score = choice ? choiceScore(raw.choose_test_cases, count,
    raw.shixun_choice_public_result === true || raw.shixun_choice_public_result === 1) : null
  const status = game.status
  const choiceSubmitted = [2, 3].includes(status) || [true, 1].includes(raw.choose_test_cases?.had_submmit)
  // 混合关卡也可能提供可读写的代码编辑器。代码能力优先于命令行和图形环境。
  const kind = choice ? questions ? 'choice' : 'manual' : editor && paths.length ? 'code' :
    gui ? 'manual' : terminal ? 'terminal' : paths.length ? 'code' : 'manual'
  const evaluateCount = Number.isSafeInteger(game.evaluate_count) && game.evaluate_count >= 0
    ? game.evaluate_count : null
  const testSets = Array.isArray(raw.test_sets) ? raw.test_sets : []
  // 平台也会在 game.status=0 时返回已判定的失败用例。只保留判定标记，不保留隐藏用例内容。
  const failedVerdict = testSets.length > 0 && testSets.every(item => typeof item?.result === 'boolean') &&
    testSets.some(item => item.result === false)
    ? createHash('sha256').update(JSON.stringify(testSets.map(item => item.result))).digest('hex') : null
  const task = {
    binding,
    kind,
    // 头歌可能在选择题有错时也将关卡状态置为 2。只按已提交的答对题数认定通过。
    state: choice ? choiceState(score, choiceSubmitted) : status === 2 ? 'passed' : status === 3 ? 'failed' : 'pending',
    evaluating: status === 1 || (choice && choiceSubmitted && !score),
    title: publicText(challenge.subject),
    instructions: publicText(challenge.description || challenge.task_pass || game.description, 24_000),
    terminalAvailable: (kind === 'code' || kind === 'terminal') && supportsTerminal && terminalEnvironment(raw) !== null,
    paths: kind === 'code' ? paths : [],
    marker: evaluateCount === null ? '' : String(evaluateCount),
    failedVerdict: choice ? null : failedVerdict,
    ...(questions ? { questions } : {}),
    feedback: {
      compiler: publicText(raw.last_compile_output, 6_000),
      ...(score ? { choice: score } : {}),
      publicTests: testSets.filter(item => item?.is_public === true && item.is_invisible !== true && item.is_invisible !== 1)
        .slice(0, 16).map(item => ({
          passed: item.result === true,
          input: visibleField(item.input, item.input_visible, publicText),
          expected: visibleField(item.output, item.output_visible, publicText),
          actual: visibleField(item.actual_output, item.actual_output_visible, publicText),
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
  const imageScopes = new WeakMap()

  async function call(method, path, { account, body, query, signal, login = false, mutation = false, detectNotFound = false } = {}) {
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
      const send = () => request(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: withDeadline(timeoutMs, signal),
      })
      let response
      const readOnly = method === 'GET' && !mutation
      try {
        response = await send()
      } catch (error) {
        if (!readOnly || signal?.aborted) throw error
      }
      if (!response || (readOnly && [502, 503, 504].includes(response.status))) {
        await response?.body?.cancel().catch(() => {})
        await delay(300, undefined, { signal })
        response = await send()
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => {})
        fail(login ? 'manual_required' : 'auth_required')
      }
      if (detectNotFound && response.status === 404) {
        await response.body?.cancel().catch(() => {})
        fail('not_found')
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
    const pages = 20
    const requireComplete = options?.requireComplete === true
    for (let page = 1; page <= pages + Number(requireComplete); page++) {
      const { data } = await call('GET', '/courses/' + id + '/homework_commons.json', {
        account, signal, query: { page, limit: pageSize, status: 0, id, type: 4, order: 0 },
      })
      if (!Array.isArray(data.homeworks)) fail('unavailable')
      const before = result.size
      for (const item of data.homeworks) {
        if (!record(item)) fail('unavailable')
        const id = positiveId(item.homework_id)
        if (requireComplete && !result.has(id) && (page > pages || result.size >= pageSize * pages)) {
          fail('course_limit')
        }
        result.set(id, {
          id,
          title: text(redact(typeof item.name === 'string' ? item.name : '', accountSecrets(account))) || id,
          taskCount: Number.isSafeInteger(item.challenge_count) ? item.challenge_count : 0,
          passedCount: Number.isSafeInteger(item.finished_challenge_count) ? item.finished_challenge_count : 0,
          practiceId: item.myshixun_identifier ? identifier(item.myshixun_identifier) : undefined,
          shixunId: item.shixun_identifier ? identifier(item.shixun_identifier) : undefined,
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
    // 未打开的作业从关卡详情取得该账号专属的实训实例标识。
    const instance = practiceId ?? identifier(data.myshixun?.identifier)
    const task = normalizeTask(data, scope, account, taskId, instance, Boolean(terminalRunner))
    const imageParser = createStatementImageParser(base.origin)
    task.instructions = imageParser.parse(task.instructions)
    for (const question of task.questions ?? []) {
      question.prompt = imageParser.parse(question.prompt)
      for (const option of question.options ?? []) option.text = imageParser.parse(option.text)
    }
    const { images, unavailable } = imageParser.result()
    task.imageCount = images.length
    task.imagesUnavailable = unavailable
    if (images.length) imageScopes.set(task, images)
    return { raw: data, task }
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
    let entry
    let practiceId = homework.practiceId
    if (practiceId) {
      try {
        const { data } = await call('GET', '/myshixuns/' + practiceId + '.json', { account, signal, detectNotFound: true })
        entry = data.game_identifier
      } catch (error) {
        if (error.code !== 'not_found') throw error
      }
    }
    // 此 GET 可能创建实训实例，只有开始执行指定作业时才能调用。
    if (!entry && homework.shixunId && options?.open === true) {
      const { data } = await call('GET', '/shixuns/' + homework.shixunId + '/shixun_exec.json', {
        account, signal, mutation: true, query: { homework_common_id: scope.homeworkId },
      })
      entry = data.game_identifier
    }
    if (!entry) fail('manual_required')
    let taskId = identifier(entry)
    const visited = new Set()
    // The platform can return the last visited level. Walk only the selected
    // practice's previous links so a previously skipped level is not lost.
    while (visited.size < 100) {
      if (visited.has(taskId)) fail('manual_required')
      visited.add(taskId)
      const { raw, task } = await rawTask(account, scope, taskId, practiceId, signal)
      practiceId = task.binding.practiceId
      if (!raw.prev_game) return task
      taskId = identifier(raw.prev_game)
    }
    fail('manual_required')
  }

  function checkPath(task, path) {
    if (task.kind !== 'code') fail('manual_required')
    if (!safePath(path) || !task.paths.includes(path)) fail('invalid_scope')
  }

  async function readStatementImages(task, { signal } = {}) {
    const images = imageScopes.get(task)
    if (!images) fail('image_unavailable')
    let remaining = maxImageBatchBytes
    const result = []
    try {
      for (const image of images) {
        signal?.throwIfAborted()
        const data = await fetchStatementImage(request, image, remaining, withDeadline(timeoutMs, signal), production)
        remaining -= data.byteLength
        result.push({ data, mediaType: image.mediaType, name: `参考图 ${image.index}` })
      }
    } catch {
      fail(signal?.aborted ? 'aborted' : 'image_unavailable')
    }
    return result
  }

  async function submitChoices(session, target, answers, options) {
    const signal = readSignal(options)
    const { account, raw, task } = await pinnedTask(session, target, signal)
    if (options?.questions !== undefined && JSON.stringify(task.questions) !== JSON.stringify(options.questions)) {
      fail('choice_changed')
    }
    if (task.kind !== 'choice') fail('manual_required')
    if (raw.work_end_forbid_evaluate) fail('choice_closed')
    mutationAllowed(task)
    const answer = choiceAnswers(task.questions, answers)
    if (Buffer.byteLength(JSON.stringify(answer)) > 96_000) fail('invalid_input')
    const { binding } = task
    const { data } = await call('POST', '/tasks/' + binding.taskId + '/choose_build.json', {
      account,
      signal,
      mutation: true,
      body: {
        answer,
        challenge_id: Number(binding.challengeId),
        subject_id: '',
        homework_common_id: Number(binding.homeworkId),
      },
    })
    const score = choiceScore(data, task.questions.length,
      raw.shixun_choice_public_result === true || raw.shixun_choice_public_result === 1)
    if (!score) fail('uncertain')
    return { state: choiceState(score, true), ...score }
  }

  function mutationAllowed(task) {
    if (task.evaluating || task.state === 'passed') fail('uncertain')
  }

  async function readFile(session, target, path, options) {
    const signal = readSignal(options)
    const { account, raw, task } = await pinnedTask(session, target, signal)
    checkPath(task, path)
    const decoded = await readFileBytes(account, task.binding, path, signal)
    try {
      const code = new TextDecoder('utf-8', { fatal: true }).decode(decoded)
      if (redact(code, [...accountSecrets(account), raw.sec_key]) !== code) fail('manual_required')
      return code
    } catch (error) {
      if (error instanceof TransportError) throw error
      fail('unavailable')
    }
  }

  async function readFileBytes(account, binding, path, signal) {
    const { data } = await call('GET', '/tasks/' + binding.taskId + '/rep_content.json', {
      account, signal, query: { path, homework_common_id: binding.homeworkId, exercise_id: '' },
    })
    const content = data.content?.content
    if (typeof content !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(content) ||
        content.length > maxCodeBytes * 2) fail('unavailable')
    const decoded = Buffer.from(content, 'base64')
    if (decoded.byteLength > maxCodeBytes || decoded.toString('base64') !== content) fail('unavailable')
    return decoded
  }

  function rememberProof(binding, value) {
    const proof = Object.freeze({ kind: value.kind })
    proofs.set(proof, { binding, ...value })
    return proof
  }

  async function recoverCodeWrite(session, target, { path, content, marker } = {}, options) {
    if (typeof content !== 'string' || Buffer.byteLength(content) > maxCodeBytes ||
        typeof marker !== 'string' || !/^\d+$/u.test(marker)) fail('uncertain')
    const signal = readSignal(options)
    const before = await pinnedTask(session, target, signal)
    checkPath(before.task, path)
    mutationAllowed(before.task)
    if (before.task.marker !== marker) fail('uncertain')
    const commitId = checkedToken(before.raw.myshixun?.commit_id, 'uncertain')

    // 仅核对本关卡提交的原始字节，读取前后平台提交编号和评测计数必须一致。
    const remote = await readFileBytes(before.account, before.task.binding, path, signal)
    const after = await pinnedTask(session, target, signal)
    checkPath(after.task, path)
    mutationAllowed(after.task)
    if (after.task.marker !== marker || after.raw.myshixun?.commit_id !== commitId) fail('uncertain')
    if (!remote.equals(Buffer.from(content, 'utf8'))) {
      if (options?.readCurrent) return undefined
      fail('uncertain')
    }
    const secKey = after.raw.sec_key ?? ''
    return rememberProof(after.task.binding, {
      kind: 'code', commitId, secKey: secKey === '' ? '' : checkedToken(secKey, 'uncertain'), marker,
    })
  }

  async function confirmCurrentCode(session, target, marker, { signal } = {}) {
    const before = await pinnedTask(session, target, signal)
    if (before.task.kind !== 'code' || before.task.paths.length !== 1 || before.task.marker !== marker ||
        !/^\d+$/u.test(marker) || before.task.evaluating || before.task.state === 'passed') return false
    const commit = checkedToken(before.raw.myshixun?.commit_id, 'uncertain')
    const [path] = before.task.paths
    const first = await readFileBytes(before.account, before.task.binding, path, signal)
    const second = await readFileBytes(before.account, before.task.binding, path, signal)
    const after = await pinnedTask(session, target, signal)
    return after.task.kind === 'code' && after.task.paths.length === 1 && after.task.paths[0] === path &&
      !after.task.evaluating && after.task.state !== 'passed' && after.task.marker === marker &&
      after.raw.myshixun?.commit_id === commit && first.equals(second)
  }

  async function saveFile(session, target, path, content, options) {
    const signal = readSignal(options)
    if (typeof content !== 'string' || Buffer.byteLength(content) > maxCodeBytes) fail('invalid_scope')
    const { account, raw, task } = await pinnedTask(session, target, signal)
    checkPath(task, path)
    if (task.state === 'passed') fail('already_passed')
    mutationAllowed(task)
    const binding = task.binding
    const { data } = await call('POST', '/myshixuns/' + binding.practiceId + '/update_file.json', {
      account,
      signal,
      mutation: true,
      body: {
        path,
        // 保存只更新文件，评测由单独的 game_build 明确触发。
        evaluate: 0,
        content,
        game_id: Number(binding.gameId),
        tab_type: 1,
        homework_common_id: Number(binding.homeworkId),
        extras: buildExtras(binding),
      },
    })
    const savedKey = data.sec_key ?? ''
    const secKey = savedKey === '' ? raw.sec_key ?? '' : savedKey
    return rememberProof(binding, {
      kind: 'code',
      commitId: checkedToken(data.content?.commitID, 'uncertain'),
      secKey: secKey === '' ? '' : checkedToken(secKey, 'uncertain'),
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
      // 头歌终端页使用 link_url。webssh_url 在正式环境中也可能是普通 HTTP 地址。
      endpoint = new URL(connection.link_url || connection.webssh_url)
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
    const runnerSignal = withDeadline(75_000, signal)
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
    } catch (error) {
      if (error instanceof TerminalNotReadyError && !runnerSignal.aborted) {
        return { exitCode: 125, output: '未连接到关卡终端，命令没有发出。', notAvailable: true }
      }
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
    if (!receipt) fail('invalid_scope')
    sameTask(receipt.binding, binding)
    if (receipt.marker !== undefined && (task.marker !== receipt.marker || raw.myshixun?.commit_id !== receipt.commitId)) {
      fail('uncertain')
    }
    const terminal = receipt.kind === 'terminal'
    if (terminal ? !task.terminalAvailable : task.kind !== 'code') fail('invalid_scope')
    const env = terminal ? terminalEnvironment(raw) :
      (Array.isArray(raw.shixun_environments) ? raw.shixun_environments : []).find(item => item?.tab_type === 1)
    const environmentId = env?.shixun_environment_id ?? 0
    if (!Number.isSafeInteger(environmentId) || environmentId < 0 ||
        (terminal && environmentId !== receipt.environmentId)) fail('manual_required')
    let secKey = receipt.secKey
    if (terminal) {
      const terminalKey = raw.sec_key ?? ''
      secKey = terminalKey === '' ? '' : checkedToken(terminalKey, 'manual_required')
    }
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
      return (await homeworks(session, courseId, options)).map(({ practiceId, shixunId, ...safe }) => safe)
    },
    inspect,
    readStatementImages,
    submitChoices,
    readFile,
    saveFile,
    recoverCodeWrite,
    confirmCurrentCode,
    runTerminal,
    evaluate,
    exportProof(proof) {
      const entry = proofs.get(proof)
      return entry ? structuredClone(entry) : undefined
    },
    restoreProof(data) {
      if (!data || typeof data !== 'object' || !data.binding) fail('invalid_scope')
      const { binding, ...rest } = data
      return rememberProof(binding, rest)
    },
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
