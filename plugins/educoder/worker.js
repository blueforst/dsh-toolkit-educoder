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
  return remote.state === 'failed' && !remote.evaluating &&
    /^\d+$/u.test(remote.marker) && /^\d+$/u.test(marker) && Number(remote.marker) > Number(marker);
}

function feedback(remote) {
  return JSON.stringify({ compiler: remote.feedback?.compiler, tests: remote.feedback?.publicTests });
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

export function createWorkers({ transport, accounts, runAgent, pollMs = 1500, pollAttempts = 12, maxStages = 8 }) {
  async function reconcile(task, { signal }) {
    signal.throwIfAborted();
    return accounts.withSession(task.accountId, async session => {
      const target = task.binding ? { binding: task.binding } : { courseId: task.courseId, homeworkId: task.homeworkId };
      const remote = await transport.inspect(session, target, { signal });
      signal.throwIfAborted();
      if (remote.state === 'passed') return passed(remote);
      if (task.mutation?.phase === 'evaluate' && failedAfter(remote, task.mutation.marker)) {
        return { ...decision(remote), status: 'failed', code: 'verification_failed', settled: true, mutation: null };
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
      let remote = await transport.inspect(session, task.binding ? { binding: task.binding } : scope, { signal });
      const visited = new Set();
      for (let stage = 0; stage < maxStages; stage++) {
        signal.throwIfAborted();
        const binding = remote.binding;
        if (visited.has(binding.taskId)) return { status: 'manual', code: 'invalid_scope' };
        visited.add(binding.taskId);
        checkpoint(decision(remote));
        if (remote.state !== 'passed') {
          if (remote.evaluating) return { status: 'manual', code: 'verification_pending' };
          if (remote.kind === 'manual') return { status: 'manual', code: 'manual_required' };
          if (remote.kind === 'terminal' && !remote.terminalAvailable) {
            return { status: 'manual', code: 'terminal_unavailable' };
          }
          let proof;
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
              checkpoint({ mutation: { phase, marker }, marker });
              return await operation(marker, toolSignal);
            } catch (error) {
              blocked = true;
              proof = undefined;
              toolError = error;
              throw error;
            } finally {
              writing = false;
            }
          }

          const result = await runAgent({
            title: redactSession(remote.title, session),
            instructions: redactSession(remote.instructions, session),
            paths: remote.paths,
            kind: remote.kind,
            accountRef: task.accountId,
            taskId: task.id,
            signal,
            onSession: sessionId => checkpoint({ sessionId }),
            readFile: async (path, toolSignal) => redactSession(
              await transport.readFile(session, bound, path, { signal: toolSignal }), session,
            ),
            saveFile: (path, content, toolSignal) => mutate('write', async (_marker, active) => {
              proof = undefined;
              proof = await transport.saveFile(session, bound, path, content, { signal: active });
            }, toolSignal),
            runTerminal: (command, toolSignal) => mutate('terminal', async (_marker, active) => {
              proof = undefined;
              const terminal = await transport.runTerminal(session, bound, command, { signal: active });
              proof = terminal.proof;
              return { exitCode: terminal.exitCode, output: redactSession(terminal.output, session) };
            }, toolSignal),
            evaluate: async toolSignal => {
              if (!proof) fail('manual_required');
              return mutate('evaluate', async (marker, active) => {
                const submission = proof;
                proof = undefined;
                await transport.evaluate(session, bound, submission, { signal: active });
                for (let attempt = 0; attempt < pollAttempts; attempt++) {
                  if (attempt) await delay(pollMs, undefined, { signal: active });
                  const observed = await transport.inspect(session, bound, { signal: active });
                  if (observed.state === 'passed' || failedAfter(observed, marker)) {
                    lastEvaluation = observed;
                    remote = observed;
                    checkpoint({ ...decision(observed), mutation: null });
                    return { status: observed.state, feedback: redactSession(feedback(observed), session) };
                  }
                }
                blocked = true;
                return { status: 'pending', feedback: '平台尚未确认评测结果。' };
              }, toolSignal);
            },
          });
          signal.throwIfAborted();
          if (toolError?.code === 'auth_required') throw toolError;
          if (current().mutation) return { status: 'manual', code: 'verification_pending' };
          remote = await transport.inspect(session, bound, { signal });
          checkpoint(decision(remote));
          if (remote.state !== 'passed') {
            if (lastEvaluation?.state === 'failed') return { status: 'failed', code: 'verification_failed' };
            const code = ['timeout', 'budget'].includes(result.status) ? result.status : 'agent_failed';
            return { status: 'failed', code };
          }
        }
        if (!remote.nextTaskId) return passed(remote);
        if (stage + 1 === maxStages) return { ...decision(remote), status: 'paused', code: 'stage_limit' };
        remote = await transport.inspect(session, { binding: remote.binding, advanceTo: remote.nextTaskId }, { signal });
      }
      return { status: 'paused', code: 'stage_limit' };
    }, { worker: true });
  }

  return { worker, reconcile };
}
