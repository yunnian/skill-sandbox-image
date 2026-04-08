#!/usr/bin/env node

const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const {
  parseArgs,
  readStateFile,
  toInt,
} = require("./common");

const execFileAsync = promisify(execFile);
const LOGIN_CHECK_SCRIPT = path.join(__dirname, "login_check.js");
const SAVE_DRAFT_SCRIPT = path.join(__dirname, "save_draft.js");
const DEFAULT_INTERVAL_SECONDS = 3;
const DEFAULT_TIMEOUT_SECONDS = 600;
const DEFAULT_CACHE_MAX_AGE_SECONDS = 120;

function isLoggedInState(state) {
  return Boolean(state && state.loggedIn && state.token);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractJson(text) {
  if (!text) {
    return null;
  }
  const trimmed = String(text).trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw error;
  }
}

function buildNodeArgs(optionMap) {
  const args = [];
  for (const [key, value] of Object.entries(optionMap)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    args.push(`--${key}`, String(value));
  }
  return args;
}

async function runNodeJson(scriptPath, optionMap) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      scriptPath,
      ...buildNodeArgs(optionMap),
    ], {
      maxBuffer: 10 * 1024 * 1024,
    });
    return extractJson(stdout) || extractJson(stderr) || {};
  } catch (error) {
    const stdout = error && typeof error.stdout === "string" ? error.stdout : "";
    const stderr = error && typeof error.stderr === "string" ? error.stderr : "";
    const parsed = extractJson(stdout) || extractJson(stderr);
    if (parsed) {
      return parsed;
    }
    throw error;
  }
}

async function runFastLoginCheck(profileDir, cacheMaxAgeSeconds) {
  return runNodeJson(LOGIN_CHECK_SCRIPT, {
    "profile-dir": profileDir,
    headless: "true",
    "wait-for-login": "false",
    fast: "true",
    "cache-max-age-seconds": String(cacheMaxAgeSeconds),
    "hold-open-seconds": "0",
  });
}

async function runSaveDraft(args, profileDir) {
  return runNodeJson(SAVE_DRAFT_SCRIPT, {
    "profile-dir": profileDir,
    headless: "true",
    "payload-file": args["payload-file"],
    "payload-wait-timeout-ms": args["payload-wait-timeout-ms"],
    "html-file": args["html-file"],
    title: args.title,
    author: args.author,
    "timeout-ms": args["timeout-ms"],
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const profileDir = args["profile-dir"];
  if (!profileDir) {
    throw new Error("missing --profile-dir");
  }

  const stateFile = args["state-file"] || path.join(path.resolve(profileDir), "mp_state.json");
  const intervalSeconds = Math.max(1, toInt(args["interval-seconds"], DEFAULT_INTERVAL_SECONDS));
  const timeoutSeconds = Math.max(1, toInt(args["timeout-seconds"], DEFAULT_TIMEOUT_SECONDS));
  const cacheMaxAgeSeconds = Math.max(0, toInt(args["cache-max-age-seconds"], DEFAULT_CACHE_MAX_AGE_SECONDS));

  let pollCount = 0;
  let lastKnownState = null;

  const initialCheck = await runFastLoginCheck(profileDir, cacheMaxAgeSeconds);
  if (isLoggedInState(initialCheck)) {
    const saveResult = await runSaveDraft(args, profileDir);
    console.log(JSON.stringify({
      ...saveResult,
      waitedForLogin: false,
      pollCount,
      profileDir,
    }, null, 2));
    return;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutSeconds * 1000) {
    pollCount += 1;
    const cachedState = readStateFile(stateFile);
    lastKnownState = cachedState && Object.keys(cachedState).length > 0 ? cachedState : lastKnownState;

    if (isLoggedInState(cachedState)) {
      const saveResult = await runSaveDraft(args, profileDir);
      if (!saveResult.needLogin) {
        console.log(JSON.stringify({
          ...saveResult,
          waitedForLogin: true,
          pollCount,
          profileDir,
        }, null, 2));
        return;
      }
      lastKnownState = {
        ...lastKnownState,
        saveDraftNeedLogin: true,
      };
    }

    await sleep(intervalSeconds * 1000);
  }

  console.log(JSON.stringify({
    ok: false,
    needLogin: true,
    waitedForLogin: true,
    timedOut: true,
    timeoutSeconds,
    pollCount,
    profileDir,
    stateFile,
    lastKnownState: lastKnownState || {},
    error: "waited for login but did not detect a usable公众号登录态",
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    needLogin: false,
    error: error && error.stack ? error.stack : String(error),
  }, null, 2));
  process.exit(1);
});
