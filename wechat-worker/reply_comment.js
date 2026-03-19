#!/usr/bin/env node

const {
  launchPersistentContext,
  parseArgs,
  readStateFile,
  resolveMpHomeStateFast,
  toBool,
  writeStateFile,
} = require("./common");

const DEFAULT_COMMENT_PAGE_TIMEOUT_MS = 15000;

function buildCommentManagePageUrl(token) {
  const params = new URLSearchParams({
    action: "list_latest_comment",
    begin: "0",
    count: "10",
    sendtype: "MASSSEND",
    scene: "1",
    token: String(token),
    lang: "zh_CN",
  });
  return `https://mp.weixin.qq.com/misc/appmsgcomment?${params.toString()}`;
}

function buildReplyEndpoint() {
  return "https://mp.weixin.qq.com/misc/appmsgcomment?action=reply_comment";
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

function readCachedString(stateFile, key) {
  const state = readStateFile(stateFile);
  const value = state?.[key];
  return typeof value === "string" ? value.trim() : "";
}

async function refreshToken(context, page, stateFile) {
  const homeState = await resolveMpHomeStateFast(context, page);
  const token = homeState.token || "";
  if (token) {
    writeStateFile(stateFile, {
      token,
      updatedAt: Date.now(),
    });
  }
  return token;
}

async function resolveFingerprint(page, stateFile, token, forceRefresh = false) {
  const managePageUrl = buildCommentManagePageUrl(token);
  const cachedFingerprint = readCachedString(stateFile, "commentFingerprint");
  const cachedFingerprintToken = readCachedString(stateFile, "commentFingerprintToken");
  if (!forceRefresh && cachedFingerprint && cachedFingerprintToken === String(token)) {
    return {
      fingerprint: cachedFingerprint,
      referer: managePageUrl,
      fromCache: true,
    };
  }

  let fingerprint = "";

  const onRequest = (request) => {
    try {
      const url = new URL(request.url());
      if (url.origin !== "https://mp.weixin.qq.com") {
        return;
      }
      if (url.pathname !== "/misc/appmsgcomment") {
        return;
      }
      const current = url.searchParams.get("fingerprint");
      if (current) {
        fingerprint = current;
      }
    } catch (error) {
      // ignore parse errors
    }
  };

  page.context().on("request", onRequest);
  try {
    await page.goto(managePageUrl, {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_COMMENT_PAGE_TIMEOUT_MS,
    });

    const startedAt = Date.now();
    while (!fingerprint && Date.now() - startedAt < DEFAULT_COMMENT_PAGE_TIMEOUT_MS) {
      await page.waitForTimeout(250);
    }
  } finally {
    page.context().off("request", onRequest);
  }

  if (!fingerprint) {
    throw new Error("missing fingerprint from comment manage page");
  }
  writeStateFile(stateFile, {
    commentFingerprint: fingerprint,
    commentFingerprintToken: String(token),
    commentFingerprintUpdatedAt: Date.now(),
  });
  return {
    fingerprint,
    referer: managePageUrl,
    fromCache: false,
  };
}

async function postReply(context, params, referer) {
  const response = await context.request.post(buildReplyEndpoint(), {
    timeout: 30000,
    form: params,
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
      referer,
      "accept-language": "zh-CN",
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
    status: response.status(),
    ok: response.ok(),
    url: response.url(),
    text,
    data,
  };
}

function isReplySuccess(result) {
  const ret = Number(result?.data?.base_resp?.ret);
  return Number.isFinite(ret) && ret === 0;
}

function looksLikeNeedLogin(result) {
  const text = String(result?.text || "");
  if (/微信扫一扫|公众平台登录|请使用微信扫码登录|重新扫码/.test(text)) {
    return true;
  }
  const errMsg = String(result?.data?.base_resp?.err_msg || "");
  return /not login|login|登录|scan/i.test(errMsg);
}

async function main() {
  const args = parseArgs(process.argv);
  const commentId = args["comment-id"];
  const contentId = args["content-id"];
  const replyText = args["reply-text"];
  const toReplyId = args["to-reply-id"];

  if (isBlank(commentId)) {
    throw new Error("missing --comment-id");
  }
  if (isBlank(contentId)) {
    throw new Error("missing --content-id");
  }
  if (isBlank(replyText)) {
    throw new Error("missing --reply-text");
  }

  const { context, page, profileDir } = await launchPersistentContext({
    profileDir: args["profile-dir"],
    headless: toBool(args.headless, true),
    timeoutMs: args["timeout-ms"] ? Number(args["timeout-ms"]) : undefined,
  });
  const stateFile = args["state-file"] || `${profileDir}/mp_state.json`;

  try {
    let token = readCachedString(stateFile, "token");
    if (!token) {
      token = await refreshToken(context, page, stateFile);
    }
    if (!token) {
      console.log(JSON.stringify({
        ok: false,
        needLogin: true,
        error: "missing token",
        profileDir,
      }, null, 2));
      return;
    }

    function buildForm(activeToken, activeFingerprint) {
      const form = {
        comment_id: String(commentId),
        content_id: String(contentId),
        content: String(replyText),
        need_elect: "0",
        fileids: "",
        fingerprint: activeFingerprint,
        token: activeToken,
        lang: "zh_CN",
        f: "json",
        ajax: "1",
      };
      if (!isBlank(toReplyId)) {
        form.to_reply_id = String(toReplyId);
      }
      return form;
    }

    let fingerprintInfo = await resolveFingerprint(page, stateFile, token, false);
    let form = buildForm(token, fingerprintInfo.fingerprint);
    let result = await postReply(context, form, fingerprintInfo.referer);
    let refreshed = false;

    if (!isReplySuccess(result)) {
      const refreshedToken = await refreshToken(context, page, stateFile);
      if (refreshedToken) {
        token = refreshedToken;
      }
      fingerprintInfo = await resolveFingerprint(page, stateFile, token, true);
      form = buildForm(token, fingerprintInfo.fingerprint);
      result = await postReply(context, form, fingerprintInfo.referer);
      refreshed = true;
    }

    const ok = isReplySuccess(result);

    console.log(JSON.stringify({
      ok,
      needLogin: !ok && looksLikeNeedLogin(result),
      profileDir,
      token,
      referer: fingerprintInfo.referer,
      refreshed,
      fingerprintFromCache: Boolean(fingerprintInfo.fromCache),
      request: form,
      response: {
        status: result.status,
        url: result.url,
        data: result.data,
        text: result.text,
      },
      replyId: result?.data?.reply_id ?? null,
      error: ok ? null : (result?.data?.base_resp?.err_msg || "reply_comment failed"),
    }, null, 2));
  } finally {
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
