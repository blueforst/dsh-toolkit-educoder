// EduCoder 和 Pi 的独立 HTTP 替身。只监听共享测试容器的回环接口。
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as wait } from 'node:timers/promises';

const port = Number(process.env.EDUCODER_FIXTURE_PORT || 9299);
const identities = new Map();
const groupActivity = new Map();
let rejectedScope = 0;
let modelRequests = 0;
const codePath = 'src/main.py';

function identityFor(login) {
  if (typeof login !== 'string' || !/^educoder-(?:smoke|ui)-[a-f0-9]{10}-(?:alice|bob)$/.test(login)) return null;
  if (!identities.has(login)) {
    const user = Number.parseInt(createHash('sha256').update(login).digest('hex').slice(0, 11), 16) + 1;
    const key = 'fixture-' + user;
    identities.set(login, {
      login,
      group: login.slice('educoder-'.length, login.lastIndexOf('-')),
      user,
      key,
      game: 'game-' + key,
      practice: 'practice-' + key,
      course: 'course-' + key,
      homework: user + 1,
      auto: 'private-auto-' + key,
      session: 'private-session-' + key,
      proof: 'private-proof-' + key,
      commit: 'commit-' + key,
      solution: 'print(' + JSON.stringify(key) + ')\n',
      saves: 0,
      builds: 0,
      readback: 0,
      fileReads: 0,
      modelCalls: 0,
      passed: false,
      expired: false,
    });
  }
  return identities.get(login);
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
  if (request.method === 'POST' && path === '/api/accounts/login.json') {
    const input = await readJson(request);
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
  const identity = identities.get(url.searchParams.get('zzud'));
  if (!ownsRequest(request, url, identity)) return reject(response);
  if (identity.expired) return json(response, 401, {});

  if (request.method === 'GET') {
    if (path === '/api/courses.json') {
      return json(response, 200, { login: identity.login, user_id: identity.user, courses: [{
        identifier: identity.course, name: '模拟课程 ' + identity.key,
      }] });
    }
    if (path === '/api/courses/' + identity.course + '/homework_commons.json') {
      return json(response, 200, { homeworks: [{
        homework_id: identity.homework,
        name: '模拟作业 ' + identity.key,
        myshixun_identifier: identity.practice,
        challenge_count: 1,
        finished_challenge_count: Number(identity.passed),
      }] });
    }
    if (path === '/api/myshixuns/' + identity.practice + '.json') {
      return json(response, 200, { game_identifier: identity.game });
    }
    if (url.searchParams.get('homework_common_id') !== String(identity.homework)) return reject(response);
    if (path === '/api/tasks/' + identity.game + '.json') {
      if (identity.passed) identity.readback++;
      return json(response, 200, {
        homework_common_id: identity.homework,
        game: {
          id: identity.user + 2,
          identifier: identity.game,
          status: identity.passed ? 2 : 0,
          user_id: identity.user,
          challenge_id: 701,
          evaluate_count: identity.builds,
        },
        user: { user_id: identity.user, login: identity.login },
        myshixun: { identifier: identity.practice },
        challenge: {
          id: 701,
          subject: '模拟 Python 关卡',
          task_pass: 'SMOKE_TARGET=' + identity.game + '\n请读取代码、写入本账号的答案并评测。'
            + '\n认证字段脱敏校验 ' + identity.auto + ' ' + identity.session + ' ' + identity.proof,
          path: codePath,
        },
        shixun_environments: [{ tab_type: 1, shixun_environment_id: 5 }],
        sec_key: identity.proof,
        test_sets: [{ is_public: false, output: 'never-project-private-test' }],
      });
    }
    if (path === '/api/tasks/' + identity.game + '/rep_content.json'
        && url.searchParams.get('path') === codePath) {
      identity.fileReads++;
      const content = '# ' + identity.key + ' starter\n';
      return json(response, 200, { content: { content: Buffer.from(content).toString('base64') } });
    }
    return reject(response);
  }

  if (request.method !== 'POST') return reject(response);
  const input = await readJson(request);
  const extra = input.extras;
  if (extra?.currentUserId !== identity.user || extra.homework_common_id !== identity.homework
      || extra.challenge_id !== 701) return reject(response);
  if (path === '/api/myshixuns/' + identity.practice + '/update_file.json'
      && input.path === codePath && input.game_id === identity.user + 2
      && input.content === identity.solution && !identity.passed) {
    identity.saves++;
    return json(response, 200, { content: { commitID: identity.commit }, sec_key: identity.proof });
  }
  if (path === '/api/tasks/' + identity.game + '/game_build.json'
      && input.sec_key === identity.proof && extra.commitID === identity.commit
      && input.tab_type === 1 && input.shixun_environment_id === 5 && identity.saves === 1 && !identity.passed) {
    identity.builds++;
    identity.passed = true;
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
  send({
    choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 11000, completion_tokens: 200, total_tokens: 11200,
      prompt_tokens_details: { cached_tokens: 10000 } },
  });
  response.end('data: [DONE]\n\n');
}

async function model(request, response) {
  const input = await readJson(request);
  modelRequests++;
  const transcript = JSON.stringify(input.messages);
  const game = transcript.match(/SMOKE_TARGET=(game-fixture-[0-9]+)/)?.[1];
  const identity = [...identities.values()].find(item => item.game === game);
  if (!identity) return stream(response, input, '工具包隔离验收通过。');
  const names = input.tools?.map(tool => tool.function?.name).sort() ?? [];
  if (names.join(',') !== 'educoder_evaluate,educoder_read_file,educoder_save_file'
      || [identity.login, identity.auto, identity.session, identity.proof, 'never-project-private-test']
        .some(value => transcript.includes(value))) return reject(response);
  const foreign = [...identities.values()].some(item => item !== identity && transcript.includes(item.key));
  if (foreign) return reject(response);
  identity.modelCalls++;
  const previousToolCalls = input.messages.flatMap(message => message.tool_calls ?? []).map(call => call.function?.name);
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
      path: codePath, content: identity.solution,
    }, identity));
  }
  if (!previousToolCalls.includes('educoder_evaluate')) {
    if (!transcript.includes('saved')) return reject(response);
    return stream(response, input, '', toolCall('educoder_evaluate', {}, identity));
  }
  if (!identity.passed) return reject(response);
  return stream(response, input, '模拟平台已返回评测结果。');
}

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
    if (request.method === 'POST' && url.pathname === '/fixture/expire') {
      const identity = identities.get((await readJson(request)).login);
      if (!identity) return json(response, 404, {});
      identity.expired = true;
      return json(response, 200, { expired: true });
    }
    if (request.method === 'GET' && url.pathname === '/fixture/evidence') {
      const group = url.searchParams.get('group');
      if (!/^(?:smoke|ui)-[a-f0-9]{10}$/.test(group ?? '')) return json(response, 400, {});
      const accounts = [...identities.values()].filter(item => item.group === group)
        .map(({ course, homework, saves, builds, readback, fileReads, modelCalls, passed }) => ({
          course, homework: String(homework), saves, builds, readback, fileReads, modelCalls, passed,
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
