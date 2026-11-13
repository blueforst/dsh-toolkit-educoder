// EduCoder 和 Pi 的独立 HTTP 替身。只监听共享测试容器的回环接口。
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as wait } from 'node:timers/promises';
import { crc32, deflateSync } from 'node:zlib';

const port = Number(process.env.EDUCODER_FIXTURE_PORT || 9299);
const identities = new Map();
const groupActivity = new Map();
let rejectedScope = 0;
let modelRequests = 0;
const codePath = 'src/main.py';
const experienceNote = group => `修改程序后用公开样例确认输出格式。验收标记 ${group.slice(-10)}。`;

function pngChunk(name, data) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(name, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

function quadrantImage(topLeft) {
  const side = 96;
  const stride = side * 3 + 1;
  const pixels = Buffer.alloc(stride * side);
  const colors = [topLeft, [255, 255, 0], [0, 255, 0], [255, 255, 255]];
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const rgb = colors[Number(x >= side / 2) + 2 * Number(y >= side / 2)];
      pixels.set(rgb, y * stride + 1 + 3 * x);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header[8] = 8;
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const visionImages = [
  { color: 'red', bytes: quadrantImage([255, 0, 0]) },
  { color: 'blue', bytes: quadrantImage([0, 0, 255]) },
];

function codeForColor(color) {
  return 'print(' + JSON.stringify(color) + ')\n';
}

function challengeText(identity) {
  let task = '请读取代码、写入本账号的答案并评测。';
  if (identity.resume) task += '\nSESSION_REUSE_FIXTURE';
  if (identity.vision) {
    const imageUrl = identity.attachmentPath + '?type=image/png';
    const embedded = identity.login.endsWith('-alice') ? `![参考图](${imageUrl})` : `<img src="${imageUrl}" alt="参考图">`;
    task = '请读取代码，并让程序用英语输出参考图左上角的颜色。\n' + embedded;
  }
  return 'SMOKE_TARGET=' + identity.game + '\n' + task
    + '\n认证字段脱敏校验 ' + identity.auto + ' ' + identity.session + ' ' + identity.proof;
}

function identityFor(login) {
  const account = typeof login === 'string' && /^educoder-(smoke|ui|course-ui|vision|workspace|resume|stages)-[a-f0-9]{10}-(alice|bob|missing)$/.exec(login);
  if (!account) return null;
  const [, mode, name] = account;
  if (name === 'missing' && mode !== 'vision') return null;
  if (!identities.has(login)) {
    const user = Number.parseInt(createHash('sha256').update(login).digest('hex').slice(0, 11), 16) + 1;
    const key = 'fixture-' + user;
    const vision = mode === 'vision' ? visionImages[name === 'bob' ? 1 : 0] : undefined;
    const identity = {
      login,
      group: login.slice('educoder-'.length, login.lastIndexOf('-')),
      user,
      key,
      game: 'game-' + key,
      practice: 'practice-' + key,
      course: 'course-' + key,
      courseTitle: '模拟课程 ' + key,
      homework: user + 1,
      gameId: user + 2,
      auto: 'private-auto-' + key,
      session: 'private-session-' + key,
      proof: 'private-proof-' + key,
      commit: 'commit-' + key,
      solution: vision ? codeForColor(vision.color) : 'print(' + JSON.stringify(key) + ')\n',
      vision,
      workspace: mode === 'workspace' ? name : undefined,
      resume: mode === 'resume' ? { accepted: [] } : undefined,
      attachmentPath: vision ? '/api/attachments/VisionFixture' + user : undefined,
      missingImage: name === 'missing',
      imageDownloads: 0,
      imageRequests: 0,
      saves: 0,
      builds: 0,
      readback: 0,
      fileReads: 0,
      modelCalls: 0,
      passed: false,
      expired: false,
    };
    identities.set(login, identity);
    if (mode === 'stages') {
      const stages = [identity, {
        ...identity,
        key: 'fixture-' + (user + 100),
        game: 'game-fixture-' + (user + 100),
        gameId: user + 102,
        proof: 'private-proof-fixture-' + (user + 100),
        commit: 'commit-fixture-' + (user + 100),
      }];
      for (const [index, game] of stages.entries()) {
        const figure = visionImages[index];
        Object.assign(game, {
          stages, index, vision: figure, codePath: index === 0 ? 'src/first.py' : 'src/second.py',
          challengeId: 701 + index, solution: codeForColor(figure.color),
          attachmentPath: '/api/attachments/StageFixture' + user + '-' + index,
        });
      }
    }
    if (mode === 'course-ui' && name === 'alice') {
      identity.extraAssignments = [[10, false, false], [20, true, false], [30, false, true]]
        .map(([offset, passed, otherCourse]) => {
          const key = 'fixture-' + (user + offset);
          return {
            ...identity,
            key,
            game: 'game-' + key,
            practice: 'practice-' + key,
            course: otherCourse ? 'course-' + key : identity.course,
            courseTitle: otherCourse ? '模拟课程 ' + key : identity.courseTitle,
            homework: identity.homework + offset,
            gameId: identity.gameId + offset,
            proof: 'private-proof-' + key,
            commit: 'commit-' + key,
            solution: 'print(' + JSON.stringify(key) + ')\n',
            passed,
          };
        });
    }
  }
  return identities.get(login);
}

function assignments(identity) {
  return [identity, ...(identity.extraAssignments ?? [])];
}

function games(identity) {
  return identity.stages ?? assignments(identity);
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > 2_000_000) throw new Error('fixture request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function ownsRequest(request, url, identity) {
  return identity && request.headers['x-edu-type'] === 'pc'
    && request.headers['pc-authorization'] === identity.session
    && request.headers.cookie === 'autologin_trustie=' + identity.auto + '; _educoder_session=' + identity.session
    && url.searchParams.get('zzud') === identity.login;
}

function reject(response) {
  rejectedScope++;
  return json(response, 403, { status: -1, message: 'fixture scope denied' });
}

async function edu(request, response, url) {
  const path = url.pathname;
  if (request.method === 'GET' && path.startsWith('/api/attachments/')) {
    const identity = [...identities.values()].flatMap(games).find(item => item.attachmentPath === path);
    if (!identity || url.searchParams.size !== 1 || url.searchParams.get('type') !== 'image/png' || request.headers.cookie
        || request.headers.authorization || request.headers['pc-authorization']) return reject(response);
    identity.imageDownloads++;
    if (identity.missingImage) return json(response, 404, {});
    response.writeHead(200, { 'content-type': 'image/png', 'content-length': identity.vision.bytes.length });
    return response.end(identity.vision.bytes);
  }
  if (request.method === 'POST' && path === '/api/accounts/login.json') {
    const input = await readJson(request);
    if (benchmark?.matches(input.login)) return benchmark.login(request, response, input);
    const identity = identityFor(input.login);
    if (request.headers['pc-authorization'] !== 'null' || request.headers.cookie) return reject(response);
    if (!identity || input.password !== 'fake-password-' + input.login) {
      return json(response, 200, { status: -3, message: input.password });
    }
    identity.expired = false;
    return json(response, 200, { user_id: identity.user, login: identity.login }, {
      'set-cookie': [
        'autologin_trustie=' + identity.auto + '; HttpOnly; Secure',
        '_educoder_session=' + identity.session + '; HttpOnly; Secure',
      ],
    });
  }
  if (benchmark?.matches(url.searchParams.get('zzud'))) return benchmark.edu(request, response, url);
  let identity = identities.get(url.searchParams.get('zzud'));
  if (!ownsRequest(request, url, identity)) return reject(response);
  if (identity.expired) return json(response, 401, {});

  if (request.method === 'GET') {
    if (path === '/api/courses.json') {
      const courses = [...new Map(assignments(identity).map(({ course, courseTitle }) => [
        course, { identifier: course, name: courseTitle },
      ])).values()];
      return json(response, 200, { login: identity.login, user_id: identity.user, courses });
    }
    const inCourse = assignments(identity).filter(item => path === '/api/courses/' + item.course + '/homework_commons.json');
    if (inCourse.length) {
      return json(response, 200, { homeworks: inCourse.map(item => ({
        homework_id: item.homework,
        name: '模拟作业 ' + item.key,
        myshixun_identifier: item.practice,
        challenge_count: item.stages?.length ?? 1,
        finished_challenge_count: item.stages ? item.stages.filter(game => game.passed).length : Number(item.passed),
      })) });
    }
    const practice = assignments(identity).find(item => path === '/api/myshixuns/' + item.practice + '.json');
    if (practice) return json(response, 200, { game_identifier: practice.game });
    identity = games(identity).find(item => url.searchParams.get('homework_common_id') === String(item.homework)
      && [`/api/tasks/${item.game}.json`, `/api/tasks/${item.game}/rep_content.json`].includes(path));
    if (!identity) return reject(response);
    if (path === '/api/tasks/' + identity.game + '.json') {
      if (identity.passed) identity.readback++;
      return json(response, 200, {
        homework_common_id: identity.homework,
        game: {
          id: identity.gameId,
          identifier: identity.game,
          status: identity.passed ? 2 : identity.resume && identity.builds ? 3 : 0,
          user_id: identity.user,
          challenge_id: identity.challengeId ?? 701,
          evaluate_count: identity.builds,
        },
        user: { user_id: identity.user, login: identity.login },
        myshixun: { identifier: identity.practice },
        challenge: {
          id: identity.challengeId ?? 701,
          subject: '模拟 Python 关卡',
          task_pass: challengeText(identity),
          path: identity.codePath ?? codePath,
        },
        ...(identity.index === 0 && identity.passed ? { next_game: identity.stages[1].game } : {}),
        ...(identity.index === 1 ? { prev_game: identity.stages[0].game } : {}),
        shixun_environments: [{ tab_type: 1, shixun_environment_id: 5 }],
        sec_key: identity.proof,
        test_sets: [{ is_public: false, output: 'never-project-private-test' }],
      });
    }
    if (path === '/api/tasks/' + identity.game + '/rep_content.json'
        && url.searchParams.get('path') === (identity.codePath ?? codePath)) {
      identity.fileReads++;
      const content = identity.resume?.content ?? '# ' + identity.key + ' starter\n';
      return json(response, 200, { content: { content: Buffer.from(content).toString('base64') } });
    }
    return reject(response);
  }

  if (request.method !== 'POST') return reject(response);
  const input = await readJson(request);
  const extra = input.extras;
  identity = games(identity).find(item => extra?.homework_common_id === item.homework
    && extra.challenge_id === (item.challengeId ?? 701));
  if (!identity || extra.currentUserId !== identity.user || (identity.index === 1 && !identity.stages[0].passed)) return reject(response);
  if (path === '/api/myshixuns/' + identity.practice + '/update_file.json'
      && input.path === (identity.codePath ?? codePath) && input.game_id === identity.gameId
      && input.content === (identity.resume && identity.builds === 0 ? 'print("incorrect")\n' : identity.solution)
      && !identity.passed) {
    identity.saves++;
    if (identity.resume) identity.resume.content = input.content;
    return json(response, 200, { content: { commitID: identity.commit }, sec_key: identity.proof });
  }
  if (path === '/api/tasks/' + identity.game + '/game_build.json'
      && input.sec_key === identity.proof && extra.commitID === identity.commit
      && input.tab_type === 1 && input.shixun_environment_id === 5 && identity.saves === identity.builds + 1 && !identity.passed) {
    identity.builds++;
    identity.passed = !identity.resume || identity.builds === 2;
    return json(response, 200, { status: 0 });
  }
  return reject(response);
}

function toolCall(name, args, identity) {
  return { index: 0, id: 'call_' + identity.user + '_' + name, type: 'function', function: {
    name, arguments: JSON.stringify(args),
  } };
}

function stream(response, input, output, call) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const base = {
    id: 'educoder-fixture-' + modelRequests, object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000), model: input.model,
  };
  const send = chunk => response.write('data: ' + JSON.stringify({ ...base, ...chunk }) + '\n\n');
  const delta = call ? { role: 'assistant', tool_calls: [call] } : { role: 'assistant', content: output };
  send({ choices: [{ index: 0, delta, finish_reason: null }] });
  const small = input.tools?.some(tool => tool.function?.name === 'educoder_record_experience') ||
    JSON.stringify(input.messages).includes('SESSION_REUSE_FIXTURE');
  send({
    choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }],
    usage: small ? { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 }
      : { prompt_tokens: 11000, completion_tokens: 200, total_tokens: 11200,
        prompt_tokens_details: { cached_tokens: 10000 } },
  });
  response.end('data: [DONE]\n\n');
}

