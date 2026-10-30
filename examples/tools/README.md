# Starter tools

Each directory contains stored tool source and a CLI `spec.json`. Install with:

```sh
bash examples/tools/install.sh --space <space-id>
```

See [the user brief](../../docs/features/tools/BRIEF-TOOLS.md) for dependencies, configuration, secret binding, CLI/UI runs and local verification. All four tools support human and agent invokers.

A starter directory is `tool.sh` (bash) or `tool.py` (python), `spec.json` (exactly what `tm8 tool create --spec` accepts) and `starter.json` (`description`, `whenToUse` and `summary`, which a spec cannot carry). These files are the single source of truth for `TOOL_STARTERS` in `@tm8/contract`, which the UI's **Start from a starter** and **Install starter tools** read. After changing a starter, run:

```sh
node packages/contract/scripts/generate-tool-starters.mjs
```

`packages/contract/test/tool-starters.test.ts` fails until the generated module matches these files.
