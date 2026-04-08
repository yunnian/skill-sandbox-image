#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const {
  detectLoginState,
  ensureMpHome,
  launchPersistentContext,
  parseArgs,
  toBool,
} = require("./common");

const EDITOR_READY_TIMEOUT_MS = 60000;
const DEFAULT_TRACK_IDLE_MS = 2500;
const DEFAULT_TRACK_TIMEOUT_MS = 90000;
const DEFAULT_PAYLOAD_WAIT_TIMEOUT_MS = 15000;

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

async function readJsonFileWithWait(filePath, timeoutMs = DEFAULT_PAYLOAD_WAIT_TIMEOUT_MS) {
  const resolvedPath = path.resolve(filePath);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const text = await fs.promises.readFile(resolvedPath, "utf8");
      return JSON.parse(text);
    } catch (error) {
      const retryable =
        error?.code === "ENOENT"
        || error?.code === "EACCES"
        || error?.code === "EBUSY"
        || error instanceof SyntaxError;
      if (!retryable) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`payload file not found or not readable within ${timeoutMs}ms: ${resolvedPath}`);
}

function decodeHtmlEntities(text) {
  if (!text) {
    return "";
  }
  return String(text)
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, "\"")
    .replace(/&#34;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function htmlToPlainText(html) {
  return decodeHtmlEntities(
    String(html || "")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\n\s+\n/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
  ).trim();
}

function extractImageSources(html) {
  const srcList = [];
  const imgSrcPattern = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = imgSrcPattern.exec(String(html || ""))) !== null) {
    srcList.push(match[1]);
  }
  return srcList;
}

function getUnsupportedImageSources(html) {
  return extractImageSources(html).filter((src) => {
    if (!src || src === "#") {
      return false;
    }
    return !/^https?:\/\//i.test(src);
  });
}

async function resolvePayload(args) {
  const payloadFile = args["payload-file"];
  const htmlFile = args["html-file"];
  let payload = {};
  let baseDir = process.cwd();
  const payloadWaitTimeoutMs = args["payload-wait-timeout-ms"]
    ? Number(args["payload-wait-timeout-ms"])
    : DEFAULT_PAYLOAD_WAIT_TIMEOUT_MS;

  if (!isBlank(payloadFile)) {
    payload = await readJsonFileWithWait(payloadFile, payloadWaitTimeoutMs);
    baseDir = path.dirname(path.resolve(payloadFile));
  }

  let html = typeof payload.html === "string" ? payload.html : "";
  if (isBlank(html) && !isBlank(htmlFile)) {
    html = fs.readFileSync(path.resolve(htmlFile), "utf8");
    baseDir = path.dirname(path.resolve(htmlFile));
  }

  const title = !isBlank(args.title) ? String(args.title).trim() : String(payload.title || "").trim();
  const author = !isBlank(args.author) ? String(args.author).trim() : String(payload.author || "").trim();
  const plainText = String(payload.plain_text || "").trim();

  if (isBlank(title)) {
    throw new Error("missing title");
  }
  if (isBlank(html)) {
    throw new Error("missing html or html-file");
  }

  return {
    title,
    author,
    html,
    plainText,
    baseDir,
  };
}

function buildEditorUrl(token) {
  const params = new URLSearchParams({
    t: "media/appmsg_edit_v2",
    action: "edit",
    isNew: "1",
    type: "77",
    token: String(token),
    lang: "zh_CN",
  });
  return `https://mp.weixin.qq.com/cgi-bin/appmsg?${params.toString()}`;
}

function createRequestTracker(page) {
  const state = {
    pending: 0,
    lastActivityAt: Date.now(),
    uploads: [],
    saves: [],
  };

  function isTracked(url) {
    return /uploadimg2cdn|operate_appmsg|pre_load_copyright_img/.test(String(url || ""));
  }

  const onRequest = (request) => {
    if (!isTracked(request.url())) {
      return;
    }
    state.pending += 1;
    state.lastActivityAt = Date.now();
  };

  const onRequestDone = (request) => {
    if (!isTracked(request.url())) {
      return;
    }
    state.pending = Math.max(0, state.pending - 1);
    state.lastActivityAt = Date.now();
  };

  const onResponse = async (response) => {
    const url = response.url();
    if (!isTracked(url)) {
      return;
    }
    state.lastActivityAt = Date.now();
    let data = null;
    try {
      const text = await response.text();
      data = text ? JSON.parse(text) : null;
    } catch (error) {
      data = null;
    }

    if (/uploadimg2cdn/.test(url)) {
      state.uploads.push({
        url,
        status: response.status(),
        ok: response.ok(),
        data,
      });
    }
    if (/operate_appmsg/.test(url)) {
      let action = "unknown";
      try {
        action = new URL(url).searchParams.get("sub") || "unknown";
      } catch (error) {
        action = "unknown";
      }
      state.saves.push({
        url,
        status: response.status(),
        ok: response.ok(),
        action,
        data,
      });
    }
  };

  page.on("request", onRequest);
  page.on("requestfinished", onRequestDone);
  page.on("requestfailed", onRequestDone);
  page.on("response", onResponse);

  return {
    state,
    async waitForIdle(maxWaitMs = DEFAULT_TRACK_TIMEOUT_MS, idleMs = DEFAULT_TRACK_IDLE_MS) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < maxWaitMs) {
        if (state.pending === 0 && Date.now() - state.lastActivityAt >= idleMs) {
          return true;
        }
        await page.waitForTimeout(250);
      }
      return false;
    },
    dispose() {
      page.off("request", onRequest);
      page.off("requestfinished", onRequestDone);
      page.off("requestfailed", onRequestDone);
      page.off("response", onResponse);
    },
  };
}

