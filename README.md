# dsh-persona — persona memory

A DeepSeek Harness plugin that grows a **persona** out of conversation.

`dsh-memory-whale` remembers *what happened*. This one remembers *who I am becoming*.

- **Auto-capture** — every turn is recorded as an episode; the model does not have to call a tool.
- **Auto-distill** — every N episodes a background pass reads recent dialogue with your default model and extracts judgement, voice and attitude evidence. Facts are explicitly excluded.
- **Solid vs. fading** — a judgement that has been stated 3 times or verified twice becomes *solid* and stops decaying; everything else fades on a half-life and is **folded into "earlier" — never deleted**.
- **Append-only history** — the persona is derived from a signal log, not mutated in place. You can add a record or retract one; you cannot rewrite the past.
- **Prompt injection** — the persona card is registered as dynamic system-prompt context.
- **No numbers in the card** — she never sees her own scores. Show a model its scores and it will act the scores.

Zero dependencies: it does not import `@deepseek-ai/dsh-tools` (tools are registered with plain JSON Schema) and keeps working when `schemastery` is unavailable. So a **plain directory copy is a valid install**.

## Install

One command:

```powershell
cd F:\tool\deepseekworkspace\dsh-persona
node install.mjs --seed "F:\tool\deepseekworkspace\persona-dafeiyu.md" --name 大肥鱼
```

Then **close DSH and reopen it**. After that, run `persona_stats` in a new session to verify (`records` grows with conversation).

The installer does four things, all idempotent:

1. puts the package at `<profile>\node_modules\dsh-persona`
2. appends one row to `<profile>\cordis.patch.yml` (skipped if present)
3. records `link:` in `<profile>\package.json` dependencies (so a later pnpm pass will not prune it)
4. writes `<DSH_HOME>\persona\config.json` (skipped if present, unless `--force`)

```powershell
node install.mjs --dry-run            # show the plan only
node install.mjs --mode junction      # link instead of copy (plugin development)
node install.mjs --uninstall          # remove the plugin, keep the persona data
node install.mjs --uninstall --purge  # remove the persona data too
```

### Why not the panel or `dsh plugin add`

That path runs pnpm, and two things actually happened on this machine:

- **pnpm prunes every profile package that is not in `package.json`.** One run removed 74 packages, including the plugin-development guide `dsh-plugin-guide` (which carries the `dsh-plugin-dev` CLI).
- **It reported failure and left a half-installed state.** pnpm finished in 1 second (`+ dsh-persona link:...`), but the host waited 600 seconds, timed out with `pnpm printed nothing`, and never wrote `package.json` or the patch row.

This plugin has zero dependencies, so a directory copy is enough — no pnpm required.

### The one thing to know before installing

