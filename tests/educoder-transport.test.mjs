import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createTransport, TransportError } from '../plugins/educoder/transport.js'

const baseUrl = 'http://127.0.0.1:44444/api'
const fakeSecrets = {
  A: { user: 101, login: 'alice-test', password: 'fake-pass-A', course: 'course-alpha', homework: 31 },
  B: { user: 202, login: 'bob-test', password: 'fake-pass-B', course: 'course-beta', homework: 47 },
}

function fixture({ terminalRunner } = {}) {
  const calls = []
  let onSave
  const modes = new Set()
  const status = new Map()
  const stored = new Map()
  const transport = createTransport({
    baseUrl,
    signingAccessKey: 'fixture-public',
    signingSecretKey: 'fixture-signing',
    terminalRunner,
    fetch: async (url, options) => {
      const headers = new Headers(options.headers)
      const signatureInput = Buffer.from('method=' + options.method + '&ak=fixture-public&sk=fixture-signing&time=' +
        headers.get('x-edu-timestamp')).toString('base64')
      assert.equal(headers.get('x-edu-signature'), createHash('md5').update(signatureInput).digest('hex'))
      assert.equal(options.redirect, 'manual')
      assert.equal(headers.get('x-edu-type'), 'pc')
      const path = url.pathname
      const body = options.body && JSON.parse(options.body)
      calls.push({ path, method: options.method, body, query: Object.fromEntries(url.searchParams), headers })
      if (path === '/api/accounts/login.json') {
        assert.equal(headers.get('pc-authorization'), 'null')
        assert.equal(headers.get('cookie'), null)
        const identity = Object.keys(fakeSecrets).find(key => fakeSecrets[key].login === body.login)
        if (modes.has('signature')) return Response.json({ status: -102, message: 'sensitive fixture data' })
        if (modes.has('bind')) return Response.json({ status: -4, message: 'sensitive fixture data' })
        if (!identity || body.password !== fakeSecrets[identity].password) {
          return Response.json({ status: -3, message: 'sensitive fixture data' })
        }
        return Response.json({
          user_id: fakeSecrets[identity].user,
          login: fakeSecrets[identity].login,
        }, {
          headers: [
            ['set-cookie', 'autologin_trustie=auto-' + identity + '; HttpOnly; Secure'],
            ['set-cookie', '_educoder_session=session-' + identity + '; HttpOnly; Secure'],
          ],
        })
      }

      const owner = headers.get('pc-authorization')?.split('-')[1]
      if (!fakeSecrets[owner] || modes.has('expired')) return Response.json({}, { status: 401 })
      const identity = fakeSecrets[owner]
      assert.equal(headers.get('cookie'), 'autologin_trustie=auto-' + owner + '; _educoder_session=session-' + owner)
      assert.equal(url.searchParams.get('zzud'), identity.login)
      if (path === '/api/courses.json') {
        if (modes.has('expired JSON')) return Response.json({ status: 401 })
        if (modes.has('guest')) return Response.json({ status: 0, login: 'guest' })
        if (modes.has('identity missing')) return Response.json({ courses: [] })
        return Response.json({
          user_id: identity.user,
          courses: [{ identifier: identity.course, name: identity.course, other: 'not exported' }],
        })
      }
      if (path === '/api/courses/' + identity.course + '/homework_commons.json') {
        return Response.json({
          homeworks: [{
            homework_id: identity.homework,
            name: 'fixture homework ' + owner,
            myshixun_identifier: modes.has('unopened') ? null : 'practice-' + owner,
            challenge_count: 2,
          }],
        })
      }
      if (path === '/api/myshixuns/practice-' + owner + '.json') {
        return Response.json({ game_identifier: 'game-' + owner + (modes.has('last visited') ? '-2' : '-1') })
      }
      if (path === '/api/tasks/game-' + owner + '-1.json' || path === '/api/tasks/game-' + owner + '-2.json') {
        const step = Number(path.split('.json')[0].at(-1))
        const taskState = status.get(owner + step) ?? { value: 0, marker: 0 }
        const accountId = modes.has('wrong task user') ? 999 : identity.user
        const tab = modes.has('terminal') ? 4 : modes.has('gui') ? 3 : 1
        return Response.json({
          homework_common_id: identity.homework,
          game: {
            id: identity.user + step,
            identifier: 'game-' + owner + '-' + step,
            status: taskState.value,
            user_id: accountId,
            evaluate_count: taskState.marker,
          },
          user: { user_id: accountId, login: 'must not be exported' },
          myshixun: { identifier: 'practice-' + owner },
          challenge: {
            id: 700 + step,
            subject: 'Example code task',
            task_pass: '<p>Write a program.</p>',
            path: modes.has('traversal') ? '../etc/passwd' : 'src/main & test.py；lib/helper.py;',
          },
          shixun_environments: [{ tab_type: tab, shixun_environment_id: 5 }],
          sec_key: 'task-proof-secret',
          choose_test_cases: modes.has('choice') ? { test_sets: [{ standard_answer: 'private choice' }] } : undefined,
          prev_game: step === 2 ? 'game-' + owner + '-1' : null,
          test_sets: [
            { is_public: false, output: 'hidden fixture' },
            { is_public: true, result: false, output: 'expected output', actual_output: 'actual output' },
          ],
          next_game: step === 1 ? 'game-' + owner + '-2' : null,
        })
      }
      if (path === '/api/tasks/game-' + owner + '-1/rep_content.json') {
        assert.equal(url.searchParams.get('path'), 'src/main & test.py')
        assert.equal(url.searchParams.get('homework_common_id'), String(identity.homework))
        return Response.json({ content: { content: Buffer.from(owner + ' starter code').toString('base64') } })
      }
      if (path === '/api/myshixuns/practice-' + owner + '/start.json') {
        assert.equal(options.method, 'GET')
        assert.equal(url.searchParams.get('tab_type'), '4')
        assert.equal(url.searchParams.get('shixun_environment_id'), '5')
        assert.equal(url.searchParams.get('game_id'), String(identity.user + 1))
        assert.equal(url.searchParams.get('homework_common_id'), String(identity.homework))
        return Response.json({
          status: 0,
          data: {
            link_url: 'ws://untrusted.fixture.example/ws',
            webssh_url: modes.has('untrusted terminal') ? 'wss://untrusted.fixture.example/ws' :
              'wss://webssh.educoder.net/ws?token=fixture-ticket-' + owner,
            ssh_address: 'sandbox.fixture.example',
            port: 22,
            username: 'fixture-user',
            password: 'fake-ssh-' + owner,
            unneeded: 'not forwarded to runner',
          },
        })
      }
      if (path === '/api/myshixuns/practice-' + owner + '/update_file.json') {
        assert.equal(options.method, 'POST')
        assert.equal(body.extras.currentUserId, identity.user)
        assert.equal(body.extras.homework_common_id, identity.homework)
        assert.equal(body.game_id, identity.user + 1)
        assert.equal(body.extras.challenge_id, 701)
        assert.equal(body.evaluate, 0)
        stored.set(owner + '/' + body.path, body.content)
        if (onSave) onSave(options.signal)
        if (modes.has('timeout save')) throw new Error('cannot print fixture request body ' + body.content)
        return Response.json({ content: { commitID: 'commit-' + owner }, sec_key: 'proof-' + owner })
      }
      if (path === '/api/tasks/game-' + owner + '-1/game_build.json') {
        assert.equal(options.method, 'POST')
        assert.equal(body.sec_key, modes.has('terminal') ? 'task-proof-secret' : 'proof-' + owner)
        assert.equal(body.extras.commitID, modes.has('terminal') ? '' : 'commit-' + owner)
        assert.equal(body.tab_type, modes.has('terminal') ? 4 : 1)
        assert.equal(body.shixun_environment_id, 5)
        assert.equal(body.extras.currentUserId, identity.user)
        assert.equal(body.extras.homework_common_id, identity.homework)
        assert.equal(body.extras.challenge_id, 701)
        status.set(owner + '1', { value: 2, marker: 1 })
        if (modes.has('timeout build')) throw new Error('cannot print fixture proof ' + body.sec_key)
        return Response.json({ status: 0 })
      }
      throw new Error('unexpected fixture request: ' + path)
    },
  })
  return { transport, calls, modes, status, stored, onSave(handler) { onSave = handler } }
}