async function writeClipboardHtml(page, html, plainText) {
  await page.evaluate(async ({ htmlContent, textContent }) => {
    if (!navigator.clipboard || typeof navigator.clipboard.write !== "function" || typeof ClipboardItem === "undefined") {
      throw new Error("Clipboard API not available");
    }
    const item = new ClipboardItem({
      "text/html": new Blob([htmlContent], { type: "text/html" }),
      "text/plain": new Blob([textContent], { type: "text/plain" }),
    });
    await navigator.clipboard.write([item]);
  }, {
    htmlContent: html,
    textContent: plainText,
  });
}

async function waitForEditorReady(page) {
  await page.waitForSelector("textarea#title", { timeout: EDITOR_READY_TIMEOUT_MS });
  await page.waitForSelector(".ProseMirror", { timeout: EDITOR_READY_TIMEOUT_MS });
}

function extractAppMsgIdFromUrl(url) {
  if (!url) {
    return null;
  }
  try {
    return new URL(url).searchParams.get("appmsgid");
  } catch (error) {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const payload = await resolvePayload(args);

  const { context, page, profileDir } = await launchPersistentContext({
    profileDir: args["profile-dir"],
    headless: toBool(args.headless, toBool(process.env.WECHAT_WORKER_HEADLESS, true)),
    timeoutMs: args["timeout-ms"] ? Number(args["timeout-ms"]) : undefined,
  });

  const tracker = createRequestTracker(page);
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: "https://mp.weixin.qq.com",
    }).catch(() => {});

    await ensureMpHome(page);
    const loginState = await detectLoginState(page);
    if (!loginState.loggedIn || !loginState.token) {
      console.log(JSON.stringify({
        ok: false,
        needLogin: true,
        profileDir,
        ...loginState,
      }, null, 2));
      return;
    }

    const unsupportedImageSources = getUnsupportedImageSources(payload.html);
    if (unsupportedImageSources.length > 0) {
      throw new Error(
        `当前脚本仅支持可访问的 http(s) 图片地址，暂不支持 data URL、blob、本地文件或相对路径: ${unsupportedImageSources.slice(0, 5).join(", ")}`
      );
    }

    const plainText = payload.plainText || htmlToPlainText(payload.html);
    const inputImageCount = extractImageSources(payload.html).length;

    await page.goto(buildEditorUrl(loginState.token), {
      waitUntil: "domcontentloaded",
      timeout: EDITOR_READY_TIMEOUT_MS,
    });
    await waitForEditorReady(page);

    await page.locator("textarea#title").fill(payload.title);
    if (!isBlank(payload.author)) {
      const authorInput = page.locator("input#author");
      if (await authorInput.count()) {
        await authorInput.fill(payload.author);
      }
    }

    await writeClipboardHtml(page, payload.html, plainText);

    const editor = page.locator(".ProseMirror").first();
    await editor.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");

    await tracker.waitForIdle(60000, 3000);

    const saveCountBefore = tracker.state.saves.length;
    const saveButton = page.getByRole("button", { name: "保存为草稿" }).first();
    await saveButton.click();

    const saveStartedAt = Date.now();
    while (Date.now() - saveStartedAt < 60000) {
      if (tracker.state.saves.length > saveCountBefore) {
        break;
      }
      await page.waitForTimeout(300);
    }
    await tracker.waitForIdle(60000, 2500);

    const latestSave = tracker.state.saves[tracker.state.saves.length - 1] || null;
    const relevantSaves = tracker.state.saves.filter((item) => item.action === "create" || item.action === "update");
    const latestRelevantSave = relevantSaves[relevantSaves.length - 1] || latestSave;
    const currentUrl = page.url();
    const appMsgId = latestRelevantSave?.data?.appMsgId
      || latestRelevantSave?.data?.appmsgid
      || extractAppMsgIdFromUrl(currentUrl);
    const saveAction = latestRelevantSave?.action || null;
    const savedHtml = latestRelevantSave?.data?.filter_content_html?.[0]?.content || "";
    const imageUploadVerified = /data-imgfileid=/.test(savedHtml) || /data-src=/.test(savedHtml);

    if (inputImageCount > 0 && tracker.state.uploads.length === 0 && !imageUploadVerified) {
      throw new Error("草稿已创建，但未检测到公众号图片上传结果，请确认 HTML 中图片是公网可访问的 http(s) 链接");
    }

    console.log(JSON.stringify({
      ok: true,
      needLogin: false,
      profileDir,
      title: payload.title,
      author: payload.author || "",
      appMsgId: appMsgId || null,
      saveAction,
      editorUrl: currentUrl,
      inputImageCount,
      uploadCount: tracker.state.uploads.length,
      imageUploadVerified,
      saveCount: tracker.state.saves.length,
      lastUpload: tracker.state.uploads[tracker.state.uploads.length - 1] || null,
      lastSave: latestRelevantSave,
    }, null, 2));
  } finally {
    tracker.dispose();
    await context.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    needLogin: false,
    error: error && error.stack ? error.stack : String(error),
  }, null, 2));
  process.exit(1);
});
