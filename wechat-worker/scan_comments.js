#!/usr/bin/env node

const {
  launchPersistentContext,
  mpJsonRequest,
  parseArgs,
  parseCommentListPayload,
  readStateFile,
  resolveMpHomeStateFast,
  toBool,
  toInt,
  writeStateFile,
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
    commentId: comment?.id ?? null,
    contentId: comment?.content_id ?? null,
    author: {
      nickname: comment?.nick_name || "",
      // fakeId: comment?.fake_id || "",
      // avatar: comment?.icon || "",
      // identityType: comment?.identity_type ?? null,
      // identityOpenId: comment?.identity_open_id || "",
      // ipLocation: comment?.ip_wording || "",
    },
    content: comment?.content || "",
    createTime: comment?.post_time ?? null,
    // articleTitle: articleTitle || "",
    // commentThreadId: comment?.comment_id ?? null,
    // elected: Boolean(comment?.is_elected),
    // fromUserSide: comment?.is_from === 1,
    // likeCount: comment?.like_num ?? 0,
    // status: comment?.status ?? null,
    // tagInfo: comment?.tag_info || {},
  };
}

function normalizeReplyItem(reply, topComment) {
  const targetNickname = reply?.to_nick_name || topComment?.author?.nickname || "";
  return {
    replyId: reply?.reply_id ?? null,
    author: {
      nickname: reply?.nick_name || "",
      // fakeId: reply?.fake_id || "",
      // avatar: reply?.logo_url || "",
      // identityType: reply?.identity_type ?? null,
      // identityOpenId: reply?.identity_open_id || "",
      // ipLocation: reply?.ip_wording || "",
    },
    content: reply?.content || "",
    createTime: reply?.create_time ?? null,
    target: {
      nickname: targetNickname,
      // type: reply?.to_nick_name ? "reply" : "top_comment",
      // content: reply?.to_content || topComment?.content || "",
    },
    fromAuthorSide: reply?.is_from === 0,
    // elected: Boolean(reply?.reply_is_elected),
    // deleted: Boolean(reply?.reply_del_flag),
    // spam: Boolean(reply?.reply_spam_flag),
    // likeCount: reply?.reply_like_num ?? 0,
  };
}

function buildThread(topComment, replyItems = []) {
  return {
    topComment,
    replies: replyItems,
  };
}

function looksLikeCommentListSuccess(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return false;
  }
  if (parsed.base_resp && Number(parsed.base_resp.ret) !== 0) {
    return false;
  }
  return Boolean(
    parsed.comment_list_count
      || Array.isArray(parsed?.comment_list?.comment)
      || Array.isArray(parsed?.comment_list),
  );
}

