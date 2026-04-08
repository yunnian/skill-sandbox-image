#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const {
  ensureMpHome,
  launchPersistentContext,
  parseArgs,
  toBool,
  toInt,
} = require("./common");

function isInterestingUrl(url) {
  if (!url || typeof url !== "string") {
    return false;
  }
  if (!url.includes("mp.weixin.qq.com")) {
    return false;
  }
  return /comment|reply|appmsg/i.test(url);
}

function appendJsonLine(filePath, payload) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.appendFileSync(resolved, `${JSON.stringify(payload)}\n`, "utf8");
}

async function main() {
  const args = parseArgs(process.argv);
  const holdOpenSeconds = toInt(args["hold-open-seconds"], 1800);
  const logFile = args["log-file"] || "/workspace/system/wechat-comment-monitor/reply_capture.log";
  const { context, page, profileDir } = await launchPersistentContext({
    profileDir: args["profile-dir"],
    headless: toBool(args.headless, false),
    timeoutMs: args["timeout-ms"] ? Number(args["timeout-ms"]) : undefined,
  });

  const requestIds = new WeakMap();
  let seq = 1;

  context.on("request", (request) => {
    if (!isInterestingUrl(request.url())) {
      return;
    }
    const id = seq++;
    requestIds.set(request, id);
    appendJsonLine(logFile, {
      type: "request",
      id,
      ts: Date.now(),
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      postData: request.postData() || "",
      headers: request.headers(),
    });
  });

  context.on("response", async (response) => {
    const request = response.request();
    if (!isInterestingUrl(request.url())) {
      return;
    }
    const id = requestIds.get(request) || seq++;
    let body = "";
    try {
      body = await response.text();
    } catch (error) {
      body = `[unreadable:${String(error)}]`;
    }
    appendJsonLine(logFile, {
      type: "response",
      id,
      ts: Date.now(),
      status: response.status(),
      url: response.url(),
      body,
    });
  });

  context.on("requestfailed", (request) => {
    if (!isInterestingUrl(request.url())) {
      return;
    }
    const id = requestIds.get(request) || seq++;
    appendJsonLine(logFile, {
      type: "requestfailed",
      id,
      ts: Date.now(),
      method: request.method(),
      url: request.url(),
      failure: request.failure(),
    });
  });

  try {
    await ensureMpHome(page);
    appendJsonLine(logFile, {
      type: "session",
      ts: Date.now(),
      event: "capture_started",
      profileDir,
      holdOpenSeconds,
      pageUrl: page.url(),
    });

    if (holdOpenSeconds > 0) {
      await page.waitForTimeout(holdOpenSeconds * 1000);
    }
  } finally {
    appendJsonLine(logFile, {
      type: "session",
      ts: Date.now(),
      event: "capture_closed",
      profileDir,
    });
    await context.close();
  }
}

main().catch((error) => {
  const logFile = parseArgs(process.argv)["log-file"] || "/workspace/system/wechat-comment-monitor/reply_capture.log";
  appendJsonLine(logFile, {
    type: "error",
    ts: Date.now(),
    error: error && error.stack ? error.stack : String(error),
  });
  process.exit(1);
});
