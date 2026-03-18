#!/usr/bin/env node

const {
  detectLoginState,
  ensureMpHome,
  launchPersistentContext,
  parseArgs,
  toBool,
  toInt,
} = require("./common");

async function main() {
  const args = parseArgs(process.argv);
  const waitForLogin = toBool(args["wait-for-login"], false);
  const holdOpenSeconds = toInt(args["hold-open-seconds"], 0);
  const intervalSeconds = toInt(args["interval-seconds"], 3);
  const timeoutSeconds = toInt(args["timeout-seconds"], 900);
  const { context, page, profileDir } = await launchPersistentContext({
    profileDir: args["profile-dir"],
    headless: toBool(args.headless, toBool(process.env.WECHAT_WORKER_HEADLESS, false)),
    timeoutMs: args["timeout-ms"] ? Number(args["timeout-ms"]) : undefined,
  });

  try {
    await ensureMpHome(page);
    let state = await detectLoginState(page);
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

    if (holdOpenSeconds > 0) {
      await page.waitForTimeout(holdOpenSeconds * 1000);
    }

    console.log(JSON.stringify({
      ok: state.loggedIn || !waitForLogin,
      profileDir,
      waitForLogin,
      holdOpenSeconds,
      timeoutSeconds,
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