function resumeModel(response, input, identity) {
  const state = identity.resume;
  const { messages, prompt_cache_key: affinity } = input;
  const user = messages.findIndex(message => message.role === 'user');
  if (user < 0 || typeof affinity !== 'string' || !/^[a-z0-9-]{36}$/i.test(affinity)) return reject(response);
  const prefix = JSON.stringify(messages.slice(0, user + 1));
  const calls = messages.flatMap(message => message.tool_calls ?? []);
  const latest = messages.at(-1);
  if (!state.prefix) {
    state.prefix = prefix;
    state.affinity = affinity;
  }
  if (state.prefix !== prefix || state.affinity !== affinity) return reject(response);
  const actions = [
    ['educoder_read_file', { path: codePath }],
    ['educoder_save_file', { path: codePath, content: 'print("incorrect")\n' }],
    ['educoder_evaluate', {}],
    null,
    ['educoder_evaluate', {}],
    ['educoder_read_file', { path: codePath }],
    ['educoder_save_file', { path: codePath, content: identity.solution }],
    ['educoder_evaluate', {}],
    null,
  ];
  const index = state.accepted.length;
  const text = JSON.stringify(latest?.content ?? null);
  const sent = [0, 1, 2, 3, 3, 4, 5, 6, 7];
  const checks = [true, text.includes('starter'), text.includes('saved'), text.includes('failed'),
    latest?.role === 'user' && text.includes('继续当前关卡') && messages.some(message =>
      message.role === 'tool' && JSON.stringify(message.content).includes('failed')),
    text.includes('not_ready') && identity.builds === 1, text.includes('incorrect'),
    text.includes('saved'), text.includes('passed') && identity.builds === 2];
  if (index >= actions.length || calls.length !== sent[index] || !checks[index]) return reject(response);
  state.accepted.push(index);
  const action = actions[index];
  if (!action) return stream(response, input, index === 3 ? '平台判定未通过。' : '模拟平台已返回评测结果。');
  const call = toolCall(...action, identity);
  call.id += '_' + index;
  return stream(response, input, '', call);
}

