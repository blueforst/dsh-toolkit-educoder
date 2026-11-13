import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { createTerminalRunner, TerminalNotReadyError } from '../plugins/educoder/terminal-runner.js';

class Socket extends EventTarget {
  sent = [];
  close() { this.closed = true; }
  send(json) { this.sent.push(JSON.parse(json)); }
  message(bytes, { binary = false } = {}) {
    const base64 = Buffer.from(bytes).toString('base64');
    this.dispatchEvent(new MessageEvent('message', { data: binary ? Uint8Array.from(Buffer.from(base64)).buffer : base64 }));
  }
}

const input = {
  endpoint: 'wss://webssh.educoder.net/ws', host: 'container.internal', port: 22,
  username: 'node', password: 'fixture-password', command: 'printf test',
};

async function waitForClient(socket) {
  for (let attempts = 0; attempts < 10_000; attempts++) {
    const sent = socket.sent.find(message => message.tp === 'client');
    if (sent) return sent;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail('终端命令未发出');
}

test('按头歌协议执行多行命令并从分帧输出确认真实退出码', async () => {
  const socket = new Socket();
  const run = createTerminalRunner({ openSocket(url) { assert.equal(url.href, input.endpoint); return socket; } });
  const result = run({ ...input, command: `# ${'字'.repeat(1000)}\nprintf '测试%s' '完成'\nexit 7` });
  socket.dispatchEvent(new Event('open'));
  assert.deepEqual(socket.sent, [{ tp: 'init', data: {
    host: input.host, ssh_address: input.host, port: input.port,
    username: input.username, password: input.password, secret: input.password,
    width: 1200, height: 800, rows: 24, columns: 100,
  } }]);
  socket.message('gateway greeting');
  const { data } = await waitForClient(socket);
  assert.ok(data.split('\r').every(line => line.length < 4096));
  socket.message(data); // PTY 回显中的文字标记不可完成命令。
  const output = execFileSync('sh', ['-c', data.replaceAll('\r', '\n')]);
  for (let offset = 0; offset < output.length; offset += 5) {
    socket.message(output.subarray(offset, offset + 5), { binary: true });
  }
  assert.deepEqual(await result, { exitCode: 7, output: '测试完成' });
  assert.equal(socket.closed, true);
});

test('区分命令发出前断开、发出后断开和取消，所有路径都关闭连接', async () => {
  for (const trigger of ['before', 'after', 'abort']) {
    const socket = new Socket();
    const controller = new AbortController();
    const run = createTerminalRunner({ openSocket: () => socket });
    const result = run({ ...input, signal: controller.signal });
    socket.dispatchEvent(new Event('open'));
    socket.message('ready');
    const expected = trigger === 'before' ? TerminalNotReadyError :
      trigger === 'after' ? /连接已中断/u : { name: 'AbortError' };
    const rejected = assert.rejects(result, expected);
    if (trigger === 'after') await waitForClient(socket);
    else await setImmediate();
    if (trigger === 'abort') controller.abort();
    else socket.dispatchEvent(new Event('close'));
    await rejected;
    assert.equal(socket.closed, true);
  }
});

test('终端拒绝明文和非默认端口', async () => {
  const run = createTerminalRunner({ openSocket: () => assert.fail('不应创建连接') });
  for (const endpoint of ['ws://webssh.educoder.net/ws', 'wss://webssh.educoder.net:444/ws']) {
    await assert.rejects(run({ ...input, endpoint }), /地址无效/u);
  }
});
