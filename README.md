# skills-image all-in-one sandbox

This directory builds a single sandbox image with:

- full `execd` source code under `./execd` (editable)
- runtime entrypoint: `execd` in foreground
- no built-in Jupyter server (shell/filesystem focused)
- single fixed version per language (no runtime version switching)

## Layout

- `Dockerfile`: all-in-one image build and runtime startup logic
- `execd/`: copied from OpenSandbox `components/execd` and kept editable

## Build

```bash
cd skills-image
docker build -t local/skills-image:latest .
```

## Run

```bash
docker run --rm -it \
  -p 44772:44772 \
  local/skills-image:latest
```

## Useful env vars

- `EXECD_PORT` (default: `44772`)
- `EXECD_LOG_LEVEL` (default: `6`)
- `EXECD_ACCESS_TOKEN` (optional)

## Language versions

- Python: `3.12`
- Java: `21`
- Node.js: `22`
- Go: `1.25.5`

## Notes

- Without Jupyter, `execd` code-interpreting endpoints for notebook kernels are unavailable.
- Command execution, background command, and filesystem APIs remain available.