async function fetchReplies(requestContext, token, commentId, comment, limit) {
  const replyMeta = comment?.new_reply || {};
  const maxReplyId = replyMeta.max_reply_id || replyMeta.max_id || comment?.reply?.reply_count || 0;
  const contentId = comment?.content_id;
  if (!contentId) {
    return null;
  }

  const response = await mpJsonRequest(requestContext, buildReplyUrl({
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

async function runWithConcurrency(items, limit, worker) {
  const size = Math.max(1, limit);
  const results = new Array(items.length);
  let cursor = 0;

  async function consume() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(size, items.length) }, () => consume());
  await Promise.all(workers);
  return results;
}

async function main() {
  const args = parseArgs(process.argv);
  const directCommentId = args["comment-id"] || process.env.WECHAT_COMMENT_ID;
  if (!directCommentId) {
    throw new Error("missing --comment-id");
  }

  const begin = toInt(args.begin, 0);
  const count = toInt(args.count, 20);
  const fetchAll = toBool(args["fetch-all"], false);
  const maxPages = toInt(args["max-pages"], 200);
  const filterType = toInt(args["filter-type"], 0);
  const day = toInt(args.day, 0);
  const type = toInt(args.type, 2);
  const maxId = toInt(args["max-id"], 0);
  const withReplies = toBool(args["with-replies"], true);
  const replyLimit = toInt(args["reply-limit"], 20);
  const replyConcurrency = toInt(args["reply-concurrency"], 12);
  const stateFileArg = args["state-file"] || "";
  const commentId = String(directCommentId);

  const { context, page, profileDir } = await launchPersistentContext({
    profileDir: args["profile-dir"],
    headless: toBool(args.headless, toBool(process.env.WECHAT_WORKER_HEADLESS, true)),
    timeoutMs: args["timeout-ms"] ? Number(args["timeout-ms"]) : undefined,
  });
  const stateFile = stateFileArg || `${profileDir}/mp_state.json`;

  try {
    const cachedState = readStateFile(stateFile);
    let token = typeof cachedState.token === "string" ? cachedState.token.trim() : "";
    let homeState = null;

    async function refreshToken() {
      homeState = await resolveMpHomeStateFast(context, page);
      const freshToken = homeState.token || "";
      if (freshToken) {
        writeStateFile(stateFile, {
          token: freshToken,
          updatedAt: Date.now(),
        });
      }
      return freshToken;
    }

    if (!token) {
      token = await refreshToken();
    }
    if (!token) {
      console.log(JSON.stringify({
        ok: false,
        needLogin: true,
        profileDir,
        url: homeState?.url || "",
        token: null,
        bodyPreview: homeState?.bodyPreview || "",
      }, null, 2));
      return;
    }

    async function collectComments(activeToken) {
      const fetchedComments = [];
      const pageInfos = [];
      let articleTitle = "";
      let commentListCount = null;
      let lastResponse = null;
      let firstParsed = null;
      const pageSize = Math.max(1, count);
      const pageStart = Math.max(0, begin);
      const seenTopCommentIds = new Set();

      for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        const currentBegin = fetchAll ? (pageStart + pageIndex * pageSize) : pageStart;
        const response = await mpJsonRequest(context.request, buildListCommentUrl({
          token: activeToken,
          commentId,
          begin: currentBegin,
          count: pageSize,
          filterType,
          day,
          type,
          maxId,
        }));
        lastResponse = response;

        const parsed = parseCommentListPayload(response.data);
        if (!firstParsed) {
          firstParsed = parsed;
        }
        if (!commentListCount) {
          commentListCount = parsed?.comment_list_count || null;
        }
        if (!articleTitle) {
          articleTitle = parsed?.comment_list?.title || parsed?.title || "";
        }
        const comments = Array.isArray(parsed?.comment_list?.comment)
          ? parsed.comment_list.comment
          : Array.isArray(parsed?.comment_list)
            ? parsed.comment_list
            : [];
        for (const comment of comments) {
          const id = comment?.id != null ? String(comment.id) : "";
          if (id && seenTopCommentIds.has(id)) {
            continue;
          }
          if (id) {
            seenTopCommentIds.add(id);
          }
          fetchedComments.push(comment);
        }

        pageInfos.push({
          begin: currentBegin,
          count: pageSize,
          status: response.status,
          size: comments.length,
        });

        if (!fetchAll) {
          break;
        }
        if (comments.length < pageSize) {
          break;
        }
        const totalCount = Number(parsed?.comment_list_count?.total_count || 0);
        if (totalCount > 0 && fetchedComments.length >= totalCount) {
          break;
        }
      }

      return {
        fetchedComments,
        pageInfos,
        articleTitle,
        commentListCount,
        lastResponse,
        firstParsed,
      };
    }

    let scanData = await collectComments(token);
    if (!looksLikeCommentListSuccess(scanData.firstParsed)) {
      const refreshedToken = await refreshToken();
      if (refreshedToken && refreshedToken !== token) {
        token = refreshedToken;
        scanData = await collectComments(token);
      }
    }
    if (!looksLikeCommentListSuccess(scanData.firstParsed)) {
      console.log(JSON.stringify({
        ok: false,
        needLogin: true,
        profileDir,
        token: null,
        bodyPreview: homeState?.bodyPreview || "",
      }, null, 2));
      return;
    }

    const {
      fetchedComments,
      pageInfos,
      articleTitle,
      commentListCount,
      lastResponse,
    } = scanData;

    const topComments = fetchedComments.map((comment) => normalizeTopComment(comment, articleTitle));
    const repliesByTopCommentId = new Map();
    if (withReplies) {
      await runWithConcurrency(
        fetchedComments.map((comment, index) => ({ comment, normalizedTopComment: topComments[index] })),
        replyConcurrency,
        async ({ comment, normalizedTopComment }) => {
          const replyData = await fetchReplies(context.request, token, commentId, comment, replyLimit);
          if (!replyData) {
            return;
          }
          const replyList = Array.isArray(replyData?.raw?.reply_list?.reply_list)
            ? replyData.raw.reply_list.reply_list
            : [];
          const normalizedReplies = replyList.map((reply) => normalizeReplyItem(reply, normalizedTopComment));
          repliesByTopCommentId.set(
            normalizedTopComment.commentId,
            normalizedReplies,
          );
        },
      );
    }

    const threads = topComments.map((topComment) => buildThread(
      topComment,
      repliesByTopCommentId.get(topComment.commentId) || [],
    ));
    console.log(JSON.stringify({
      ok: Boolean(lastResponse?.ok),
      profileDir,
      token,
      commentId: String(commentId),
      http: {
        status: lastResponse?.status ?? null,
        url: lastResponse?.url ?? "",
      },
      summary: {
        commentCount: fetchedComments.length,
        fetchAll,
        pagesFetched: pageInfos.length,
        withReplies,
        replyConcurrency: withReplies ? Math.max(1, replyConcurrency) : 0,
      },
      article: { title: articleTitle, commentId: String(commentId) },
      threads,
      raw: {
        comment_list_count: commentListCount,
        pages: pageInfos,
      },
      resolved: null,
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