function login(transport, owner) {
  const account = fakeSecrets[owner]
  return transport.login(account.login, account.password).then(result => result.session)
}

function target(owner) {
  const account = fakeSecrets[owner]
  return { courseId: account.course, homeworkId: String(account.homework) }
}

function errorCode(code) {
  return error => error instanceof TransportError && error.code === code &&
    !/fixture|secret|fake-pass/.test(error.message) && error.cause === undefined
}

test('native login, status and discovery maintain isolated signed session contexts', async () => {
  const { transport, modes } = fixture()
  const [a, b] = await Promise.all([login(transport, 'A'), login(transport, 'B')])
  assert.notEqual(a.session, b.session)
  assert.deepEqual(await transport.status(a), { remoteUserId: '101', label: 'al***st', verified: true })
  assert.deepEqual(await transport.courses(a), [{ id: 'course-alpha', title: 'course-alpha' }])
  assert.deepEqual(await transport.courses(b), [{ id: 'course-beta', title: 'course-beta' }])
  assert.deepEqual(await transport.homeworks(b, 'course-beta'), [
    { id: '47', title: 'fixture homework B', taskCount: 2, passedCount: 0 },
  ])
  await assert.rejects(transport.homeworks(a, 'course-beta'), errorCode('invalid_scope'))
  modes.add('identity missing')
  assert.equal((await transport.status(a)).verified, false)
  modes.delete('identity missing')
  assert.equal((await transport.status(a, target('A'))).verified, true)
  modes.add('guest')
  await assert.rejects(transport.status(a), errorCode('auth_required'))
  modes.delete('guest')
  modes.add('expired JSON')
  await assert.rejects(transport.status(b), errorCode('auth_required'))
  modes.delete('expired JSON')
  modes.add('expired')
  await assert.rejects(transport.status(b), errorCode('auth_required'))
})