async function model(request, response) {
  const input = await readJson(request);
  modelRequests++;
  const transcript = JSON.stringify(input.messages);
  const game = [...transcript.matchAll(/SMOKE_TARGET=(game-fixture-[0-9]+)/g)].at(-1)?.[1];
  const available = [...identities.values()].flatMap(games);
  const identity = available.find(item => item.game === game);
  if (!identity) return stream(response, input, '工具包隔离验收通过。');
  const names = input.tools?.map(tool => tool.function?.name).sort() ?? [];
  if (identity.stages) return stagedModel(response, input, identity, names);
  const expectedNames = identity.workspace
    ? 'educoder_evaluate,educoder_read_file,educoder_record_experience,educoder_save_file'
    : 'educoder_evaluate,educoder_read_file,educoder_save_file';
  if (names.join(',') !== expectedNames
      || [identity.login, identity.auto, identity.session, identity.proof, 'never-project-private-test']
        .some(value => transcript.includes(value))) return reject(response);
  const foreign = available.some(item => item !== identity && transcript.includes(item.key));
  if (foreign) return reject(response);
  if (identity.resume) {
    identity.modelCalls++;
    return resumeModel(response, input, identity);
  }
  let color;
  if (identity.vision) {
    const urls = input.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .filter(block => block.type === 'image_url').map(block => block.image_url?.url);
    const bytes = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(urls[0] ?? '')?.[1];
    const matched = bytes && visionImages.find(image => image.bytes.equals(Buffer.from(bytes, 'base64')));
    if (urls.length !== 1 || !matched || matched !== identity.vision) return reject(response);
    color = matched.color;
    identity.imageRequests++;
  }
  identity.modelCalls++;
  const previousToolCalls = input.messages.flatMap(message => message.tool_calls ?? []).map(call => call.function?.name);
  if (identity.workspace && !previousToolCalls.length) {
    if (!transcript.includes('工作区内的既往经验仅供参考') ||
        (identity.workspace === 'bob' && !transcript.includes(experienceNote(identity.group)))) return reject(response);
    if (identity.workspace === 'alice') {
      return stream(response, input, '', toolCall('educoder_record_experience', { note: '通过前尝试写入，不应保存。' }, identity));
    }
  }
  if (identity.workspace === 'alice' && previousToolCalls.length === 1 && previousToolCalls[0] === 'educoder_record_experience' &&
      !input.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('false'))) return reject(response);
  if (!previousToolCalls.includes('educoder_read_file')) {
    if (!groupActivity.has(identity.group)) groupActivity.set(identity.group, { active: 0, peak: 0 });
    const activity = groupActivity.get(identity.group);
    activity.active++;
    activity.peak = Math.max(activity.peak, activity.active);
    try {
      await wait(350);
      return stream(response, input, '', toolCall('educoder_read_file', { path: codePath }, identity));
    } finally {
      activity.active--;
    }
  }
  if (!previousToolCalls.includes('educoder_save_file')) {
    if (!transcript.includes(identity.key + ' starter')) return reject(response);
    return stream(response, input, '', toolCall('educoder_save_file', {
      path: codePath, content: color ? codeForColor(color) : identity.solution,
    }, identity));
  }
  if (!previousToolCalls.includes('educoder_evaluate')) {
    if (!transcript.includes('saved')) return reject(response);
    return stream(response, input, '', toolCall('educoder_evaluate', {}, identity));
  }
  if (!identity.passed) return reject(response);
  if (identity.workspace) {
    const recorded = previousToolCalls.filter(name => name === 'educoder_record_experience').length;
    if (recorded < (identity.workspace === 'alice' ? 2 : 1)) {
      const call = toolCall('educoder_record_experience', { note: experienceNote(identity.group) }, identity);
      call.id += '_passed';
      return stream(response, input, '', call);
    }
    const toolResult = input.messages.find(message => message.role === 'tool' && message.tool_call_id?.endsWith('_passed'));
    if (!toolResult || !JSON.stringify(toolResult.content).includes(identity.workspace === 'alice' ? 'true' : 'false')) return reject(response);
    identity.experienceVerified = true;
  }
  return stream(response, input, '模拟平台已返回评测结果。');
}

