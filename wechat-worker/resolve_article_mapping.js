#!/usr/bin/env node

const {
  buildLatestCommentArticlesUrl,
  detectLoginState,
  ensureMpHome,
  launchPersistentContext,
  mpJsonFetch,
  normalizeLatestCommentArticleItem,
  parseArgs,
  parseLatestCommentArticlesPayload,
  toBool,
  toInt,
} = require("./common");

function buildPublishRecordPageUrl({ token, begin, count }) {
  const qs = new URLSearchParams({
    sub: "list",
    begin: String(begin),
    count: String(count),
    token: String(token),
    lang: "zh_CN",
  }).toString();
  return `/cgi-bin/appmsgpublish?${qs}`;
}

function getShortPath(url) {
  if (!url) {
    return "";
  }
  try {
    const parsed = new URL(String(url));
    return parsed.pathname.startsWith("/s/") ? parsed.pathname : "";
  } catch (error) {
    return "";
  }
}

function decodeHtmlEntities(text) {
  if (!text) {
    return "";
  }
  return String(text)
    .replace(/&quot;/g, "\"")
    .replace(/&#34;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractPublishPageJson(text) {
  const html = String(text || "");
  const marker = "publish_page";
  const markerIdx = html.indexOf(marker);
  if (markerIdx < 0) {
    return null;
  }
  const eqIdx = html.indexOf("=", markerIdx);
  if (eqIdx < 0) {
    return null;
  }
  const startIdx = html.indexOf("{", eqIdx);
  if (startIdx < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  let endIdx = -1;
  for (let i = startIdx; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx < 0) {
    return null;
  }

  const jsonText = html.slice(startIdx, endIdx + 1);
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    return null;
  }
}

function parsePublishInfo(rawPublishInfo) {
  if (!rawPublishInfo) {
    return null;
  }
  try {
    return JSON.parse(decodeHtmlEntities(rawPublishInfo));
  } catch (error) {
    return null;
  }
}

function findMappingFromPublishPage(publishPage, articleUrl) {
  if (!publishPage || typeof publishPage !== "object") {
    return null;
  }
  const targetShortPath = getShortPath(articleUrl);
  if (!targetShortPath) {
    return null;
  }
  const publishList = Array.isArray(publishPage.publish_list) ? publishPage.publish_list : [];

  for (const publishItem of publishList) {
    const publishInfo = parsePublishInfo(publishItem?.publish_info);
    if (!publishInfo || !Array.isArray(publishInfo.appmsg_info)) {
      continue;
    }
    for (let i = 0; i < publishInfo.appmsg_info.length; i += 1) {
      const article = publishInfo.appmsg_info[i];
      const contentUrl = article?.content_url || "";
      if (getShortPath(contentUrl) !== targetShortPath) {
        continue;
      }
      const mid = article?.appmsgid != null ? String(article.appmsgid) : "";
      if (!mid) {
        continue;
      }
      const seq = Number.isFinite(Number(article?.seq)) ? Number(article.seq) : null;
      const idx = String(seq == null ? (i + 1) : (seq + 1));
      return {
        msgid: `${mid}_${idx}`,
        mid,
        idx,
        sourceUrl: contentUrl,
        title: article?.title || "",
        commentId: article?.comment_id != null ? String(article.comment_id) : "",
        publishMsgId: publishInfo?.msgid != null ? String(publishInfo.msgid) : "",
      };
    }
  }
  return null;
}

async function resolveFromPublishRecords(page, token, articleUrl, options = {}) {
  const pageSize = toInt(options.pageSize, 10);
  const maxPages = toInt(options.maxPages, 50);
  const inspected = [];

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const begin = pageIndex * pageSize;
    const url = buildPublishRecordPageUrl({ token, begin, count: pageSize });
    const response = await mpJsonFetch(page, url);
    const html = (response.text || "").toString();
    inspected.push({
      url,
      ok: response.ok,
      status: response.status,
      hasPublishPage: html.includes("publish_page"),
      htmlLength: html.length,
    });

    const publishPage = extractPublishPageJson(html);
    if (!publishPage) {
      continue;
    }
    const publishList = Array.isArray(publishPage.publish_list) ? publishPage.publish_list : [];
    if (publishList.length === 0) {
      break;
    }
    const found = findMappingFromPublishPage(publishPage, articleUrl);
    if (found) {
      return { found, inspected };
    }
  }

  throw new Error(`发表记录页面中未找到文章映射: ${articleUrl}`);
}

