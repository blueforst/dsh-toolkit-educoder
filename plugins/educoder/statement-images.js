const maxImages = 4;
const maxImageBytes = 512 * 1024;
const maxImageBatchBytes = 1536 * 1024;

const mediaTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const attachmentPath = /^\/api\/attachments\/[A-Za-z0-9_-]{1,256}={0,2}$/u;
const attachmentCdnOrigin = 'https://prod-attachments.oss-accelerate.aliyuncs.com';
// 头歌题面会混用 Markdown 图片和 HTML img 标签。
const imageMarkup = /!\[[^\]\r\n]*\]\(\s*(?:<([^<>\s]+)>|([^\s)]+))(?:\s+"[^"\r\n]*")?\s*\)|<img\b(?:"[^"]*"|'[^']*'|[^'">])*>/giu;
const htmlSrc = /\s+src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/iu;

function target(source, origin) {
  const input = source?.replace(/&amp;/gi, '&');
  if (!input || !/^(?:\/api\/attachments\/|https?:\/\/)/u.test(input) || /[\\\s#]/u.test(input)) return;
  let url;
  try { url = new URL(input, origin); } catch { return; }
  if (url.origin !== origin || url.username || url.password || !attachmentPath.test(url.pathname)) return;
  const mediaType = url.searchParams.get('type');
  if (!mediaTypes.has(mediaType) || [...url.searchParams].length !== 1) return;
  return { url, mediaType };
}

export function createStatementImageParser(origin) {
  const entries = new Map();
  let unavailable = false;
  const parse = statement => statement.replace(imageMarkup, (markup, angle, bare) => {
    const html = markup.startsWith('<') ? htmlSrc.exec(markup) : null;
    const image = target(angle ?? bare ?? html?.[1] ?? html?.[2] ?? html?.[3], origin);
    if (!image) {
      unavailable = true;
      return '[题面图片不可读取]';
    }
    const key = image.url.href;
    if (!entries.has(key)) {
      if (entries.size >= maxImages) {
        unavailable = true;
        return '[题面图片超出数量限制]';
      }
      entries.set(key, { ...image, index: entries.size + 1 });
    }
    return `[参考图 ${entries.get(key).index}]`;
  });
  return {
    parse,
    result: () => ({ images: [...entries.values()], unavailable }),
  };
}

export function statementImages(statement, origin) {
  const parser = createStatementImageParser(origin);
  return { text: parser.parse(statement), ...parser.result() };
}

export async function readImage(response, mediaType, availableBytes) {
  const limit = Math.min(maxImageBytes, availableBytes);
  if (!response.ok || !response.body || limit <= 0 ||
      response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== mediaType ||
      Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel().catch(() => {});
    throw new Error('无法读取题面图片');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw new Error('题面图片超出大小限制');
    chunks.push(chunk);
  }
  if (!size) throw new Error('题面图片为空');
  return Buffer.concat(chunks, size);
}

export async function fetchStatementImage(request, image, availableBytes, signal, production) {
  const get = url => request(url, { method: 'GET', headers: { accept: image.mediaType }, redirect: 'manual', signal });
  let response = await get(image.url);
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    const url = location && new URL(location, image.url);
    if (!production || !url || url.origin !== attachmentCdnOrigin || url.username || url.password || url.hash) {
      throw new Error('题面图片跳转超出允许范围');
    }
    // OSS 的签名链接仅用于一次匿名读取，不存入会话，也不跟随下一次跳转。
    response = await get(url);
  }
  return readImage(response, image.mediaType, availableBytes);
}

export { maxImageBatchBytes };
