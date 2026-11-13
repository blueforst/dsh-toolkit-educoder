import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { requireDshModule } from './dsh-require.mjs';

// 头歌 WebSSH 握手参照 educoder-cli 固定版本的 terminal.py。
const origin = 'https://www.educoder.net';
const maxCommandBytes = 8_192;
const maxOutputChars = 16_000;
const maxFrameBytes = 1024 * 1024;
const recordStart = '\x1e';
const recordEnd = '\x1f';

export class TerminalNotReadyError extends Error {
  constructor() {
    super('头歌终端在命令发出前断开。');
    this.name = 'TerminalNotReadyError';
  }
}

function decodeFrame(value) {
  const data = Buffer.from(value);
  if (data.length > maxFrameBytes) throw new Error('头歌终端消息超出大小限制。');
  const text = data.toString('ascii');
  if (data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/u.test(text)) {
    const decoded = Buffer.from(text, 'base64');
    if (decoded.toString('base64') === text && Buffer.from(text).equals(data)) return decoded;
  }
  return data;
}

function commandLines(command, id) {
  // 保持每行短于 Linux PTY 的输入行上限，也保留多行脚本和引号。
  const encoded = Buffer.from(command).toString('base64');
  const parts = encoded.match(/.{1,1500}/gu);
  const lines = ['__dsh_edu_cmd='];
  for (const part of parts) lines.push(`__dsh_edu_cmd=$__dsh_edu_cmd'${part}'`);
  // 终端回显中只有 printf 的转义文本，不会被当作真正的输出边界。
  lines.push(`printf '\\036%s\\037' '${id}'; __dsh_edu_script=$(printf '%s' "$__dsh_edu_cmd" | base64 -d) && sh -c "$__dsh_edu_script"; __dsh_edu_rc=$?; printf '\\036%s:%s\\037' '${id}' "$__dsh_edu_rc"; unset __dsh_edu_cmd __dsh_edu_script __dsh_edu_rc`);
  return lines.join('\r') + '\r';
}

function createSocketConnector(proxyUrl) {
  const headers = { Origin: origin };
  if (!proxyUrl) return url => new WebSocket(url, { headers });
  const proxy = new URL(proxyUrl);
  if (!['http:', 'https:'].includes(proxy.protocol) || proxy.username || proxy.password ||
      proxy.pathname !== '/' || proxy.search || proxy.hash) throw new TypeError('头歌终端代理地址无效。');
  const { ProxyAgent, WebSocket: ProxyWebSocket } = requireDshModule('undici', 'DSH_EDUCODER_UNDICI');
  const dispatcher = new ProxyAgent(proxy.href);
  return url => new ProxyWebSocket(url, { headers, dispatcher });
}

export function createTerminalRunner({
  proxyUrl,
  openSocket = createSocketConnector(proxyUrl),
} = {}) {
  return async function runTerminal({ endpoint, host, port, username, password, command, signal }) {
    signal?.throwIfAborted();
    const url = new URL(endpoint);
    if (url.protocol !== 'wss:' || url.port || url.username || url.password || url.hash) {
      throw new Error('头歌终端地址无效。');
    }
    if (typeof command !== 'string' || !command.trim() || Buffer.byteLength(command) > maxCommandBytes || command.includes('\0')) {
      throw new Error('头歌终端命令无效。');
    }

    const id = randomBytes(16).toString('hex');
    const start = recordStart + id + recordEnd;
    const end = recordStart + id + ':';
    const decoder = new StringDecoder('utf8');
    let socket;
    try { socket = openSocket(url); } catch { throw new TerminalNotReadyError(); }
    socket.binaryType = 'arraybuffer';

    return new Promise((resolve, reject) => {
      let commandSent = false;
      let shellResponded = false;
      let recording = false;
      let settled = false;
      let buffer = '';
      let output = '';
      let truncated = false;
      let waitForShell;
      let heartbeat;

      function finish(error, result) {
        if (settled) return;
        settled = true;
        clearTimeout(connectDeadline);
        clearTimeout(waitForShell);
        clearTimeout(deadline);
        clearInterval(heartbeat);
        signal?.removeEventListener('abort', onAbort);
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('message', onMessage);
        socket.removeEventListener('close', disconnected);
        socket.removeEventListener('error', disconnected);
        try { socket.close(); } catch { /* 连接可能已关闭。 */ }
        if (error) reject(error);
        else resolve(result);
      }

      function disconnected() {
        finish(commandSent ? new Error('头歌终端连接已中断。') : new TerminalNotReadyError());
      }

      function onAbort() {
        finish(signal.reason ?? new Error('头歌终端操作已取消。'));
      }

      function send(data) {
        try { socket.send(JSON.stringify(data)); } catch { disconnected(); }
      }

      function sendCommand() {
        if (settled || commandSent) return;
        commandSent = true;
        send({ tp: 'client', data: commandLines(command, id) });
      }

      function onOpen() {
        clearTimeout(connectDeadline);
        send({ tp: 'init', data: {
          host, ssh_address: host, port, username, password, secret: password,
          width: 1200, height: 800, rows: 24, columns: 100,
        } });
        if (!settled) {
          waitForShell = setTimeout(sendCommand, 3000);
          heartbeat = setInterval(() => send({ tp: 'h' }), 30_000);
        }
      }

      function append(text) {
        const remaining = maxOutputChars - output.length;
        output += text.slice(0, remaining);
        truncated ||= text.length > remaining;
      }

      function onMessage(event) {
        let data;
        try { data = decoder.write(decodeFrame(event.data)); }
        catch { disconnected(); return; }
        if (!commandSent) {
          if (!shellResponded && data.trim()) {
            shellResponded = true;
            clearTimeout(waitForShell);
            waitForShell = setTimeout(sendCommand, 500);
          }
          return;
        }
        buffer += data;
        if (!recording) {
          const position = buffer.indexOf(start);
          if (position === -1) {
            buffer = buffer.slice(-(start.length - 1));
            return;
          }
          recording = true;
          buffer = buffer.slice(position + start.length);
        }
        const position = buffer.indexOf(end);
        if (position === -1) {
          const boundary = Math.max(0, buffer.length - end.length + 1);
          append(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary);
          return;
        }
        append(buffer.slice(0, position));
        buffer = buffer.slice(position);
        const close = buffer.indexOf(recordEnd, end.length);
        if (close === -1 && buffer.length <= end.length + 3) return;
        const status = close === -1 ? '' : buffer.slice(end.length, close);
        if (!/^[0-9]{1,3}$/u.test(status) || Number(status) > 255) {
          finish(new Error('无法确认头歌终端命令退出状态。'));
          return;
        }
        finish(null, { exitCode: Number(status), output: output + (truncated ? '\n[终端输出已截断]' : '') });
      }

      const connectDeadline = setTimeout(() => finish(new TerminalNotReadyError()), 12_000);
      const deadline = setTimeout(() => finish(new Error('头歌终端执行超时。')), 90_000);
      socket.addEventListener('open', onOpen);
      socket.addEventListener('message', onMessage);
      socket.addEventListener('close', disconnected);
      socket.addEventListener('error', disconnected);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  };
}
