import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const README = `# EduCoder 专属工作区

这里集中保存 EduCoder 解题会话和可复用的解题经验。DS 会在开始新关卡时参考《解题经验》。

关卡通过平台评测后，可以记录一句可迁移的方法或排查经验。账号信息、平台凭据、作业答案和隐藏测试不写入共享经验。
`;

const SEED = `# 解题经验

- 先读题面、起始文件和公开样例，再决定改哪些文件。保留题目要求的函数签名、文件路径和输出格式。
- 优先使用关卡提供的结构化工具。多个文件改完后统一评测，结果未确认时先核对平台状态。
- 题面含参考图时先对照图中的标签、布局和比例。评测未通过时，结合公开反馈逐项排查。
`;

const MAX_NOTE_LENGTH = 300;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_PROMPT_LENGTH = 3_000;
const SAFE_OPEN = constants.O_NOFOLLOW | constants.O_NONBLOCK;
const sensitive = /https?:\/\/|(?:www\.)?educoder\.net|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|\b(?:bearer\s+\S+|sk-[\w-]+|(?:cookie|password|passwd|token|api[_ -]?key|authorization|zzud)\s*[=:：])|(?:密码|令牌|密钥|学号|账号)\s*[=:：]/iu;

async function seed(path, content) {
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | SAFE_OPEN, 0o600);
    await handle.writeFile(content, 'utf8');
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  } finally {
    await handle?.close();
  }
}

async function checkFile(handle) {
  const info = await handle.stat();
  if (!info.isFile() || info.nlink !== 1 || info.size > MAX_FILE_BYTES) {
    throw new Error('无法读取 EduCoder 解题经验文件。');
  }
  return info.size;
}

function checkedNote(value, secrets) {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|```|~~~|[<>]/u.test(value)) {
    throw new Error('解题经验应为一行通用文字。');
  }
  const note = value.trim().replace(/\s+/gu, ' ');
  if (!note || note.length > MAX_NOTE_LENGTH) throw new Error('解题经验应为 1 至 300 字。');
  if (sensitive.test(note) || secrets.some(secret => typeof secret === 'string' && secret.length >= 4 &&
      (note.includes(secret) || note.includes(encodeURIComponent(secret))))) {
    throw new Error('解题经验不能包含账号信息、访问地址或凭据。');
  }
  return note;
}

export async function createExperience({ root, workspaceRegistry }) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new TypeError('EduCoder 工作区需要绝对目录。');
  const directory = resolve(root);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error('EduCoder 工作区路径不可用。');
  const canonical = await realpath(directory);
  const file = join(canonical, '解题经验.md');
  await seed(join(canonical, 'README.md'), README);
  await seed(file, SEED);
  const workspace = await workspaceRegistry.create(canonical, 'EduCoder');
  let writes = Promise.resolve();

  async function read() {
    const handle = await open(file, constants.O_RDONLY | SAFE_OPEN);
    try {
      await checkFile(handle);
      const content = await handle.readFile('utf8');
      const start = Math.max(content.length - MAX_PROMPT_LENGTH, 0);
      const firstNewline = start > 0 ? content.indexOf('\n', start) : -1;
      return content.slice(firstNewline < 0 ? start : firstNewline + 1).trim();
    } finally {
      await handle.close();
    }
  }

  function append(value, { secrets = [], signal } = {}) {
    const write = writes.then(async () => {
      signal?.throwIfAborted();
      const note = checkedNote(value, secrets);
      const handle = await open(file, constants.O_RDWR | constants.O_APPEND | SAFE_OPEN);
      try {
        const size = await checkFile(handle);
        const content = await handle.readFile('utf8');
        const line = `- ${note}`;
        if (content.split('\n').includes(line)) return { saved: false };
        const entry = `${content && !content.endsWith('\n') ? '\n' : ''}${line}\n`;
        if (size + Buffer.byteLength(entry) > MAX_FILE_BYTES) throw new Error('EduCoder 解题经验文件已满。');
        signal?.throwIfAborted();
        await handle.writeFile(entry, 'utf8');
        return { saved: true };
      } finally {
        await handle.close();
      }
    });
    writes = write.catch(() => {});
    return write;
  }

  return { root: canonical, workspace, read, append };
}