`@deepseek-ai/*` does **not** resolve from the profile on this machine (verified: `require.resolve('@deepseek-ai/dsh-tools')` from `desktop\node_modules` fails). Any plugin that imports it installs **silently dead** — no tools, no error on the panel. This plugin deliberately imports nothing from the host (see design debt #4).

### Verify

```
cordis_inspect_query  platform=host  provider=Tool     → persona_read plus five siblings
```

Tools present but no persona card → check `persona_stats`. Neither → wrong directory or wrong patch-row indentation. Fallback: reproduce in a headless profile; `apply()` failures are invisible in web.

### Making config changes take effect

The host reads `cordis.patch.yml` and `config.json` at **startup**; hot reload is unreliable (patch edits do not trigger it, module edits only sometimes). **Restart DSH** after changing configuration.

### Configuration

One entry point only: `<DSH_HOME>\persona\config.json` (the installer writes a default one). Do not add a `config:` block to `cordis.patch.yml` — when schemastery is unavailable this plugin's `Config` is `undefined`, so a row carrying config may be rejected outright.

## How it grows

```
dialogue ──session/event──► episodes.jsonl        (raw material, prunable)
                                   │
                          every N episodes + min interval
                                   ▼
                    distil (default model) — supplies only "how hard was
                    this evidence" and "new / confirm / refute"
                                   ▼
                    signals.jsonl                 (single source of truth, append-only)
                                   │  pure derivation
                                   │    · similar statements merge into one trait
                                   │    · 3 mentions / 2 verifications → solid, stops decaying
                                   │    · everything else decays → folded, not deleted
                                   │    · retract / unpin / human settings are appended records
                                   ▼
                    persona.json                  (derived cache; delete it and it recomputes identically)
                                   │
                    persona card ──system-prompt context──► every turn
```

## Tools

| Tool | Purpose |
|---|---|
| `persona_read` | show the current card (facts only, no numbers) |
| `persona_observe` | record one judgement |
| `persona_recall` | look back at things she said |
| `persona_reflect` | force a distillation pass now |
| `persona_correct` | pin / retract / rename (what she calls you) / set voice / set summary |
| `persona_stats` | plugin health (episode and signal counts, last distillation error) |

Receipts are machine-shaped on purpose: `[已记下]`, `[已撤回]`, `[没记下：这句是空的]`. Never a sentence she can copy, never a score — otherwise the model treats tool output as its own words.

## Config

Every key is a Schemastery field with a default; the full table is in [README-zh.md](README-zh.md#config--配置项). The ones you will touch: `personaName`, `seedPath`, `distillEvery`, `distillMinIntervalMs`, `distillProvider`/`distillModel`, `solidMentions`, `solidVerified`, `maxTraits`, `traitHalfLifeDays`, `maxInjectChars`.

## Files

Under `$DSH_HOME/persona/`:

- `signals.jsonl` — single source of truth, append-only.
- `episodes.jsonl` — raw dialogue episodes, prunable.
- `persona.json` — derived cache; deleting it recomputes the same result.
- `runtime.json` — plugin bookkeeping (distillation cursor, failure count).
- `config.json` — optional configuration entry point (use this for copy installs).
- `seed.md` — copy of the starting persona (`seedPath`); injected as a droppable "starting point" block.

## Design debts

Three ideas come from [ssamurias/dsh-fish](https://github.com/ssamurias/dsh-fish) (MIT) — ideas only, no code:
1. **Append-only history with a derived snapshot.** It treats `events.jsonl` as the only truth and rebuilds `state.json`; here that is `signals.jsonl` → `persona.json`.
2. **Never let her read her own numbers.** It enforces this at the code level and keeps the physical layer out of the prompt; here it lands in the card — no score ever appears, and the rules section does not teach her to read one.
3. **Tool receipts must not be quotable.** It hit the failure where a receipt became the model's own words; here every receipt is bracketed machine text.
4. **Do not import `@deepseek-ai/dsh-tools`; register tools with plain JSON Schema.** It was burned twice: with `link:` installs the package does not resolve (parameters reach the provider raw → `schema must be a JSON Schema of type: object`), while npm installs do resolve it (`defineTool` reads the root `type: 'object'` as a parameter named `type` → every tool fails to register). Not importing it removes the fork entirely.

Not taken: the Bilibili surface, the four-stage growth gates, the web observations deck. That is a full product; this is the persona layer only.

## Known limits

- Distillation costs tokens (one small model call per pass).
- Personas drift; solid thresholds, decay, and `persona_correct` are the countermeasures.
- The signal log never shrinks; `persona.json` stays a compact current view.
- Text blocks only; subagent and workflow child sessions are skipped.
- Episodes are plaintext on disk.
- `dsh-plugin-dev check` still reports `manifest-files` (no `lib`/`dist` build directory — plain JS with sources at the root, same as `dsh-memory-whale`) and wants five-language READMEs. Both only matter for npm publishing.

## Self-test

```powershell
node smoke.mjs              # pure logic + storage, 70 checks
node smoke.integration.mjs  # assembly: real apply() against a fake ctx, 63 checks
node smoke.install.mjs      # installer: install / re-install / uninstall in a temp DSH_HOME, 35 checks
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `distillFailures` keeps climbing | distillation model unreachable | read `lastError`; set `distillProvider`/`distillModel` explicitly |
| episodes grow, card does not | below `distillEvery`, or `distillEnabled=false` | lower the threshold, or run `persona_reflect` |
| card has nothing but "现在" | no signals yet | `persona_observe` once, or let one distillation pass run |
| card never reaches the prompt | `injectPersona=false` | check config |
| speech does not match the card | card truncated by `maxInjectChars` | raise the cap or lower `maxTraits` |