function stagedModel(response, input, identity, names) {
  const { messages, prompt_cache_key: affinity } = input;
  const stage = identity.index;
  const step = identity.modelCalls;
  const other = identity.stages[1 - stage];
  const latest = JSON.stringify(messages.at(-1));
  const currentPrompt = [...messages].reverse().find(message => message.role === 'user' &&
    JSON.stringify(message.content).includes('SMOKE_TARGET=' + identity.game));
  const png = 'data:image/png;base64,' + identity.vision.bytes.toString('base64');
  const historicalPng = 'data:image/png;base64,' + other.vision.bytes.toString('base64');
  const historyRetained = stage === 0 || messages.some(message => message.role === 'user' &&
    Array.isArray(message.content) && message.content.some(part => part.image_url?.url === historicalPng));
  const expectedAffinity = identity.affinity ?? (stage === 1 ? other.affinity : affinity);
  if (typeof affinity !== 'string' || affinity !== expectedAffinity || !names.includes('read') || !names.includes('bash') ||
      !['educoder_read_file', 'educoder_save_file', 'educoder_evaluate'].every(name => names.includes(name)) ||
      !Array.isArray(currentPrompt?.content) || !currentPrompt.content.some(part => part.image_url?.url === png) ||
      !historyRetained || JSON.stringify(messages).includes(identity.session) || JSON.stringify(messages).includes(identity.proof)) {
    console.error('多关卡模型请求验证失败。', JSON.stringify({ stage, step, hasAffinity: typeof affinity === 'string',
      affinityMatches: affinity === expectedAffinity, nativeRead: names.includes('read'), nativeBash: names.includes('bash'),
      currentImage: currentPrompt?.content?.some?.(part => part.image_url?.url === png) === true,
      historyRetained }));
    return reject(response);
  }
  identity.affinity = affinity;
  identity.modelCalls++;
  identity.imageRequests++;
  const prefix = stage === 0 ? [
    [true, 'read', { file_path: 'native-fixture.txt' }],
    [latest.includes('NATIVE_EDUCODER_FILE_4GV8'), 'educoder_read_file', { path: identity.codePath }],
  ] : [
    [other.passed, 'educoder_read_file', { path: other.codePath }],
    [latest.includes('EduCoder 工具未完成'), 'educoder_read_file', { path: identity.codePath }],
  ];
  const actions = [
    ...prefix,
    [latest.includes(identity.key + ' starter'), 'educoder_save_file', { path: identity.codePath, content: identity.solution }],
    [latest.includes('saved'), 'educoder_evaluate', {}],
    [identity.passed && latest.includes('passed')],
  ];
  const [ok, name, args] = actions[step] ?? [];
  if (!ok) {
    console.error('多关卡工具结果验证失败。', JSON.stringify({ stage, step }));
    return reject(response);
  }
  if (stage === 0 && step === 1) identity.nativeReadVerified = true;
  if (stage === 1 && step === 1) {
    identity.oldPathRejected = true;
    identity.historyRetained = true;
  }
  if (!name) return stream(response, input, '模拟平台已返回评测结果。');
  const call = toolCall(name, args, identity);
  call.id += '_' + stage + '_' + step;
  return stream(response, input, '', call);
}

