#!/usr/bin/env node

const {
  buildLatestCommentArticlesUrl,
  detectLoginState,
  ensureMpHome,
  launchPersistentContext,
  mpJsonFetch,
  normalizeLatestCommentArticleItem,
  parseArgs,
  parseArticleIdentifiersFromUrl,
  parseCommentListPayload,
  parseLatestCommentArticlesPayload,
  resolveArticleIdentifiers,
  toBool,
  toInt,
} = require("./common");

function buildListCommentUrl({ token, commentId, begin, count, filterType, day, type, maxId }) {
  const params = new URLSearchParams({
    action: "list_comment",
    comment_id: String(commentId),
    begin: String(begin),
    count: String(count),
    filtertype: String(filterType),
    day: String(day),
    type: String(type),
    max_id: String(maxId),
    token: String(token),
    lang: "zh_CN",
    f: "json",
    ajax: "1",
  });
  return `/misc/appmsgcomment?${params.toString()}`;
}

function buildReplyUrl({ token, commentId, contentId, maxReplyId, limit, clearUnread }) {
  const params = new URLSearchParams({
    action: "get_comment_reply",
    comment_id: String(commentId),
    content_id: String(contentId),
    max_reply_id: String(maxReplyId),
    limit: String(limit),
    clear_unread: String(clearUnread),
    token: String(token),
    lang: "zh_CN",
    f: "json",
    ajax: "1",
  });
  return `/misc/appmsgcomment?${params.toString()}`;
}

function normalizeTopComment(comment, articleTitle) {
  return {
    articleTitle: articleTitle || "",
    commentId: comment?.id ?? null,
    contentId: comment?.content_id ?? null,
    commentThreadId: comment?.comment_id ?? null,
    author: {
      nickname: comment?.nick_name || "",
      fakeId: comment?.fake_id || "",
      avatar: comment?.icon || "",
      identityType: comment?.identity_type ?? null,
      identityOpenId: comment?.identity_open_id || "",
      ipLocation: comment?.ip_wording || "",
    },
    content: comment?.content || "",
    createTime: comment?.post_time ?? null,
    elected: Boolean(comment?.is_elected),
    fromUserSide: comment?.is_from === 1,
    likeCount: comment?.like_num ?? 0,
    status: comment?.status ?? null,
    tagInfo: comment?.tag_info || {},
  };
}

function normalizeReplyItem(reply, topComment) {
  const targetNickname = reply?.to_nick_name || topComment?.author?.nickname || "";
  const targetType = reply?.to_nick_name ? "reply" : "top_comment";
  return {
    replyId: reply?.reply_id ?? null,
    author: {
      nickname: reply?.nick_name || "",
      fakeId: reply?.fake_id || "",
      avatar: reply?.logo_url || "",
      identityType: reply?.identity_type ?? null,
      identityOpenId: reply?.identity_open_id || "",
      ipLocation: reply?.ip_wording || "",
    },
    content: reply?.content || "",
    createTime: reply?.create_time ?? null,
    elected: Boolean(reply?.reply_is_elected),
    deleted: Boolean(reply?.reply_del_flag),
    spam: Boolean(reply?.reply_spam_flag),
    fromAuthorSide: reply?.is_from === 0,
    likeCount: reply?.reply_like_num ?? 0,
    target: {
      type: targetType,
      nickname: targetNickname,
      content: reply?.to_content || topComment?.content || "",
    },
  };
}

function buildThread(topComment, replyItems = []) {
  return {
    topComment,
    replies: replyItems,
  };
}

function buildPublishRecordUrls({ token, begin, count }) {
  const qs = new URLSearchParams({
    begin: String(begin),
    count: String(count),
    token: String(token),
    lang: "zh_CN",
    f: "json",
    ajax: "1",
  }).toString();

  return [
    `/cgi-bin/newmasssendpage?action=list_ex&${qs}`,
    `/cgi-bin/newmasssendpage?action=history&${qs}`,
    `/cgi-bin/appmsgpublish?action=list&${qs}`,
    `/cgi-bin/appmsgpublish?action=publish_page&${qs}`,
    `/cgi-bin/appmsgpublish?action=history&${qs}`,
  ];
}