async function resolveBackendCommentId(page, token, appmsgId, articleIdx, options = {}) {
  const pageSize = toInt(options.pageSize, 20);
  const maxPages = toInt(options.maxPages, 50);
  const inspected = [];

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const begin = pageIndex * pageSize;
    const response = await mpJsonFetch(page, buildLatestCommentArticlesUrl({
      token,
      begin,
      count: pageSize,
    }));
    const parsed = parseLatestCommentArticlesPayload(response.data);
    const appMsgList = Array.isArray(parsed?.app_msg_list?.app_msg)
      ? parsed.app_msg_list.app_msg
      : [];
    const normalizedItems = appMsgList.map((item) => normalizeLatestCommentArticleItem(item));
    inspected.push(...normalizedItems.map((item) => ({
      appmsgId: item.appmsgId,
      articleIdx: item.articleIdx,
      commentId: item.commentId,
      title: item.title,
    })));

    const matched = normalizedItems.find(
      (item) => item.appmsgId === String(appmsgId) && Number(item.articleIdx) === Number(articleIdx),
    );
    if (matched) {
      return { matched, inspected };
    }
    if (normalizedItems.length < pageSize) {
      break;
    }
  }
  throw new Error(`后台评论列表中未找到文章映射: mid=${appmsgId}, idx=${articleIdx}`);
}

async function main() {
  const args = parseArgs(process.argv);
  const articleUrl = args["article-url"] || process.env.WECHAT_ARTICLE_URL;
  if (!articleUrl) {
    throw new Error("missing --article-url");
  }

  const publishPageSize = toInt(args["publish-page-size"], 10);
  const publishMaxPages = toInt(args["publish-max-pages"], 50);
  const resolvePageSize = toInt(args["resolve-page-size"], 20);
  const resolveMaxPages = toInt(args["resolve-max-pages"], 50);

  const { context, page, profileDir } = await launchPersistentContext({
    profileDir: args["profile-dir"],
    headless: toBool(args.headless, toBool(process.env.WECHAT_WORKER_HEADLESS, true)),
    timeoutMs: args["timeout-ms"] ? Number(args["timeout-ms"]) : undefined,
  });

  try {
    await ensureMpHome(page);
    const state = await detectLoginState(page);
    if (!state.loggedIn || !state.token) {
      console.log(JSON.stringify({
        ok: false,
        needLogin: true,
        profileDir,
        ...state,
      }));
      return;
    }

    const publishResolved = await resolveFromPublishRecords(page, state.token, articleUrl, {
      pageSize: publishPageSize,
      maxPages: publishMaxPages,
    });
    const mid = String(publishResolved.found.mid);
    const idx = String(publishResolved.found.idx || "1");

    const backendResolved = await resolveBackendCommentId(page, state.token, mid, idx, {
      pageSize: resolvePageSize,
      maxPages: resolveMaxPages,
    });

    const commentId = String(
      backendResolved.matched.commentId
      || publishResolved.found.commentId
      || "",
    );

    console.log(JSON.stringify({
      ok: true,
      profileDir,
      token: state.token,
      commentId,
      article: {
        sourceUrl: articleUrl,
        mid,
        idx,
        biz: "",
        sn: "",
        title: publishResolved.found.title || backendResolved.matched.title || "",
      },
      resolved: {
        publishRecord: {
          matched: publishResolved.found,
          inspected: publishResolved.inspected,
        },
        backendArticle: {
          appmsgId: backendResolved.matched.appmsgId,
          articleIdx: backendResolved.matched.articleIdx,
          commentId: backendResolved.matched.commentId,
          title: backendResolved.matched.title,
          totalCommentCount: backendResolved.matched.totalCommentCount,
        },
        inspected: backendResolved.inspected,
      },
    }));
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error && error.stack ? error.stack : String(error),
  }));
  process.exit(1);
});