const quickjsModule = process.env.EDUCODER_BENCHMARK_QUICKJS;
const benchmark = quickjsModule ? await (await import('./educoder-benchmark.mjs'))
  .createBenchmark(json, readJson, await import(quickjsModule)) : null;

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) return await edu(request, response, url);
    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') return await model(request, response);
    if (request.method === 'GET' && url.pathname === '/metrics') {
      return json(response, 200, {
        scope: 'host', timestamp: Date.now(),
        cpu: { percent: 3.2, cores: 2 },
        memory: { percent: 25, used: 2 ** 30, total: 4 * 2 ** 30 },
        disk: { percent: 20, used: 10 * 2 ** 30, total: 50 * 2 ** 30 },
      });
    }
    if (request.method === 'GET' && url.pathname === '/calls') {
      return json(response, 200, { completions: modelRequests });
    }
    if (request.method === 'GET' && url.pathname === '/fixture/benchmark') {
      if (!benchmark) return json(response, 503, { error: 'benchmark_disabled' });
      const evidence = benchmark.evidence(url.searchParams.get('group'));
      return evidence ? json(response, 200, evidence) : json(response, 400, {});
    }
    if (request.method === 'POST' && url.pathname === '/fixture/expire') {
      const identity = identities.get((await readJson(request)).login);
      if (!identity) return json(response, 404, {});
      identity.expired = true;
      return json(response, 200, { expired: true });
    }
    if (request.method === 'GET' && url.pathname === '/fixture/evidence') {
      const group = url.searchParams.get('group');
      if (!/^(?:smoke|ui|course-ui|vision|workspace|resume|stages)-[a-f0-9]{10}$/.test(group ?? '')) return json(response, 400, {});
      const accounts = [...identities.values()].filter(item => item.group === group).flatMap(games)
        .map(({ course, homework, saves, builds, readback, fileReads, modelCalls, passed, vision, imageDownloads, imageRequests, experienceVerified, resume, stages, index, affinity, nativeReadVerified, oldPathRejected, historyRetained }) => ({
          course, homework: String(homework), saves, builds, readback, fileReads, modelCalls, passed,
          ...(vision ? { imageDownloads, imageRequests } : {}),
          ...(experienceVerified ? { experienceVerified } : {}),
          ...(resume ? { affinity: resume.affinity, resumeSteps: resume.accepted.length } : {}),
          ...(stages ? { index, affinity, nativeReadVerified, oldPathRejected, historyRetained } : {}),
        }));
      return json(response, 200, { accounts, rejectedScope, maxConcurrentAgents: groupActivity.get(group)?.peak ?? 0 });
    }
    return json(response, 404, {});
  } catch {
    if (response.headersSent) response.destroy();
    else json(response, 500, { error: 'fixture_protocol_error' });
  }
});
server.listen(port, '127.0.0.1', () => console.log('EduCoder 和 Pi 模拟服务已启动。'));
process.on('SIGTERM', () => server.close());
