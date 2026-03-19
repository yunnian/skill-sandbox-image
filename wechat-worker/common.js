#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const DEFAULT_PROFILE_DIR = process.env.WECHAT_WORKER_PROFILE_DIR || "/data/wechat-worker/profile";
const DEFAULT_TIMEOUT = Number(process.env.WECHAT_WORKER_TIMEOUT_MS || 30000);
const MP_HOME_URL = "https://mp.weixin.qq.com/";
const MP_ORIGIN = new URL(MP_HOME_URL).origin;
const WECHAT_MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.47(0x18002f2c) NetType/WIFI Language/zh_CN";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) {
      continue;
    }
    const eq = item.indexOf("=");
    if (eq > -1) {
      args[item.slice(2, eq)] = item.slice(eq + 1);
      continue;
    }
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null) {
    return fallback;
  }
  return ["1", "true", "yes", "y", "on"].includes(String(value).toLowerCase());
}

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function extractToken(url) {
  if (!url) {
    return null;
  }
  const matched = String(url).match(/[?&]token=(\d+)/);
  return matched ? matched[1] : null;
}

function parseArticleIdentifiersFromUrl(url) {
  if (!url) {
    return {
      sourceUrl: "",
      finalUrl: "",
      biz: null,
      mid: null,
      idx: null,
      sn: null,
      title: "",
    };
  }

  const sourceUrl = String(url);
  const result = {
    sourceUrl,
    finalUrl: sourceUrl,
    biz: null,
    mid: null,
    idx: null,
    sn: null,
    title: "",
  };

  try {
    const parsed = new URL(sourceUrl);
    result.biz = parsed.searchParams.get("__biz");
    result.mid = parsed.searchParams.get("mid");
    result.idx = parsed.searchParams.get("idx");
    result.sn = parsed.searchParams.get("sn");
    // 微信后台发表数据页常见形态：msgid=2247485498_1
    const msgid = parsed.searchParams.get("msgid");
    if (msgid && (!result.mid || !result.idx)) {
      const matched = String(msgid).match(/^(\d+)_([0-9]+)$/);
      if (matched) {
        if (!result.mid) {
          result.mid = matched[1];
        }
        if (!result.idx) {
          result.idx = matched[2];
        }
      }
    }
  } catch (error) {
    return result;
  }

  return result;
}

function readStateFile(stateFile) {
  if (!stateFile) {
    return {};
  }
  try {
    const text = fs.readFileSync(path.resolve(stateFile), "utf8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    return {};
  }
}

function writeStateFile(stateFile, patch = {}) {
  if (!stateFile) {
    return;
  }
  const resolved = path.resolve(stateFile);
  const current = readStateFile(resolved);
  const next = {
    ...current,
    ...patch,
  };
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(next, null, 2), "utf8");
}

async function launchPersistentContext(options = {}) {
  const profileDir = options.profileDir || DEFAULT_PROFILE_DIR;
  const headless = options.headless ?? toBool(process.env.WECHAT_WORKER_HEADLESS, true);
  const slowMo = toInt(options.slowMo ?? process.env.WECHAT_WORKER_SLOW_MO, 0);
  const viewport = {
    width: toInt(process.env.WECHAT_WORKER_VIEWPORT_WIDTH, 1440),
    height: toInt(process.env.WECHAT_WORKER_VIEWPORT_HEIGHT, 900),
  };

  const context = await chromium.launchPersistentContext(path.resolve(profileDir), {
    headless,
    slowMo,
    viewport,
    locale: "zh-CN",
    timezoneId: process.env.TZ || "Asia/Shanghai",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--no-default-browser-check",
      "--disable-features=Translate,OptimizationGuideModelDownloading,OptimizationHintsFetching,OptimizationTargetPrediction,OptimizationHints",
    ],
  });

  let page = context.pages()[0];
  if (!page) {
    page = await context.newPage();
  }
  page.setDefaultTimeout(options.timeoutMs || DEFAULT_TIMEOUT);
  return { context, page, profileDir };
}

