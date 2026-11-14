import assert from 'node:assert/strict'
import test from 'node:test'
import { createTransport } from '../plugins/educoder/transport.js'

const binding = {
  courseId: 'course-one',
  homeworkId: '31',
  taskId: 'game-one',
  practiceId: 'practice-one',
  remoteUserId: '7',
  gameId: '45',
  challengeId: '51',
}
const session = { zzud: 'sample-user', autologin: 'sample-autologin', session: 'sample-session', remoteUserId: '7' }
const target = { binding }
const answer = ['B', ['C', 'A'], false, ['输入', '输出']]
const imagePath = '/api/attachments/FixtureImage'
const figure = '![参考](' + imagePath + '?type=image/png)'

function fixture() {
  const options = [
    { option_name: '先决条件', standard_answer: 'private-answer' },
    { option_name: '输出结果' },
    { option_name: '执行过程' },
  ]
  const raw = {
    course_identifier: binding.courseId,
    homework_common_id: Number(binding.homeworkId),
    game: { id: 45, identifier: binding.taskId, status: 0, evaluate_count: 0, challenge_id: 51 },
    challenge: { id: 51, description: '根据图例解题 ' + figure },
    myshixun: { identifier: binding.practiceId },
    user: { user_id: 7 },
    sec_key: 'sample-key',
    next_game: 'game-two',
    shixun_choice_public_result: true,
    chooses: [
      { question_name: '单选题/多选题', category: 1, subject: '单选题面', challenge_question: options },
      { question_name: '单选题/多选题', category: 2, subject: '多选题面 ' + figure, challenge_question: options },
      { question_name: '判断题', subject: '判断题面' },
      { question_name: '填空题', subject: '填空题面', multi_count: 2 },
    ],
    choose_test_cases: { challenge_chooses_count: 4, choose_correct_num: 0, had_submmit: false },
  }
  const state = {
    response: { challenge_chooses_count: 4, choose_correct_num: 3, test_sets: [
      { result: true }, { result: true }, { result: false, standard_answer: 'private-answer' }, { result: true },
    ] },
  }
  const posts = []
  const transport = createTransport({
    baseUrl: 'http://127.0.0.1:44444/api',
    fetch: async (url, options) => {
      if (url.pathname === imagePath) {
        assert.equal(options.headers.Cookie, undefined)
        return new Response(Buffer.from('image fixture'), { headers: { 'content-type': 'image/png' } })
      }
      assert.equal(url.searchParams.get('zzud'), session.zzud)
      assert.equal(options.headers['Pc-Authorization'], session.session)
      if (options.method === 'GET') {
        assert.equal(url.pathname, '/api/tasks/game-one.json')
        assert.equal(url.searchParams.get('homework_common_id'), binding.homeworkId)
        return Response.json(raw)
      }
      assert.equal(options.method, 'POST')
      assert.equal(url.pathname, '/api/tasks/game-one/choose_build.json')
      posts.push(JSON.parse(options.body))
      if (state.response.challenge_chooses_count === 4) {
        raw.game.status = 2
        raw.game.evaluate_count++
        raw.choose_test_cases = { ...state.response, had_submmit: true }
      }
      return Response.json(state.response)
    },
  })
  return { transport, raw, state, posts }
}

test('选择、判断、填空题按公开题面和选项编号投影，跨题面去重并读取图片', async () => {
  const { transport, posts } = fixture()
  const task = await transport.inspect(session, target)
  assert.equal(task.kind, 'choice')
  assert.equal(task.state, 'pending')
  assert.equal(task.imageCount, 1)
  assert.deepEqual(task.questions.map(question => question.type), ['single', 'multiple', 'judge', 'fill'])
  assert.deepEqual(task.questions[0].options.map(option => option.id), ['A', 'B', 'C'])
  assert.equal(task.questions[1].prompt, '多选题面 [参考图 1]')
  assert.equal(task.questions[3].blankCount, 2)
  assert.deepEqual(task.paths, [])
  assert.doesNotMatch(JSON.stringify(task), /private-answer|sample-key|FixtureImage/)
  const images = await transport.readStatementImages(task)
  assert.equal(images[0].data.toString(), 'image fixture')
  assert.deepEqual(posts, [])
})

test('在固定关卡提交规范化答案，并用实际得分判断是否继续', async () => {
  const { transport, state, posts } = fixture()
  const failed = await transport.submitChoices(session, target, answer)
  assert.deepEqual(failed, { state: 'failed', correct: 3, total: 4, publicResults: true, results: [true, true, false, true] })
  assert.deepEqual(posts[0], {
    answer: ['B', 'AC', 'false', ['输入', '输出']],
    challenge_id: 51,
    subject_id: '',
    homework_common_id: 31,
  })
  const previous = await transport.inspect(session, target)
  assert.equal(previous.state, 'failed')
  assert.equal(previous.nextTaskId, undefined)
  assert.equal(previous.marker, '1')
  assert.deepEqual(previous.feedback.choice, { correct: 3, total: 4, publicResults: true, results: [true, true, false, true] })
  assert.doesNotMatch(JSON.stringify(previous), /private-answer/)
  state.response = { challenge_chooses_count: 4, choose_correct_num: 4 }
  const passed = await transport.submitChoices(session, target, ['B', 'AC', 'true', ['输入', '输出']])
  assert.deepEqual(passed, { state: 'passed', correct: 4, total: 4, publicResults: true })
  const current = await transport.inspect(session, target)
  assert.equal(current.state, 'passed')
  assert.equal(current.nextTaskId, 'game-two')
  await assert.rejects(transport.submitChoices(session, target, answer), { code: 'uncertain' })
  assert.equal(posts.length, 2)
})

