import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { benchmarkCases } from './educoder-benchmark-cases.mjs';

const benchmarkLogin = /^educoder-(bench-[a-f0-9]{10})-(?:alice|bob)$/;
const benchmarkGroup = /^bench-[a-f0-9]{10}$/;
const mainPath = 'src/main.js';
const hiddenCaseOutput = 'never-project-benchmark-hidden-output';
const judgeMemoryBytes = 32 * 1024 * 1024;
const judgeDeadlineMs = 450;

export async function createBenchmark(send, readJson, { getQuickJS }) {
  const accounts = new Map();
  const rejectedScope = new Map();
  const QuickJS = await getQuickJS();

  function judge(assignment) {
    const exercise = assignment.exercise;
    const evaluations = exercise.cases.map(([args, expected], index) => {
      const actual = execute(QuickJS, assignment, mainPath, exercise.name, args);
      return {
        passed: actual.ok && isDeepStrictEqual(actual.output, expected)
          && (!exercise.auxiliary || args[0].length === 0 || actual.helperUsed),
        public: index < 2,
        expected,
        actual,
      };
    });
    if (exercise.auxiliary) {
      const { path, name, cases } = exercise.auxiliary;
      for (const [args, expected] of cases) {
        const actual = execute(QuickJS, assignment, path, name, args);
        evaluations.push({ passed: actual.ok && isDeepStrictEqual(actual.output, expected), public: false });
      }
    }
    const passedTests = evaluations.filter(result => result.passed).length;
    const totalTests = evaluations.length;
    return { evaluations, passedTests, totalTests, passed: passedTests === totalTests };
  }

  function stateFor(login, group) {
    if (!accounts.has(login)) {
      const user = Number.parseInt(createHash('sha256').update(login).digest('hex').slice(0, 10), 16) + 1;
      const course = 'benchmark-course-' + user;
      accounts.set(login, {
        group, login, user, course, session: 'benchmark-session-' + user, auto: 'benchmark-auto-' + user,
        assignments: benchmarkCases.map((exercise, index) => ({
          exercise,
          homeworkId: user * 100 + 2 * index,
          gameId: user * 100 + 2 * index + 1,
          challengeId: index + 800,
          practice: 'benchmark-practice-' + user + '-' + index,
          game: 'benchmark-game-' + user + '-' + index,
          training: 'benchmark-training-' + user + '-' + index,
          proof: 'benchmark-proof-' + user + '-' + index,
          files: { ...exercise.files },
          started: index !== 0,
          initialized: 0,
          saves: 0,
          fileReads: 0,
          readbacks: 0,
          results: [],
        })),
      });
    }
    return accounts.get(login);
  }

  function reject(response, group) {
    rejectedScope.set(group, (rejectedScope.get(group) ?? 0) + 1);
    return send(response, 403, { status: -1, message: 'benchmark scope denied' });
  }

  function login(request, response, input) {
    const group = benchmarkLogin.exec(input.login)[1];
    if (request.headers['pc-authorization'] !== 'null' || request.headers.cookie) return reject(response, group);
    if (input.password !== 'fake-password-' + input.login) return send(response, 200, { status: -3 });
    const account = stateFor(input.login, group);
    return send(response, 200, { user_id: account.user, login: account.login }, {
      'set-cookie': [
        'autologin_trustie=' + account.auto + '; HttpOnly; Secure',
        '_educoder_session=' + account.session + '; HttpOnly; Secure',
      ],
    });
  }

  async function edu(request, response, url) {
    const path = url.pathname;
    const accountLogin = url.searchParams.get('zzud');
    const group = benchmarkLogin.exec(accountLogin)[1];
    const account = accounts.get(accountLogin);
    const rejectRequest = () => reject(response, group);
    if (!account || request.headers['x-edu-type'] !== 'pc'
        || request.headers['pc-authorization'] !== account.session
        || request.headers.cookie !== 'autologin_trustie=' + account.auto + '; _educoder_session=' + account.session) {
      return rejectRequest();
    }

    if (request.method === 'GET') {
      if (path === '/api/courses.json') {
        return send(response, 200, {
          login: account.login, user_id: account.user,
          courses: [{ identifier: account.course, name: '模拟 JavaScript 作业课程' }],
        });
      }
      if (path === '/api/courses/' + account.course + '/homework_commons.json') {
        return send(response, 200, { homeworks: account.assignments.map(assignment => ({
          homework_id: assignment.homeworkId,
          name: assignment.exercise.title,
          shixun_identifier: assignment.training,
          ...(assignment.started ? { myshixun_identifier: assignment.practice } : {}),
          challenge_count: 1,
          finished_challenge_count: Number(assignment.results.at(-1)?.passed ?? false),
        })) });
      }
      const homeworkId = url.searchParams.get('homework_common_id');
      const byPractice = account.assignments.find(item => path === '/api/myshixuns/' + item.practice + '.json');
      if (byPractice?.started) return send(response, 200, { game_identifier: byPractice.game });

      const byTraining = account.assignments.find(item => path === '/api/shixuns/' + item.training + '/shixun_exec.json');
      if (byTraining && homeworkId === String(byTraining.homeworkId)) {
        byTraining.started = true;
        byTraining.initialized++;
        return send(response, 200, { game_identifier: byTraining.game, myshixun_identifier: byTraining.practice });
      }

      const assignment = account.assignments.find(item => homeworkId === String(item.homeworkId));
      if (!assignment?.started) return rejectRequest();
      const { exercise, results } = assignment;
      const latest = results.at(-1);
      if (path === '/api/tasks/' + assignment.game + '.json') {
        if (latest) assignment.readbacks++;
        return send(response, 200, {
          homework_common_id: assignment.homeworkId,
          game: {
            id: assignment.gameId, identifier: assignment.game, status: latest ? (latest.passed ? 2 : 3) : 0,
            user_id: account.user, challenge_id: assignment.challengeId, evaluate_count: results.length,
          },
          user: { user_id: account.user, login: account.login },
          myshixun: { identifier: assignment.practice },
          challenge: {
            id: assignment.challengeId,
            subject: exercise.title,
            task_pass: exercise.instructions,
            path: Object.keys(assignment.files).join(';'),
          },
          shixun_environments: [{ tab_type: 1, shixun_environment_id: 5 }],
          sec_key: assignment.proof,
          ...(latest ? testFeedback(latest) : {}),
        });
      }

      const file = url.searchParams.get('path');
      if (path === '/api/tasks/' + assignment.game + '/rep_content.json' && Object.hasOwn(assignment.files, file)) {
        assignment.fileReads++;
        return send(response, 200, { content: { content: Buffer.from(assignment.files[file]).toString('base64') } });
      }
      return rejectRequest();
    }

    if (request.method !== 'POST') return rejectRequest();
    const input = await readJson(request);
    const extra = input.extras;
    const assignment = account.assignments.find(item => item.homeworkId === extra?.homework_common_id);
    if (!assignment?.started || extra.currentUserId !== account.user || extra.challenge_id !== assignment.challengeId
        || assignment.results.at(-1)?.passed) return rejectRequest();
    if (path === '/api/myshixuns/' + assignment.practice + '/update_file.json'
        && Object.hasOwn(assignment.files, input.path) && input.game_id === assignment.gameId
        && typeof input.content === 'string' && Buffer.byteLength(input.content) <= 25_000) {
      assignment.files[input.path] = input.content;
      assignment.saves++;
      assignment.commit = 'benchmark-commit-' + assignment.gameId + '-' + assignment.saves;
      return send(response, 200, { content: { commitID: assignment.commit }, sec_key: assignment.proof });
    }
    if (path === '/api/tasks/' + assignment.game + '/game_build.json'
        && input.sec_key === assignment.proof && assignment.commit && extra.commitID === assignment.commit
        && input.tab_type === 1 && input.shixun_environment_id === 5) {
      assignment.commit = undefined;
      assignment.results.push(judge(assignment));
      return send(response, 200, { status: 0 });
    }
    return rejectRequest();
  }

  function evidence(group) {
    if (!benchmarkGroup.test(group)) return undefined;
    const selected = [...accounts.values()].filter(account => account.group === group);
    return {
      rejectedScope: rejectedScope.get(group) ?? 0,
      assignments: selected.flatMap(account => account.assignments.map(assignment => {
        const { exercise, results, saves, fileReads, readbacks, initialized } = assignment;
        return {
          id: exercise.id,
          homeworkId: String(assignment.homeworkId),
          title: exercise.title,
          kind: exercise.auxiliary ? 'multi-file' : 'single-file',
          evaluations: results.map(({ passed, passedTests, totalTests }) => ({ passed, passedTests, totalTests })),
          totalTests: exercise.cases.length + (exercise.auxiliary?.cases.length ?? 0),
          saves, fileReads, readbacks, initialized,
        };
      })),
    };
  }

  return { edu, evidence, login, matches: value => benchmarkLogin.test(value) };
}

