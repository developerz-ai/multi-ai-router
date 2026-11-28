# `.dz/`

The developerz.ai maintainer bot's configuration for this repo. The platform owns the layout.

| Path | What |
|---|---|
| `maintainer/maintainer.yml` | the policy: what the bot triages, closes, reviews and merges. [Reference](https://developerz.ai/docs/maintainer-yml) |
| `schedules/` | what each `schedules:` checkup works from, read at `main`'s HEAD when it fires: `improve.md` (first and third Monday: upkeep), `release-due.md` (Monday release decision, the only regular slot; files the **Release due** issue), `free-providers.md` (weekly: research, benchmark and re-rank the free models) |
| `pipeline/agent-pipeline.json` | the agent pipeline's settings for this repo (it lived at the root as `.agent-pipeline.json`) |