test('跨范围、无效答案、平台截止和不明确的已提交状态均不会发起提交', async () => {
  const { transport, raw, posts } = fixture()
  const swapped = { binding: { ...binding, challengeId: '59' } }
  await assert.rejects(transport.submitChoices(session, swapped, answer), { code: 'invalid_scope' })
  for (const invalid of [
    ['A'], ['AB', ['C', 'A'], false, ['甲', '乙']], ['D', ['C', 'A'], false, ['甲', '乙']],
    ['A', 'AA', false, ['甲', '乙']], ['A', ['AB'], false, ['甲', '乙']],
    ['A', 'AB', '真', ['甲', '乙']], ['A', 'AB', false, ['甲', ' ']],
  ]) await assert.rejects(transport.submitChoices(session, target, invalid), { code: 'invalid_input' })
  await assert.rejects(
    transport.submitChoices(session, target, ['AB', ['C', 'A'], false, ['甲', '乙']]),
    error => error?.code === 'invalid_input'
      && /第 1 题\(single\)/.test(error?.detail || '')
      && /仅允许 1 个选项/.test(error?.detail || ''),
  )
  const { questions } = await transport.inspect(session, target)
  raw.chooses[0].challenge_question.reverse()
  await assert.rejects(transport.submitChoices(session, target, answer, { questions }), { code: 'choice_changed' })
  raw.work_end_forbid_evaluate = true
  await assert.rejects(transport.submitChoices(session, target, answer), { code: 'choice_closed' })
  raw.work_end_forbid_evaluate = false
  raw.game.status = 2
  raw.choose_test_cases = { challenge_chooses_count: 4, had_submmit: true }
  const unknown = await transport.inspect(session, target)
  assert.equal(unknown.state, 'pending')
  assert.equal(unknown.evaluating, true)
  assert.equal(unknown.nextTaskId, undefined)
  await assert.rejects(transport.submitChoices(session, target, answer), { code: 'uncertain' })
  assert.deepEqual(posts, [])
})

test('隐藏结果只投影计数，异常评测响应保持待核对', async () => {
  const { transport, raw, state, posts } = fixture()
  raw.shixun_choice_public_result = false
  const graded = await transport.submitChoices(session, target, answer)
  assert.deepEqual(graded, { state: 'failed', correct: 3, total: 4, publicResults: false })
  const previous = await transport.inspect(session, target)
  assert.deepEqual(previous.feedback.choice, { correct: 3, total: 4, publicResults: false })
  state.response = { challenge_chooses_count: 0, choose_correct_num: 0 }
  await assert.rejects(transport.submitChoices(session, target, answer), { code: 'uncertain' })
  state.response = {
    challenge_chooses_count: 4,
    choose_correct_num: 4,
    test_sets: [{ result: true }, { result: true }, { result: true }, { result: false }],
  }
  await assert.rejects(transport.submitChoices(session, target, answer), { code: 'uncertain' })
  assert.equal((await transport.inspect(session, target)).state, 'pending')
  assert.equal(posts.length, 3)
})

test('未公开选择题结果且平台省略 choose_correct_num 时，inspect 不阻塞评测且 submitChoices 接受正常回执', async () => {
  const { transport, raw, state, posts } = fixture()
  raw.shixun_choice_public_result = false
  raw.game.status = 0
  raw.game.evaluate_count = 8
  raw.choose_test_cases = {
    had_submmit: true,
    had_all_submmit: true,
    challenge_chooses_count: 4,
    choose_correct_num: null,
    test_sets: Array.from({ length: 4 }, (_, index) => ({ position: index + 1, result: null })),
  }

  const inspected = await transport.inspect(session, target)
  assert.equal(inspected.kind, 'choice')
  assert.equal(inspected.state, 'pending')
  assert.equal(inspected.evaluating, false)
  assert.equal(inspected.choiceResultHidden, true)
  assert.equal(inspected.marker, '8')

  state.response = {
    had_submmit: true,
    challenge_chooses_count: 4,
    choose_correct_num: null,
    test_sets: Array.from({ length: 4 }, () => ({ result: null })),
  }
  const submitted = await transport.submitChoices(session, target, answer)
  assert.deepEqual(submitted, {
    state: 'pending',
    correct: null,
    total: 4,
    publicResults: false,
    hiddenResult: true,
  })
  assert.equal(posts.length, 1)

  // 即使隐藏结果模式下，平台仅出现 status=1 仍视为正在评测，空响应或冲突测试点仍拒绝为 uncertain
  raw.game.status = 1
  assert.equal((await transport.inspect(session, target)).evaluating, true)
  raw.game.status = 0
  state.response = {}
  await assert.rejects(transport.submitChoices(session, target, answer), { code: 'uncertain' })
  state.response = { challenge_chooses_count: 4, test_sets: [{ result: true }, { result: null }, { result: null }, { result: null }] }
  await assert.rejects(transport.submitChoices(session, target, answer), { code: 'uncertain' })
})
