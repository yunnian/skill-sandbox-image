# skill-sandbox-image v1.0.6

This directory builds a single sandbox image with:

- full `execd` source code under `./execd` (editable)
- runtime entrypoint: `execd` in foreground
- no built-in Jupyter server (shell/filesystem focused)
- single fixed version per language (no runtime version switching)
- built-in `agent-browser`
- built-in `playwright` Node package
- preloaded Chromium browser binaries under `/opt/playwright-browsers`
- preinstalled WeChat backend worker scripts under `/opt/kuxuan/wechat-worker`

## Layout

- `Dockerfile`: all-in-one image build and runtime startup logic
- `execd/`: copied from OpenSandbox `components/execd` and kept editable
- `wechat-worker/`: Node.js + Playwright scripts for WeChat backend automation

## Build

```bash
cd skill-sandbox-image
docker build -t skill-cn-beijing.cr.volces.com/skill/skill-sandbox-image:1.0.6 .
```

## Run

```bash
docker run --rm -it \
  -p 8080:8080 \
  -p 44772:44772 \
  -p 5900:5900 \
  -p 6080:6080 \
  skill-cn-beijing.cr.volces.com/skill/skill-sandbox-image:1.0.6
```

## Useful env vars

- `EXECD_PORT` (default: `44772`)
- `EXECD_LOG_LEVEL` (default: `6`)
- `EXECD_ACCESS_TOKEN` (optional)
- `KX_SANDBOX_IMAGE_VERSION` (default: `1.0.6`)
- `WECHAT_WORKER_HEADLESS` (default: `true`)
- `BROWSER_PROFILE_ROOT` (default: `/workspace/browser-data`)
- `WECHAT_WORKER_PROFILE_DIR` (default: `/workspace/browser-data/wechat-mp/draft-publisher/default`)

## Language versions

- Python: `3.12`
- Java: `21`
- Node.js: `22`
- Go: `1.25.5`

## Notes

- Without Jupyter, `execd` code-interpreting endpoints for notebook kernels are unavailable.
- Command execution, background command, and filesystem APIs remain available.
- The image already includes the `playwright` package. You do not need to run `npx playwright install` again.
- WeChat worker scripts are available at:
  - `/opt/kuxuan/wechat-worker/login_check.js`
  - `/opt/kuxuan/wechat-worker/scan_comments.js`

## Quick verification

```bash
docker run --rm --entrypoint bash \
  skill-cn-beijing.cr.volces.com/skill/skill-sandbox-image:1.0.6 -lc \
  'node /opt/kuxuan/wechat-worker/login_check.js --headless=true'
```