test('classifies credential, binding and signature errors without reflecting upstream diagnostics', async () => {
  const { transport, modes } = fixture()
  await assert.rejects(transport.login('unknown', 'invalid'), errorCode('invalid_credentials'))
  modes.add('bind')
  await assert.rejects(login(transport, 'A'), errorCode('manual_required'))
  modes.add('signature')
  await assert.rejects(login(transport, 'B'), errorCode('signature_error'))
  const production = createTransport({ signingAccessKey: '', signingSecretKey: '', fetch: () => assert.fail() })
  await assert.rejects(production.login('fixture', 'fixture'), errorCode('signature_error'))
  assert.throws(() => createTransport({ baseUrl: 'http://10.0.0.1/api' }), TypeError)
})

test('pins the remote account, course, task and paths, and reads the verified next level', async () => {
  const { transport, calls, modes, stored } = fixture()
  const [a, b] = await Promise.all([login(transport, 'A'), login(transport, 'B')])
  const task = await transport.inspect(a, target('A'))
  assert.equal(task.kind, 'code')
  assert.equal(task.state, 'pending')
  assert.equal(task.marker, '0')
  assert.equal(task.instructions, '<p>Write a program.</p>')
  assert.deepEqual(task.paths, ['src/main & test.py', 'lib/helper.py'])
  assert.equal(task.feedback.publicTests.length, 1)
  assert.doesNotMatch(JSON.stringify(task), /must not be exported|task-proof-secret|hidden fixture/)
  assert.equal(await transport.readFile(a, task.binding, task.paths[0]), 'A starter code')
  await assert.rejects(transport.inspect(b, task.binding), errorCode('invalid_scope'))
  await assert.rejects(transport.inspect(a, { binding: task.binding, advanceTo: 'game-A-2' }), errorCode('invalid_scope'))
  await assert.rejects(transport.readFile(a, task.binding, 'different.py'), errorCode('invalid_scope'))
  await assert.rejects(transport.saveFile(a, task.binding, '../secret', 'replacement'), errorCode('invalid_scope'))
  modes.add('wrong task user')
  await assert.rejects(transport.inspect(a, task.binding), errorCode('invalid_scope'))
  modes.delete('wrong task user')
  await transport.saveFile(a, task.binding, task.paths[0], 'answer')
  const proof = await transport.saveFile(a, task.binding, task.paths[1], 'helper')
  const other = await transport.inspect(b, target('B'))
  await assert.rejects(transport.evaluate(b, other.binding, proof), errorCode('invalid_scope'))
  assert.equal(stored.get('A/' + task.paths[0]), 'answer')
  assert.equal(stored.get('A/' + task.paths[1]), 'helper')
  assert.equal(stored.size, 2)
  await transport.evaluate(a, task.binding, proof)
  const passed = await transport.inspect(a, task.binding)
  assert.equal(passed.state, 'passed')
  assert.equal(passed.nextTaskId, 'game-A-2')
  await assert.rejects(transport.inspect(a, { binding: task.binding, advanceTo: 'game-B-2' }), errorCode('invalid_scope'))
  const next = await transport.inspect(a, { binding: task.binding, advanceTo: 'game-A-2' })
  assert.equal(next.binding.taskId, 'game-A-2')
  assert.equal(next.state, 'pending')
  assert.equal(calls.filter(call => call.path.endsWith('/game_build.json')).length, 1)
})

test('read-only discovery pauses unsupported task shapes and never opens a remote practice', async () => {
  const { transport, calls, modes } = fixture()
  const a = await login(transport, 'A')
  modes.add('unopened')
  await assert.rejects(transport.inspect(a, target('A')), errorCode('manual_required'))
  assert.ok(!calls.some(call => call.path.includes('shixun_exec')))
  modes.delete('unopened')
  modes.add('gui')
  assert.equal((await transport.inspect(a, target('A'))).kind, 'manual')
  modes.delete('gui')
  modes.add('terminal')
  const terminal = await transport.inspect(a, target('A'))
  assert.equal(terminal.kind, 'terminal')
  assert.equal(terminal.terminalAvailable, false)
  await assert.rejects(transport.evaluate(a, terminal.binding, {}), errorCode('manual_required'))
  modes.delete('terminal')
  modes.add('choice')
  const choice = await transport.inspect(a, target('A'))
  assert.equal(choice.kind, 'manual')
  assert.doesNotMatch(JSON.stringify(choice), /private choice/)
  modes.delete('choice')
  modes.add('last visited')
  assert.equal((await transport.inspect(a, target('A'))).binding.taskId, 'game-A-1')
  modes.add('traversal')
  assert.deepEqual((await transport.inspect(a, target('A'))).paths, [])
  assert.ok(calls.slice(1).every(call => call.method === 'GET'))
})

