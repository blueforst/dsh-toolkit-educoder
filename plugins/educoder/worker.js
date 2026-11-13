import { setTimeout as delay } from 'node:timers/promises';

function decision(remote) {
  return {
    binding: remote.binding,
    marker: remote.marker || (remote.state === 'passed' ? 'passed' : ''),
    nextTaskId: remote.nextTaskId ?? null,
  };
}

function passed(remote) {
  return remote.nextTaskId
    ? { ...decision(remote), status: 'paused', code: 'next_stage', mutation: null }
    : { ...decision(remote), status: 'passed', mutation: null };
}

function failedAfter(remote, marker) {
  return !remote.evaluating && /^\d+$/u.test(remote.marker) && /^\d+$/u.test(marker) &&
    Number(remote.marker) > Number(marker) && (remote.state === 'failed' || Boolean(remote.failedVerdict));
}

function confirmsFailure(previous, observed, marker, { priorFailedVerdict = null, settleFinal = false } = {}) {
  if (!failedAfter(observed, marker)) return false;
  if (observed.state === 'failed') {
    return !priorFailedVerdict || (previous?.marker === observed.marker && previous.state === 'failed');
  }
  const stableVerdict = previous?.marker === observed.marker &&
    previous.failedVerdict === observed.failedVerdict && failedAfter(previous, marker);
  return stableVerdict && (!priorFailedVerdict || observed.failedVerdict !== priorFailedVerdict || settleFinal);
}

function feedback(remote) {
  return JSON.stringify({ compiler: remote.feedback?.compiler, tests: remote.feedback?.publicTests });
}

function choiceFeedback(score, status) {
  return score.publicResults ? JSON.stringify({ correct: score.correct, total: score.total, results: score.results }) :
    (status === 'passed' ? '平台确认本关通过。' : '平台评测未通过。请检查题意和选项后重试。');
}

function fail(code) {
  throw Object.assign(new Error('EduCoder 操作未完成。'), { code });
}

function redactSession(text, session) {
  for (const value of [session.autologin, session.session, session.zzud]) {
    if (typeof value === 'string' && value.length >= 4) text = text.replaceAll(value, '[已脱敏]');
  }
  return text;
}

