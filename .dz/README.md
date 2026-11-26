# `.dz/`

The developerz.ai maintainer bot's configuration for this repo. The platform owns the layout.

| Path | What |
|---|---|
| `maintainer/maintainer.yml` | the policy: what the bot triages, closes, reviews and merges. [Reference](https://developerz.ai/docs/maintainer-yml) |
| `schedules/` | what each `schedules:` checkup works from, read at `main`'s HEAD when it fires: `health.md` (weekly: red `main`, stuck Dependabot, shipped-but-open issues, the human queue), `improve.md` (monthly upkeep), `release-due.md` (Monday release judgement, the only release slot), `security-release.md` (daily, a published high/critical advisory fix only), `free-providers.md` (weekly: research, benchmark and re-rank the free models) |
| `pipeline/agent-pipeline.json` | the agent pipeline's settings for this repo (it lived at the root as `.agent-pipeline.json`) |