test('write timeout surfaces uncertainty and readback confirms the original remote build without retry', async () => {
  const { transport, calls, modes, stored } = fixture()
  const a = await login(transport, 'A')
  const task = await transport.inspect(a, target('A'))
  modes.add('timeout save')
  await assert.rejects(transport.saveFile(a, task.binding, task.paths[0], 'fixture-sensitive-code'), errorCode('uncertain'))
  assert.equal(stored.size, 1)
  assert.equal(calls.filter(call => call.path.endsWith('/update_file.json')).length, 1)

  modes.delete('timeout save')
  const proof = await transport.saveFile(a, task.binding, task.paths[0], 'explicit new submission')
  modes.add('timeout build')
  await assert.rejects(transport.evaluate(a, task.binding, proof), errorCode('uncertain'))
  const passed = await transport.inspect(a, task.binding)
  assert.equal(passed.state, 'passed')
  assert.equal(passed.marker, '1')
  await assert.rejects(transport.evaluate(a, task.binding, proof), errorCode('uncertain'))
  assert.equal(calls.filter(call => call.path.endsWith('/game_build.json')).length, 1)
})


test('explicit terminal runner uses verified WSS endpoint and submits a fixture without exposing credentials', async () => {
  const invoked = []
  const { transport, calls, modes } = fixture({
    terminalRunner: async ({ endpoint, host, port, username, password, command, signal, ...rest }) => {
      assert.equal(endpoint, 'wss://webssh.educoder.net/ws?token=fixture-ticket-A')
      assert.equal(host, 'sandbox.fixture.example')
      assert.equal(port, 22)
      assert.equal(username, 'fixture-user')
      assert.equal(password, 'fake-ssh-A')
      assert.equal(command, 'printf hello')
      assert.equal(signal.aborted, false)
      assert.deepEqual(rest, {})
      invoked.push(command)
      return {
        exitCode: 0,
        output: 'hello \u001b[31m' + password + ' \u001b[0m session-A auto-A fixture-ticket-A',
      }
    },
  })
  const a = await login(transport, 'A')
  modes.add('terminal')
  const task = await transport.inspect(a, target('A'))
  assert.equal(task.kind, 'terminal')
  assert.equal(task.terminalAvailable, true)
  assert.ok(!calls.some(call => call.path.endsWith('/start.json')))
  modes.add('untrusted terminal')
  await assert.rejects(transport.runTerminal(a, task.binding, 'printf hello'), errorCode('manual_required'))
  assert.equal(invoked.length, 0)
  modes.delete('untrusted terminal')
  const result = await transport.runTerminal(a, task.binding, 'printf hello')
  assert.equal(result.exitCode, 0)
  assert.equal(result.output, 'hello [已脱敏]  [已脱敏] [已脱敏] [已脱敏]')
  assert.deepEqual(result.proof, { kind: 'terminal' })
  await assert.rejects(transport.evaluate(a, task.binding, { kind: 'terminal' }), errorCode('invalid_scope'))
  await transport.evaluate(a, task.binding, result.proof)
  const verified = await transport.inspect(a, task.binding)
  assert.equal(verified.state, 'passed')
  assert.equal(invoked.length, 1)
  assert.equal(calls.filter(call => call.path.endsWith('/game_build.json')).length, 1)
})


test('aborting a read or pending write stops transport without claiming a sent write was undone', async () => {
  const { transport, calls, stored, onSave } = fixture()
  const a = await login(transport, 'A')
  const task = await transport.inspect(a, target('A'))
  const aborted = AbortSignal.abort()
  await assert.rejects(transport.inspect(a, task.binding, { signal: aborted }), errorCode('aborted'))
  await assert.rejects(transport.saveFile(a, task.binding, task.paths[0], 'code', aborted), errorCode('aborted'))
  assert.equal(calls.filter(call => call.path.endsWith('/update_file.json')).length, 0)
  const controller = new AbortController()
  onSave(signal => {
    controller.abort()
    signal.throwIfAborted()
  })
  await assert.rejects(
    transport.saveFile(a, task.binding, task.paths[0], 'code', { signal: controller.signal }),
    errorCode('uncertain'),
  )
  assert.equal(calls.filter(call => call.path.endsWith('/update_file.json')).length, 1)
  assert.equal(stored.size, 1)
})
