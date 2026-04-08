#!/usr/bin/env node

const {
  detectLoginState,
  ensureMpHome,
  launchPersistentContext,
  parseArgs,
  readStateFile,
  resolveMpHomeStateFast,
  toBool,
  toInt,
  writeStateFile,
} = require("./common");

async function notifyLoginCallback(args, state) {
  const callbackUrl = args["callback-url"];
  const monitorId = args["monitor-id"];
  const sessionUuid = args["session-uuid"];
  if (!callbackUrl || !monitorId || !sessionUuid) {
    return;
  }

  const payload = {
    monitorId: Number(monitorId),
    sessionUuid: String(sessionUuid),
    loggedIn: Boolean(state && state.loggedIn),
    needLogin: Boolean(state && state.needLogin),
    lastError: null,
  };

  const response = await fetch(callbackUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`login callback failed: ${response.status}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const headless = toBool(args.headless, toBool(process.env.WECHAT_WORKER_HEADLESS, false));
  const waitForLogin = toBool(args["wait-for-login"], false);
  const fastMode = toBool(args.fast, false);
  const holdOpenSeconds = toInt(args["hold-open-seconds"], 0);
  const intervalSeconds = toInt(args["interval-seconds"], 3);
  const timeoutSeconds = toInt(args["timeout-seconds"], 900);
  const cacheMaxAgeSeconds = toInt(args["cache-max-age-seconds"], 600);
  const requestedProfileDir = args["profile-dir"] || process.env.WECHAT_WORKER_PROFILE_DIR || "";
  const stateFile = args["state-file"] || `${requestedProfileDir}/mp_state.json`;

  if (fastMode && !waitForLogin) {
    const cachedState = readStateFile(stateFile);
    const checkedAt = Number(cachedState.loginCheckedAt || cachedState.updatedAt || 0);
    const token = typeof cachedState.token === "string" ? cachedState.token.trim() : "";
    const cacheAgeMs = Math.max(0, cacheMaxAgeSeconds) * 1000;
    if (cachedState.loggedIn === true && token && checkedAt > 0 && (Date.now() - checkedAt) <= cacheAgeMs) {
      console.log(JSON.stringify({
        ok: true,
        profileDir: requestedProfileDir,
        waitForLogin,
        holdOpenSeconds,
        timeoutSeconds,
        loggedIn: true,
        needLogin: false,
        waitingForConfirm: Boolean(cachedState.waitingForConfirm),
        url: cachedState.loginUrl || "",
        title: cachedState.loginTitle || "",
        token,
        bodyPreview: cachedState.bodyPreview || "",
        fromCache: true,
      }, null, 2));
      return;
    }
  }

  const { context, page, profileDir } = await launchPersistentContext({
    profileDir: args["profile-dir"],
    headless,
    timeoutMs: args["timeout-ms"] ? Number(args["timeout-ms"]) : undefined,
  });

  try {
    let state;
    if (fastMode && !waitForLogin) {
      const fastState = await resolveMpHomeStateFast(context, page);
      const token = fastState.token || null;
      state = {
        loggedIn: Boolean(token),
        needLogin: !token,
        waitingForConfirm: false,
        url: fastState.url || "",
        title: "",
        token,
        bodyPreview: fastState.bodyPreview || "",
      };
    } else {
      await ensureMpHome(page);
      state = await detectLoginState(page);
    }
    const startedAt = Date.now();

    if (waitForLogin && !state.loggedIn) {
      while (Date.now() - startedAt < timeoutSeconds * 1000) {
        await page.waitForTimeout(Math.max(1, intervalSeconds) * 1000);
        state = await detectLoginState(page);
        if (state.loggedIn) {
          break;
        }
      }
    }

    writeStateFile(stateFile, {
      token: state.token || null,
      loginCheckedAt: Date.now(),
      loggedIn: Boolean(state.loggedIn),
      needLogin: Boolean(state.needLogin),
      waitingForConfirm: Boolean(state.waitingForConfirm),
      loginUrl: state.url || "",
      loginTitle: state.title || "",
      bodyPreview: state.bodyPreview || "",
    });

    if (state.loggedIn || state.needLogin) {
      try {
        await notifyLoginCallback(args, state);
      } catch (callbackError) {
        console.error(JSON.stringify({
          ok: false,
          callbackError: callbackError && callbackError.stack ? callbackError.stack : String(callbackError),
        }, null, 2));
      }
    }

    if (holdOpenSeconds > 0) {
      await page.waitForTimeout(holdOpenSeconds * 1000);
    }

    console.log(JSON.stringify({
      ok: state.loggedIn || !waitForLogin,
      profileDir,
      waitForLogin,
      holdOpenSeconds,
      timeoutSeconds,
      fastMode,
      ...state,
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