function parseMsgIdValue(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const text = String(value);
  const direct = text.match(/^(\d+)_([0-9]+)$/);
  if (direct) {
    return {
      msgid: `${direct[1]}_${direct[2]}`,
      mid: direct[1],
      idx: direct[2],
    };
  }
  const embedded = text.match(/msgid(?:=|%3D|["':\s])(\d+)_([0-9]+)/i);
  if (!embedded) {
    return null;
  }
  return {
    msgid: `${embedded[1]}_${embedded[2]}`,
    mid: embedded[1],
    idx: embedded[2],
  };
}

function extractMpUrlsFromString(value) {
  if (!value) {
    return [];
  }
  const text = String(value);
  const matches = text.match(/https?:\/\/mp\.weixin\.qq\.com\/[^\s"'\\<>]+/g) || [];
  return Array.from(new Set(matches));
}

function collectPublishCandidatesFromNode(node, out, depth = 0) {
  if (!node || depth > 10) {
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      collectPublishCandidatesFromNode(item, out, depth + 1);
    }
    return;
  }
  if (typeof node === "object") {
    let msgidInfo = null;
    let title = "";
    const urls = [];

    for (const [key, value] of Object.entries(node)) {
      if (value == null) {
        continue;
      }
      if (typeof value === "string" || typeof value === "number") {
        const text = String(value);
        if (!msgidInfo) {
          msgidInfo = parseMsgIdValue(text);
        }
        if (!title && /(title|name)$/i.test(key) && text.trim()) {
          title = text.trim();
        }
        urls.push(...extractMpUrlsFromString(text));
      }
    }

    if (msgidInfo) {
      out.push({
        ...msgidInfo,
        title,
        urls: Array.from(new Set(urls)),
      });
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === "object") {
        collectPublishCandidatesFromNode(value, out, depth + 1);
      }
    }
  }
}

function dedupePublishCandidates(candidates) {
  const map = new Map();
  for (const item of candidates) {
    const key = `${item.msgid}|${item.title || ""}`;
    if (!map.has(key)) {
      map.set(key, {
        msgid: item.msgid,
        mid: item.mid,
        idx: item.idx,
        title: item.title || "",
        urls: Array.from(new Set(item.urls || [])),
      });
      continue;
    }
    const prev = map.get(key);
    prev.urls = Array.from(new Set([...(prev.urls || []), ...(item.urls || [])]));
  }
  return Array.from(map.values());
}

function normalizeShortPath(url) {
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

function matchPublishCandidate(articleMeta, candidate) {
  if (!candidate) {
    return 0;
  }
  const targetMid = articleMeta?.mid ? String(articleMeta.mid) : "";
  const targetIdx = articleMeta?.idx ? String(articleMeta.idx) : "";
  const targetTitle = (articleMeta?.title || "").trim();
  const targetSn = articleMeta?.sn ? String(articleMeta.sn) : "";
  const targetBiz = articleMeta?.biz ? String(articleMeta.biz) : "";
  const targetShortPath = normalizeShortPath(articleMeta?.sourceUrl || articleMeta?.finalUrl || "");
  const urls = Array.isArray(candidate.urls) ? candidate.urls : [];

  if (targetMid && targetIdx && String(candidate.mid) === targetMid && String(candidate.idx) === targetIdx) {
    return 100;
  }
  if (targetTitle && candidate.title && candidate.title.trim() === targetTitle) {
    return 90;
  }
  if (targetSn && urls.some((url) => String(url).includes(`sn=${targetSn}`))) {
    return 80;
  }
  if (targetBiz && urls.some((url) => String(url).includes(`__biz=${targetBiz}`))) {
    return 70;
  }
  if (targetShortPath && urls.some((url) => normalizeShortPath(url) === targetShortPath)) {
    return 60;
  }
  return 0;
}

async function resolveMsgIdFromPublishRecords(page, token, articleMeta, options = {}) {
  const pageSize = toInt(options.pageSize, 20);
  const maxPages = toInt(options.maxPages, 5);
  const allCandidates = [];

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const begin = pageIndex * pageSize;
    const urls = buildPublishRecordUrls({ token, begin, count: pageSize });
    for (const url of urls) {
      const response = await mpJsonFetch(page, url);
      if (response.data && typeof response.data === "object") {
        collectPublishCandidatesFromNode(response.data, allCandidates, 0);
      }
    }
  }

  const candidates = dedupePublishCandidates(allCandidates);
  let best = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = matchPublishCandidate(articleMeta, candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  if (!best) {
    return {
      matched: null,
      inspectedCount: candidates.length,
      inspectedSample: candidates.slice(0, 20),
    };
  }

  return {
    matched: best,
    inspectedCount: candidates.length,
    inspectedSample: candidates.slice(0, 20),
  };
}

async function resolveBackendArticle(page, token, articleUrl, options = {}) {
  const articleMeta = await resolveArticleIdentifiers(articleUrl, {
    headless: toBool(options.headless, true),
    timeoutMs: options.timeoutMs,
    waitMs: options.waitMs,
  });

  let publishResolved = null;
  if (!articleMeta.mid) {
    publishResolved = await resolveMsgIdFromPublishRecords(page, token, articleMeta, {
      pageSize: options.publishPageSize,
      maxPages: options.publishMaxPages,
    });
    if (publishResolved?.matched?.mid) {
      articleMeta.mid = publishResolved.matched.mid;
      articleMeta.idx = publishResolved.matched.idx || articleMeta.idx || "1";
    }
  }

  if (!articleMeta.mid) {
    throw new Error(`无法从文章链接解析 mid: ${articleUrl}`);
  }

  const targetMid = String(articleMeta.mid);
  const targetIdx = Number(articleMeta.idx || 1);
  const pageSize = toInt(options.pageSize, 20);
  const maxPages = toInt(options.maxPages, 10);
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

    const matched = normalizedItems.find((item) => item.appmsgId === targetMid && item.articleIdx === targetIdx);
    if (matched) {
      return {
        articleMeta,
        matched,
        inspected,
        publishResolved,
      };
    }

    if (normalizedItems.length < pageSize) {
      break;
    }
  }

  throw new Error(`后台评论列表中未找到文章映射: mid=${targetMid}, idx=${targetIdx}`);
}

async function fetchReplies(page, token, commentId, comment, limit) {
  const replyMeta = comment?.new_reply || {};
  const maxReplyId = replyMeta.max_reply_id || replyMeta.max_id || comment?.reply?.reply_count || 0;
  const contentId = comment?.content_id;
  if (!contentId) {
    return null;
  }

  const response = await mpJsonFetch(page, buildReplyUrl({
    token,
    commentId,
    contentId,
    maxReplyId,
    limit,
    clearUnread: 1,
  }));

  return {
    contentId,
    raw: response.data || response.text,
    http: {
      ok: response.ok,
      status: response.status,
      url: response.url,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const articleUrl = args["article-url"] || process.env.WECHAT_ARTICLE_URL;
  const directCommentId = args["comment-id"] || process.env.WECHAT_COMMENT_ID;
  if (!directCommentId && !articleUrl) {
    throw new Error("missing --comment-id or --article-url");
  }

  const begin = toInt(args.begin, 0);
  const count = toInt(args.count, 20);
  const filterType = toInt(args["filter-type"], 0);
  const day = toInt(args.day, 0);
  const type = toInt(args.type, 2);
  const maxId = toInt(args["max-id"], 0);
  const withReplies = toBool(args["with-replies"], true);
  const replyLimit = toInt(args["reply-limit"], 20);
  const resolvePageSize = toInt(args["resolve-page-size"], 20);
  const resolveMaxPages = toInt(args["resolve-max-pages"], 10);
  const resolveWaitMs = toInt(args["resolve-wait-ms"], 3000);
  const publishPageSize = toInt(args["publish-page-size"], 20);
  const publishMaxPages = toInt(args["publish-max-pages"], 5);

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
      }, null, 2));
      return;
    }

    let resolvedArticle = null;
    let articleLinkMeta = articleUrl ? parseArticleIdentifiersFromUrl(articleUrl) : null;
    let commentId = directCommentId ? String(directCommentId) : null;
    if (!commentId && articleUrl) {
      resolvedArticle = await resolveBackendArticle(page, state.token, articleUrl, {
        headless: true,
        timeoutMs: args["timeout-ms"] ? Number(args["timeout-ms"]) : undefined,
        waitMs: resolveWaitMs,
        pageSize: resolvePageSize,
        maxPages: resolveMaxPages,
        publishPageSize,
        publishMaxPages,
      });
      articleLinkMeta = resolvedArticle.articleMeta;
      commentId = resolvedArticle.matched.commentId;
    }

    const response = await mpJsonFetch(page, buildListCommentUrl({
      token: state.token,
      commentId,
      begin,
      count,
      filterType,
      day,
      type,
      maxId,
    }));

    const parsed = parseCommentListPayload(response.data);
    const comments = Array.isArray(parsed?.comment_list?.comment)
      ? parsed.comment_list.comment
      : Array.isArray(parsed?.comment_list)
        ? parsed.comment_list
        : [];

    const articleTitle = parsed?.comment_list?.title || parsed?.title || "";
    const topComments = comments.map((comment) => normalizeTopComment(comment, articleTitle));
    const repliesByTopCommentId = new Map();
    if (withReplies) {
      for (let index = 0; index < comments.length; index += 1) {
        const comment = comments[index];
        const normalizedTopComment = topComments[index];
        const replyData = await fetchReplies(page, state.token, commentId, comment, replyLimit);
        if (replyData) {
          const replyList = replyData?.raw?.reply_list?.reply_list;
          repliesByTopCommentId.set(
            normalizedTopComment.commentId,
            Array.isArray(replyList)
              ? replyList.map((reply) => normalizeReplyItem(reply, normalizedTopComment))
              : [],
          );
        }
      }
    }

    const threads = topComments.map((topComment) => buildThread(
      topComment,
      repliesByTopCommentId.get(topComment.commentId) || [],
    ));

    console.log(JSON.stringify({
      ok: response.ok,
      profileDir,
      token: state.token,
      commentId: String(commentId),
      http: {
        status: response.status,
        url: response.url,
      },
      summary: {
        commentCount: comments.length,
        withReplies,
      },
      article: {
        title: articleTitle,
        commentId: String(commentId),
        sourceUrl: articleUrl || "",
        mid: articleLinkMeta?.mid || "",
        idx: articleLinkMeta?.idx || "",
        biz: articleLinkMeta?.biz || "",
        sn: articleLinkMeta?.sn || "",
      },
      threads,
      raw: {
        base_resp: parsed?.base_resp || null,
        comment_list_count: parsed?.comment_list_count || null,
      },
      resolved: resolvedArticle ? {
        publishRecord: resolvedArticle.publishResolved ? {
          matched: resolvedArticle.publishResolved.matched,
          inspectedCount: resolvedArticle.publishResolved.inspectedCount,
          inspectedSample: resolvedArticle.publishResolved.inspectedSample,
        } : null,
        backendArticle: {
          appmsgId: resolvedArticle.matched.appmsgId,
          articleIdx: resolvedArticle.matched.articleIdx,
          commentId: resolvedArticle.matched.commentId,
          title: resolvedArticle.matched.title,
          totalCommentCount: resolvedArticle.matched.totalCommentCount,
        },
        inspected: resolvedArticle.inspected,
      } : null,
    }, null, 2));
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error && error.stack ? error.stack : String(error),
  }, null, 2));
  process.exit(1);
});