export function createWorkers({ transport, accounts, runAgent, inspectBrowser, experience, extended = false, nativeTools = false,
  readSaveEvidence, pollMs = 1500, pollAttempts = 60, maxStages = null, logger }) {
  const extendedMode = Boolean(extended || nativeTools);
  async function readVerdict(session, target, marker, signal, priorFailedVerdict = null) {
    let previous;
    for (let attempt = 0; attempt < pollAttempts; attempt++) {
      if (attempt) await delay(pollMs, undefined, { signal });
      const observed = await transport.inspect(session, target, { signal });
      if (observed.state === 'passed' || confirmsFailure(previous, observed, marker, {
        priorFailedVerdict,
        settleFinal: attempt === pollAttempts - 1,
      })) return observed;
      previous = observed;
    }
  }

  async function reconcile(task, { signal, checkpoint }) {
    signal.throwIfAborted();
    return accounts.withSession(task.accountId, async session => {
      const target = task.binding ? { binding: task.binding } : { courseId: task.courseId, homeworkId: task.homeworkId };
      const remote = await transport.inspect(session, target, { signal });
      signal.throwIfAborted();
      if (remote.state === 'passed') return passed(remote);
      if (task.mutation?.phase === 'write' && !remote.evaluating && readSaveEvidence && transport.recoverCodeWrite) {
        const evidence = await readSaveEvidence(task.sessionId, signal);
        const marker = task.mutation.marker;
        if (evidence) {
          const proof = await transport.recoverCodeWrite(session, target, { ...evidence, marker }, { signal, readCurrent: true });
          if (proof) {
            checkpoint({ mutation: { phase: 'evaluate', marker } });
            await transport.evaluate(session, target, proof, { signal });
            const observed = await readVerdict(session, target, marker, signal);
            if (observed?.state === 'passed') return passed(observed);
            if (observed) return { ...decision(observed), status: 'failed', code: 'verification_failed', settled: true, mutation: null };
            return { status: 'manual', code: 'verification_pending' };
          }
          return { ...decision(remote), status: 'paused', code: 'resume_after_readback', mutation: null };
        }
        if (await transport.confirmCurrentCode?.(session, target, marker, { signal })) {
          return { ...decision(remote), status: 'paused', code: 'resume_after_readback', mutation: null };
        }
      }
      if (task.mutation?.phase === 'evaluate' && failedAfter(remote, task.mutation.marker)) {
        let observed = remote;
        if (remote.state !== 'failed') {
          await delay(pollMs, undefined, { signal });
          observed = await transport.inspect(session, target, { signal });
          signal.throwIfAborted();
        }
        if (observed.state === 'passed') return passed(observed);
        if (confirmsFailure(remote, observed, task.mutation.marker)) {
          return { ...decision(observed), status: 'failed', code: 'verification_failed', settled: true, mutation: null };
        }
      }
      if (task.mutation?.phase === 'terminal' && !remote.evaluating && remote.kind === 'code') {
        return { ...decision(remote), status: 'paused', code: 'resume_after_readback', mutation: null };
      }
      if (task.mutation) {
        return { status: 'manual', code: task.mutation.phase === 'evaluate' ? 'verification_pending' : 'write_unverified' };
      }
      return { ...decision(remote), status: 'paused', code: 'recovery_required' };
    }, { worker: true });
  }

  async function worker(task, { signal, checkpoint, current }) {
    return accounts.withSession(task.accountId, async session => {
      const scope = { courseId: task.courseId, homeworkId: task.homeworkId };
      let remote = await transport.inspect(session, task.binding ? { binding: task.binding } : scope, {
        signal, open: !task.binding,
      });
      // 续关前重新核验上一关。重复读取已完成的关卡不占本轮的新关卡配额。
      const continuing = task.binding?.taskId === remote.binding.taskId && remote.state === 'passed' &&
        Boolean(task.nextTaskId && task.nextTaskId === remote.nextTaskId);
      const stageLimit = maxStages == null ? Infinity : maxStages + Number(continuing);
      const visited = new Set();
      for (let stage = 0; stage < stageLimit; stage++) {
        signal.throwIfAborted();
        const binding = remote.binding;
        if (visited.has(binding.taskId)) return { status: 'manual', code: 'invalid_scope' };
        visited.add(binding.taskId);
        checkpoint(decision(remote));
        if (remote.state !== 'passed') {
          if (remote.evaluating) {
            const observed = await readVerdict(session, { binding }, task.marker ?? remote.marker, signal, remote.failedVerdict);
            if (!observed) return { status: 'failed', code: 'verification_pending' };
            remote = observed;
            checkpoint(decision(remote));
          }
        }
        if (remote.state !== 'passed') {
          const unsupported = remote.kind === 'manual' ? 'manual_required' :
            remote.kind === 'terminal' && !remote.terminalAvailable ? 'terminal_unavailable' : null;
          if (unsupported && !inspectBrowser) return { status: 'manual', code: unsupported };
          let codeProof;
          let terminalProof;
          let lastEvaluation;
          let toolError;
          let writing = false;
          let blocked = false;
          const bound = { binding };
          // The model cannot supply an account, a task, an endpoint or a submission proof.
          async function mutate(phase, operation, toolSignal) {
            if (writing) fail('busy');
            if (blocked) fail('uncertain');
            writing = true;
            try {
              signal.throwIfAborted();
              toolSignal.throwIfAborted();
              const marker = remote.marker;
              const previousMutation = current().mutation;
              checkpoint({ mutation: { phase, marker }, marker });
              try {
                return await operation(marker, toolSignal, previousMutation);
              } catch (error) {
                if (error?.code === 'already_passed') {
                  const observed = await transport.inspect(session, bound, { signal: toolSignal });
                  if (observed.state !== 'passed') throw error;
                  remote = observed;
                  lastEvaluation = 'passed';
                  checkpoint({ ...decision(observed), mutation: null });
                  return { status: 'passed', feedback: '头歌已确认当前关卡通过。' };
                }
                if (phase === 'evaluate' && ['invalid_input', 'choice_closed', 'choice_changed'].includes(error?.code)) {
                  checkpoint({ mutation: previousMutation ?? null });
                  const feedback = {
                    choice_closed: '平台已关闭本关评测。',
                    choice_changed: '平台更新了题目或选项，请刷新关卡题面。',
                    invalid_input: '参数格式与当前关卡不符，请核对题型和选项后重试。',
                  };
                  if (error.code === 'choice_closed') toolError = error;
                  return { status: 'not_ready', feedback: feedback[error.code] };
                }
                throw error;
              }
            } catch (error) {
              blocked = true;
              codeProof = undefined;
              terminalProof = undefined;
              toolError = error;
              throw error;
            } finally {
              writing = false;
            }
          }

          const submitChoices = remote.kind === 'choice' ? (answers, toolSignal) =>
            mutate('evaluate', async (marker, active) => {
              const score = await transport.submitChoices(session, bound, answers, { signal: active, questions: remote.questions });
              const observed = await transport.inspect(session, bound, { signal: active });
              if (observed.state === 'passed' || score.state === 'failed') {
                lastEvaluation = observed.state === 'passed' ? 'passed' : 'failed';
                remote = observed;
                checkpoint({ ...decision(observed), mutation: null });
                return { status: lastEvaluation, feedback: redactSession(choiceFeedback(score, lastEvaluation), session) };
              }
              const verified = await readVerdict(session, bound, marker, active);
              if (verified?.state === 'passed') {
                lastEvaluation = 'passed';
                remote = verified;
                checkpoint({ ...decision(verified), mutation: null });
                return { status: 'passed', feedback: redactSession(choiceFeedback(score, 'passed'), session) };
              }
              blocked = true;
              return { status: 'pending', feedback: '平台尚未确认选择题评测结果。' };
            }, toolSignal) : undefined;
          let result;
          const priorMarker = remote.marker;
          const priorFailedVerdict = remote.failedVerdict;
          const { sessionResume, sessionResumeTransfer } = current();
          result = await runAgent({
            title: redactSession(remote.title, session),
            instructions: redactSession(remote.instructions, session),
            examples: remote.feedback?.publicTests?.filter(example => example.input !== undefined || example.expected !== undefined)
              .map(({ input, expected }) => ({
                input: input === undefined ? undefined : redactSession(input, session),
                expected: expected === undefined ? undefined : redactSession(expected, session),
              })),
            paths: remote.paths,
            questions: remote.questions,
            kind: unsupported ? 'browser' : remote.kind,
            courseId: task.courseId,
            homeworkId: task.homeworkId,
            binding,
            workdirKey: `${task.accountId}-${task.id}`,
            session: {
              remoteUserId: session.remoteUserId,
              session: session.session,
              autologin: session.autologin,
              zzud: session.zzud,
            },
            terminalAvailable: Boolean(remote.terminalAvailable),
            submitChoices,
            ...(inspectBrowser && (unsupported || remote.imagesUnavailable) ? { inspectBrowser: async active => {
              const page = await inspectBrowser({ session, binding, signal: active });
              return { text: redactSession(page.text, session) };
            } } : {}),
            ...(!unsupported && experience ? { recordExperience: async (note, active) => {
              const store = await experience;
              if (!store) return { saved: false };
              return store.append(note, {
                secrets: [session.zzud, session.autologin, session.session], signal: active,
              });
            } } : {}),
            imageCount: remote.imageCount,
            imagesUnavailable: remote.imagesUnavailable,
            loadImages: active => transport.readStatementImages(remote, { signal: active }),
            accountRef: task.accountId,
            taskId: task.id,
            stageId: binding.taskId,
            sessionResume,
            resumeFromPreviousStage: Boolean(extendedMode && sessionResume && sessionResumeTransfer?.toTaskId === binding.taskId),
            signal,
            onSession: sessionId => checkpoint({ sessionId }),
            readFile: async (path, toolSignal) => redactSession(
              await transport.readFile(session, bound, path, { signal: toolSignal }), session,
            ),
            saveFile: (path, content, toolSignal) => mutate('write', async (marker, active, previousMutation) => {
              codeProof = undefined;
              try {
                codeProof = await transport.saveFile(session, bound, path, content, { signal: active });
              } catch (error) {
                if (error?.code !== 'uncertain' || !transport.recoverCodeWrite) throw error;
                codeProof = await transport.recoverCodeWrite(session, bound, { path, content, marker }, { signal: active });
                if (!codeProof) throw error;
              }
              checkpoint({ mutation: previousMutation ?? null });
            }, toolSignal),
            ...(remote.terminalAvailable ? { runTerminal: async (command, toolSignal) => {
              if (remote.kind === 'code') {
                if (writing) fail('busy');
                if (blocked) fail('uncertain');
                writing = true;
                try {
                  signal.throwIfAborted();
                  toolSignal.throwIfAborted();
                  const terminal = await transport.runTerminal(session, bound, command, { signal: toolSignal });
                  if (!terminal.notAvailable) terminalProof = terminal.proof;
                  return { exitCode: terminal.exitCode, output: redactSession(terminal.output, session) };
                } finally {
                  writing = false;
                }
              }
              return mutate('terminal', async (_marker, active, previousMutation) => {
                const terminal = await transport.runTerminal(session, bound, command, { signal: active });
                checkpoint({ mutation: previousMutation ?? null });
                if (!terminal.notAvailable) terminalProof = terminal.proof;
                return { exitCode: terminal.exitCode, output: redactSession(terminal.output, session) };
              }, toolSignal);
            } } : {}),
            evaluate: async (toolSignal, environment = 'auto') => {
              const proof = environment === 'terminal' ? terminalProof : environment === 'code' ? codeProof : codeProof ?? terminalProof;
              if (!proof) return { status: 'not_ready', feedback: '本轮还没有可评测的修改。请先保存完整代码，或在关卡终端成功执行命令，再提交评测。' };
              const priorFailedVerdict = remote.failedVerdict;
              return mutate('evaluate', async (marker, active) => {
                codeProof = undefined;
                terminalProof = undefined;
                await transport.evaluate(session, bound, proof, { signal: active });
                const observed = await readVerdict(session, bound, marker, active, priorFailedVerdict);
                if (observed) {
                  lastEvaluation = observed.state === 'passed' ? 'passed' : 'failed';
                  remote = observed;
                  checkpoint({ ...decision(observed), mutation: null });
                  return { status: lastEvaluation, feedback: redactSession(feedback(observed), session) };
                }
                blocked = true;
                return { status: 'pending', feedback: '平台尚未确认评测结果。' };
              }, toolSignal);
            },
          });
          signal.throwIfAborted();
          if (toolError?.code === 'auth_required') throw toolError;
          if (toolError?.code === 'choice_closed') return { status: 'manual', code: 'choice_closed' };
          if (current().mutation) return { status: 'manual', code: 'verification_pending' };
          if (['image_unavailable', 'image_model_unsupported'].includes(result.code)) {
            return { status: 'manual', code: result.code };
          }
          remote = await transport.inspect(session, bound, { signal });
          if (remote.evaluating) {
            const observed = await readVerdict(session, bound, priorMarker, signal, priorFailedVerdict);
            if (!observed) return { status: 'failed', code: 'verification_pending' };
            remote = observed;
          }
          const sessionResumeSuccessor = extendedMode && remote.state === 'passed' && result.sessionResume?.scopeKey
            ? remote.nextTaskId : undefined;
          checkpoint({
            ...decision(remote),
            ...(!remote.evaluating && result.sessionResume && (remote.state !== 'passed' || sessionResumeSuccessor)
              ? { sessionResume: result.sessionResume } : {}),
            ...(sessionResumeSuccessor && !remote.evaluating ? { sessionResumeSuccessor } : {}),
          });
          if (remote.state !== 'passed') {
            if (unsupported) return { status: 'manual', code: unsupported };
            const failedVerification = lastEvaluation === 'failed' ||
              failedAfter(remote, priorMarker) ||
              Boolean(remote.failedVerdict && remote.failedVerdict !== priorFailedVerdict);
            if (failedVerification) return { status: 'failed', code: 'verification_failed' };
            const code = ['timeout', 'budget'].includes(result.status) ? result.status : 'agent_failed';
            if (code === 'agent_failed') {
              logger?.warn?.('EduCoder 关卡执行失败。', {
                taskId: task.id,
                stageId: binding.taskId,
                phase: result.code ?? 'agent_failed',
                steps: result.steps ?? 0,
              });
            }
            return { status: 'failed', code };
          }
        }
        if (!remote.nextTaskId) return passed(remote);
        if (stage + 1 === stageLimit) return { ...decision(remote), status: 'paused', code: 'stage_limit' };
        remote = await transport.inspect(session, { binding: remote.binding, advanceTo: remote.nextTaskId }, { signal });
      }
      return { status: 'paused', code: 'stage_limit' };
    }, { worker: true });
  }

  return { worker, reconcile };
}