function testFeedback(latest) {
  return {
    last_compile_output: latest.evaluations.some(result => !result.actual?.ok && result.public)
      ? '公开示例运行失败。请检查语法、导出和调用。' : '',
    test_sets: latest.evaluations.map(result => result.public ? {
      is_public: true,
      result: result.passed,
      output: JSON.stringify(result.expected),
      actual_output: result.actual.ok ? JSON.stringify(result.actual.output).slice(0, 500) : '运行失败',
    } : { is_public: false, result: result.passed, output: hiddenCaseOutput }),
  };
}

function execute(QuickJS, assignment, path, name, args) {
  const files = Object.fromEntries(Object.entries(assignment.files)
    .map(([filename, code]) => ['./' + filename.split('/').at(-1), code]));
  const helperName = assignment.exercise.auxiliary?.name;
  const inputModule = './' + path.split('/').at(-1);
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(judgeMemoryBytes);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + judgeDeadlineMs;
  runtime.setInterruptHandler(() => Date.now() >= deadline);
  const context = runtime.newContext();
  try {
    const result = context.evalCode(`
      (() => {
        const files = JSON.parse(${JSON.stringify(JSON.stringify(files))});
        const hasOwn = Object.hasOwn;
        const stringify = JSON.stringify;
        const finite = Number.isFinite;
        const call = Reflect.apply;
        const compile = Function;
        let helperUsed = false;

        function requireFile(filename) {
          if (!hasOwn(files, filename)) throw new Error('Unknown file');
          const module = { exports: {} };
          compile('module', 'exports', 'require', files[filename])(module, module.exports, requireFile);
          if (filename !== ${JSON.stringify(inputModule)} && ${JSON.stringify(helperName ?? '')}) {
            const helper = module.exports[${JSON.stringify(helperName ?? '')}];
            module.exports[${JSON.stringify(helperName ?? '')}] = (...args) => {
              helperUsed = true;
              return call(helper, undefined, args);
            };
          }
          return module.exports;
        }

        const args = JSON.parse(${JSON.stringify(JSON.stringify(args))});
        const answer = call(requireFile(${JSON.stringify(inputModule)})[${JSON.stringify(name)}], undefined, args);
        const output = stringify(answer, (_key, value) => {
          if (value === undefined || (typeof value === 'number' && !finite(value))) throw new Error('Invalid value');
          return value;
        });
        if (typeof output !== 'string' || output.length > 100000) throw new Error('Invalid output');
        return (helperUsed ? '1' : '0') + output;
      })()`);
    if (result.error) {
      result.error.dispose();
      return { ok: false };
    }
    const value = context.getString(result.value);
    result.value.dispose();
    return { ok: true, helperUsed: value[0] === '1', output: JSON.parse(value.slice(1)) };
  } catch {
    return { ok: false };
  } finally {
    context.dispose();
    runtime.dispose();
  }
}
