import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchStatementImage, statementImages } from '../plugins/educoder/statement-images.js';

const origin = 'https://data.educoder.net';
const cdn = 'https://prod-attachments.oss-accelerate.aliyuncs.com';
const png = '/api/attachments/OpaqueFigureId==?type=image/png';
const image = statementImages(`![示意图](${png})`, origin).images[0];

test('识别 Markdown 和 HTML 图片、顺序编号并去重；模型不会收到下载地址', () => {
  const result = statementImages(`甲 ![示意图](${png}) 乙 <img src="${origin}${png}"> 丙 <img src='/api/attachments/Figure2?type=image/jpeg'>`, origin);
  assert.equal(result.text, '甲 [参考图 1] 乙 [参考图 1] 丙 [参考图 2]');
  assert.deepEqual(result.images.map(({ index, mediaType }) => [index, mediaType]), [[1, 'image/png'], [2, 'image/jpeg']]);
  assert.equal(result.unavailable, false);
});

test('外链、用户信息、非图片类型和其他路径不能成为下载目标', () => {
  for (const src of ['https://evil.example' + png, '//data.educoder.net' + png,
    origin.replace('://', '://guest@') + png, '/api/tasks/5.json?type=image/png',
    png + '&other=value', png.replace('image/png', 'image/svg+xml')]) {
    const result = statementImages(`![](${src})`, origin);
    assert.equal(result.unavailable, true);
    assert.deepEqual(result.images, []);
    assert.ok(!result.text.includes(src));
  }
});

test('只跟随一次头歌到固定附件域名的跳转，全程不携带会话凭据', async () => {
  const calls = [];
  const bytes = Buffer.from('raster');
  const get = async (url, options) => {
    calls.push(url.origin);
    assert.equal(options.redirect, 'manual');
    assert.deepEqual(options.headers, { accept: 'image/png' });
    if (url.origin === origin) return new Response(null, { status: 302, headers: { location: cdn + '/image?signature=mock' } });
    return new Response(bytes, { headers: { 'content-type': 'image/png' } });
  };
  assert.deepEqual(await fetchStatementImage(get, image, 10, undefined, true), bytes);
  assert.deepEqual(calls, [origin, cdn]);
  for (const location of ['http://169.254.169.254/latest/meta-data', cdn.replace('://', '://user@') + '/image', 'https://unrelated.oss-accelerate.aliyuncs.com/image']) {
    let requests = 0;
    await assert.rejects(fetchStatementImage(async () => {
      requests++;
      return new Response(null, { status: 302, headers: { location } });
    }, image, 10, undefined, true));
    assert.equal(requests, 1);
  }
});

test('拒绝下一跳、非图片响应和无 Content-Length 的超限下载', async () => {
  let requests = 0;
  await assert.rejects(fetchStatementImage(async () => {
    requests++;
    return new Response(null, { status: 302, headers: { location: cdn + '/image' } });
  }, image, 10, undefined, true));
  assert.equal(requests, 2);
  await assert.rejects(fetchStatementImage(async () => new Response('html', { headers: { 'content-type': 'text/html' } }), image, 10));
  await assert.rejects(fetchStatementImage(async () => new Response('too large', { headers: { 'content-type': 'image/png' } }), image, 4));
});

test('接受 image/jpg 与 application/octet-stream 响应类型及更高单图上限', async () => {
  const jpgImage = statementImages('![图](/api/attachments/FigureJpg?type=image/jpeg)', origin).images[0];
  const bytes = Buffer.alloc(600 * 1024, 0x2a);
  const jpgResp = await fetchStatementImage(
    async () => new Response(bytes, { headers: { 'content-type': 'image/jpg' } }),
    jpgImage,
  );
  assert.equal(jpgResp.byteLength, bytes.byteLength);
  const binResp = await fetchStatementImage(
    async () => new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }),
    image,
  );
  assert.equal(binResp.byteLength, bytes.byteLength);
});
