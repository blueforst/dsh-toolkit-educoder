import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createExperience } from '../plugins/educoder/experience.js';

async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-educoder-experience-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'EduCoder');
  const workspace = { id: 'edu-workspace' };
  const registry = [];
  const workspaceRegistry = {
    async create(path, title) {
      registry.push({ path, title });
      return workspace;
    },
  };
  return { root, temp, workspace, registry, create: () => createExperience({ root, workspaceRegistry }) };
}

test('注册同一 EduCoder 目录并保留重开前的经验和工作区说明', async t => {
  const { root, workspace, registry, create } = await fixture(t);
  const experience = await create();
  const canonical = await realpath(root);
  assert.equal(experience.root, canonical);
  assert.equal(experience.workspace, workspace);
  assert.deepEqual(registry, [{ path: canonical, title: 'EduCoder' }]);
  assert.match(await readFile(join(root, 'README.md'), 'utf8'), /EduCoder 专属工作区/);
  assert.match(await experience.read(), /公开样例/);

  const note = '表格重排后确认输出列的顺序与题目一致。';
  assert.deepEqual(await Promise.all([experience.append(note), experience.append(note)]), [{ saved: true }, { saved: false }]);
  const reopened = await create();
  const content = await reopened.read();
  assert.equal(content.split(note).length, 2);
  assert.match(content, /公开样例/);
  assert.deepEqual(registry, [
    { path: canonical, title: 'EduCoder' },
    { path: canonical, title: 'EduCoder' },
  ]);
});

test('经验追加拒绝凭据、链接和多行代码，取消的写入不落盘', async t => {
  const { create } = await fixture(t);
  const experience = await create();
  const initial = await experience.read();
  for (const note of ['cookie=plain-secret', '请看 https://example.com', '一行\n二行', '记录 ```js', 'a'.repeat(301)]) {
    await assert.rejects(experience.append(note));
  }
  await assert.rejects(experience.append('这句包含当前会话 private-session-123', { secrets: ['private-session-123'] }));
  await assert.rejects(experience.append('取消后不保存', { signal: AbortSignal.abort() }));
  assert.equal(await experience.read(), initial);
});

test('经验库不会读取或写入被换成符号链接的文件', async t => {
  const { create, root, temp } = await fixture(t);
  const experience = await create();
  const file = join(root, '解题经验.md');
  const outside = join(temp, 'external.txt');
  await writeFile(outside, 'external data');
  await rm(file);
  await symlink(outside, file);
  await assert.rejects(experience.read());
  await assert.rejects(experience.append('一条经验'));
  assert.equal(await readFile(outside, 'utf8'), 'external data');
});
