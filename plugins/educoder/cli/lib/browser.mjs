import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireDshModule } from './dsh-require.mjs';

const webOrigin = 'https://www.educoder.net';
const apiOrigin = 'https://data.educoder.net';
const identifier = /^[a-zA-Z0-9_-]{1,120}$/u;
const numericId = /^[1-9][0-9]{0,14}$/u;
const cookieValue = /^[\x21-\x7e]{1,8192}$/u;
const maxText = 100_000;

export const browserErrors = Object.freeze({
  browser_unavailable: '头歌浏览器暂时无法启动。',
  browser_unreachable: '头歌网页或静态资源暂时无法访问。',
  browser_scope_unverified: '浏览器无法确认当前头歌账号和关卡。',
  browser_render_failed: '头歌关卡页面没有渲染出可读内容。',
  browser_cancelled: '头歌浏览器读取已停止。',
});

function browserError(code, detail) {
  return Object.assign(new Error(browserErrors[code]), {
    code,
    ...(detail ? { detail } : {}),
  });
}

function checkedScope(binding, session) {
  const { courseId, homeworkId, taskId, remoteUserId } = binding ?? {};
  if (!identifier.test(courseId ?? '') || !identifier.test(taskId ?? '') ||
      !numericId.test(homeworkId ?? '') || !numericId.test(remoteUserId ?? '') ||
      session?.remoteUserId !== remoteUserId ||
      ![session.session, session.autologin].every(value => typeof value === 'string' && cookieValue.test(value) && !/[;,]/u.test(value))) {
    throw browserError('browser_scope_unverified');
  }
  return {
    page: `${webOrigin}/tasks/${courseId}/${homeworkId}/${taskId}`,
    detail: `/api/tasks/${taskId}.json`,
    homeworkId,
    taskId,
    remoteUserId,
  };
}

function sameTaskPage(currentUrl, scope) {
  try {
    const actual = new URL(currentUrl);
    const expected = new URL(scope.page);
    return actual.origin === expected.origin && actual.pathname === expected.pathname;
  } catch {
    return false;
  }
}

function verifiedDetail(body, scope) {
  return String(body?.user?.user_id) === scope.remoteUserId &&
    String(body?.homework_common_id) === scope.homeworkId &&
    body?.game?.identifier === scope.taskId;
}

function cookiesFor(session) {
  return [webOrigin, apiOrigin].flatMap(url => [
    { url, name: 'autologin_trustie', value: session.autologin, secure: true, httpOnly: true },
    { url, name: '_educoder_session', value: session.session, secure: true, httpOnly: true },
  ]);
}

async function launchChromium(options) {
  // 与 DSH Web 镜像自带的浏览器验收工具使用同一份 Playwright。
  const chromiumPath = process.env.DSH_EDUCODER_CHROMIUM_PATH || '/usr/bin/chromium';
  const executablePath = existsSync(chromiumPath) ? chromiumPath : undefined;
  return requireDshModule('playwright-core', 'DSH_EDUCODER_PLAYWRIGHT').chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    ...options,
  });
}

function redact(text, session) {
  for (const secret of [session.session, session.autologin, session.zzud]) {
    if (typeof secret === 'string' && secret) {
      text = text.replaceAll(secret, '[已脱敏]').replaceAll(encodeURIComponent(secret), '[已脱敏]');
    }
  }
  return text.trim();
}

/** 在新启动的 Chromium 中只读取已绑定关卡，不做请求拦截。工具调用者不能提供 URL 或浏览器指令。 */
export function createBrowserInspector({ launch = launchChromium, proxy, timeoutMs = 60_000 } = {}) {
  return async function inspectBrowser({ session, binding, signal, screenshotPath }) {
    const scope = checkedScope(binding, session);
    const deadline = AbortSignal.timeout(timeoutMs);
    const opening = signal ? AbortSignal.any([deadline, signal]) : deadline;
    if (opening.aborted) throw browserError('browser_cancelled');
    let privateHome;
    let browser;
    let context;
    let failure = 'browser_unavailable';
    const stop = () => {
      void browser?.close().catch(() => {});
    };
    opening.addEventListener('abort', stop, { once: true });
    try {
      privateHome = await mkdtemp(join(tmpdir(), 'educoder-browser-'));
      browser = await launch({
        headless: true,
        timeout: Math.min(timeoutMs, 30_000),
        env: { HOME: privateHome, PATH: process.env.PATH, LANG: 'C.UTF-8' },
        ...(proxy ? { proxy: { server: proxy } } : {}),
      });
      opening.throwIfAborted();
      context = await browser.newContext({ acceptDownloads: false });
      await context.addCookies(cookiesFor(session));
      const page = await context.newPage();
      failure = 'browser_unreachable';
      const detail = page.waitForResponse(response => {
        try {
          const url = new URL(response.url());
          return response.ok() && url.origin === apiOrigin && url.pathname === scope.detail;
        } catch {
          return false;
        }
      }, { timeout: timeoutMs });
      const [document, detailResponse] = await Promise.all([
        page.goto(scope.page, { waitUntil: 'domcontentloaded', timeout: timeoutMs }),
        detail,
      ]);
      opening.throwIfAborted();
      if (!document?.ok()) throw browserError('browser_unreachable');
      if (!sameTaskPage(page.url(), scope)) {
        failure = 'browser_scope_unverified';
        throw browserError('browser_scope_unverified');
      }
      if (typeof detailResponse?.json === 'function') {
        const body = await detailResponse.json().catch(() => null);
        if (!verifiedDetail(body, scope)) {
          failure = 'browser_scope_unverified';
          throw browserError('browser_scope_unverified');
        }
      }
      await page.waitForLoadState?.('networkidle', { timeout: 10_000 }).catch(() => {});
      opening.throwIfAborted();
      if (!sameTaskPage(page.url(), scope)) {
        failure = 'browser_scope_unverified';
        throw browserError('browser_scope_unverified');
      }
      failure = 'browser_render_failed';
      const text = await page.locator('body').evaluate(body => body.innerText.slice(0, 120_000), undefined,
        { timeout: 10_000 });
      opening.throwIfAborted();
      const clean = redact(text, session);
      if (!clean) throw browserError('browser_render_failed');
      if (screenshotPath && typeof page.screenshot === 'function') {
        await page.screenshot({ path: screenshotPath, fullPage: true });
        return { text: clean.slice(0, maxText), screenshotPath };
      }
      return { text: clean.slice(0, maxText) };
    } catch (error) {
      if (signal?.aborted) throw browserError('browser_cancelled');
      const code = Object.hasOwn(browserErrors, error?.code) ? error.code : failure;
      const rawDetail = error?.detail || (typeof error?.message === 'string' && !Object.hasOwn(browserErrors, error?.code)
        ? redact(error.message, session).slice(0, 300)
        : undefined);
      throw browserError(code, rawDetail || undefined);
    } finally {
      opening.removeEventListener('abort', stop);
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
      if (privateHome) await rm(privateHome, { recursive: true, force: true }).catch(() => {});
    }
  };
}