async function ensureMpHome(page) {
  await page.goto(MP_HOME_URL, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
  return page.url();
}

async function detectLoginState(page) {
  const url = page.url();
  const title = await page.title();
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const token = extractToken(url);
  const waitingForConfirm = /扫码成功|请在微信中选择账号登录|重新扫码/.test(bodyText);
  const loginPage = /微信扫一扫|公众平台登录|请使用微信扫码登录|公众平台账号登录/.test(bodyText);
  const needLogin = (!token && loginPage) || waitingForConfirm;
  const loggedIn = Boolean(token)
    || (!needLogin && /\/cgi-bin\//.test(url) && /首页|数据助手|内容与互动|草稿箱|发表记录|用户管理/.test(bodyText));
  return {
    loggedIn,
    needLogin,
    waitingForConfirm,
    url,
    title,
    token,
    bodyPreview: String(bodyText || "").slice(0, 500),
  };
}

async function mpJsonFetch(page, relativeUrl) {
  return page.evaluate(async (requestUrl) => {
    const response = await fetch(requestUrl, {
      credentials: "include",
      headers: {
        accept: "application/json, text/plain, */*",
        "x-requested-with": "XMLHttpRequest",
      },
    });
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (error) {
      data = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      text,
      data,
    };
  }, relativeUrl);
}

function toAbsoluteMpUrl(requestUrl) {
  if (!requestUrl) {
    return MP_HOME_URL;
  }
  if (/^https?:\/\//i.test(String(requestUrl))) {
    return String(requestUrl);
  }
  return MP_ORIGIN + (String(requestUrl).startsWith("/") ? String(requestUrl) : `/${requestUrl}`);
}

async function mpJsonRequest(requestContext, requestUrl) {
  const response = await requestContext.get(toAbsoluteMpUrl(requestUrl), {
    timeout: DEFAULT_TIMEOUT,
    headers: {
      accept: "application/json, text/plain, */*",
      "x-requested-with": "XMLHttpRequest",
    },
  });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (error) {
    data = null;
  }
  return {
    ok: response.ok(),
    status: response.status(),
    url: response.url(),
    text,
    data,
  };
}

async function resolveMpHomeStateFast(context, page) {
  const currentUrl = page?.url?.() || "";
  const currentToken = extractToken(currentUrl);
  if (currentToken) {
    return {
      url: currentUrl,
      token: currentToken,
      bodyPreview: "",
    };
  }

  const response = await context.request.get(MP_HOME_URL, {
    timeout: DEFAULT_TIMEOUT,
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  const text = await response.text();
  return {
    url: response.url(),
    token: extractToken(response.url()),
    bodyPreview: String(text || "").slice(0, 500),
  };
}

function parseCommentListPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  const cloned = { ...payload };
  if (typeof cloned.comment_list === "string") {
    try {
      cloned.comment_list = JSON.parse(cloned.comment_list);
    } catch (error) {
      cloned.comment_list_parse_error = String(error);
    }
  }
  return cloned;
}

function buildLatestCommentArticlesUrl({ token, begin = 0, count = 20 }) {
  const params = new URLSearchParams({
    action: "list_latest_comment",
    begin: String(begin),
    count: String(count),
    token: String(token),
    lang: "zh_CN",
    f: "json",
    ajax: "1",
  });
  return `/misc/appmsgcomment?${params.toString()}`;
}

function parseLatestCommentArticlesPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  const cloned = { ...payload };
  if (typeof cloned.app_msg_list === "string") {
    try {
      cloned.app_msg_list = JSON.parse(cloned.app_msg_list);
    } catch (error) {
      cloned.app_msg_list_parse_error = String(error);
    }
  }
  return cloned;
}

function normalizeLatestCommentArticleItem(item) {
  const seq = Number.isFinite(Number(item?.item?.seq)) ? Number(item.item.seq) : 0;
  return {
    appmsgId: item?.id != null ? String(item.id) : "",
    articleIdx: seq + 1,
    commentId: item?.item?.comment_id != null ? String(item.item.comment_id) : "",
    title: item?.item?.title || "",
    createTime: item?.date_time ?? null,
    totalCommentCount: item?.total_comment_cnt ?? 0,
    newCommentCount: item?.new_comment_cnt ?? 0,
    enabled: item?.enabled === 1,
    raw: item,
  };
}

async function resolveArticleIdentifiers(articleUrl, options = {}) {
  const direct = parseArticleIdentifiersFromUrl(articleUrl);
  if (direct.mid && direct.idx) {
    return direct;
  }

  const browser = await chromium.launch({
    headless: options.headless ?? true,
  });

  try {
    const context = await browser.newContext({
      userAgent: WECHAT_MOBILE_UA,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      locale: "zh-CN",
    });
    await context.setExtraHTTPHeaders({
      Referer: "https://servicewechat.com/",
      "X-Requested-With": "com.tencent.mm",
    });

    const page = await context.newPage();
    page.setDefaultTimeout(options.timeoutMs || DEFAULT_TIMEOUT);
    await page.addInitScript(() => {
      window.WeixinJSBridge = window.WeixinJSBridge || {
        invoke() {},
        on() {},
        call() {},
      };
    });

    try {
      await page.goto(articleUrl, {
        waitUntil: "commit",
        timeout: options.timeoutMs || DEFAULT_TIMEOUT,
      });
    } catch (error) {
      // 微信短链偶发中断时仍可能已注入关键变量，继续往下读运行时状态
    }
    await page.waitForTimeout(options.waitMs || 3000);

    const runtime = await page.evaluate(() => ({
      href: location.href,
      biz: typeof window.biz !== "undefined" ? String(window.biz) : null,
      mid: typeof window.mid !== "undefined" ? String(window.mid) : null,
      idx: typeof window.idx !== "undefined" ? String(window.idx) : null,
      sn: typeof window.sn !== "undefined" ? String(window.sn) : null,
      title: document && document.title ? String(document.title) : "",
    }));

    const merged = {
      ...parseArticleIdentifiersFromUrl(runtime.href || articleUrl),
      sourceUrl: String(articleUrl || ""),
      finalUrl: runtime.href || articleUrl,
      biz: runtime.biz || direct.biz,
      mid: runtime.mid || direct.mid,
      idx: runtime.idx || direct.idx,
      sn: runtime.sn || direct.sn,
      title: runtime.title || direct.title || "",
    };

    await context.close();
    return merged;
  } finally {
    await browser.close();
  }
}

module.exports = {
  DEFAULT_PROFILE_DIR,
  DEFAULT_TIMEOUT,
  MP_HOME_URL,
  WECHAT_MOBILE_UA,
  buildLatestCommentArticlesUrl,
  detectLoginState,
  ensureMpHome,
  extractToken,
  launchPersistentContext,
  mpJsonFetch,
  mpJsonRequest,
  normalizeLatestCommentArticleItem,
  parseArgs,
  parseArticleIdentifiersFromUrl,
  parseCommentListPayload,
  parseLatestCommentArticlesPayload,
  readStateFile,
  resolveArticleIdentifiers,
  resolveMpHomeStateFast,
  toBool,
  toInt,
  writeStateFile,
};
