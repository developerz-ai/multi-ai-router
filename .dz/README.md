# `.dz/`

The developerz.ai maintainer bot's configuration for this repo. The platform owns the layout.

| Path | What |
|---|---|
| `maintainer/maintainer.yml` | the policy: what the bot triages, closes, reviews and merges. [Reference](https://developerz.ai/docs/maintainer-yml) |
| `briefs/` | what each `schedules:` checkup works from, read at `main`'s HEAD when it fires: `health.md` (weekly: red `main`, stuck Dependabot, shipped-but-open issues, the human queue), `improve.md` (monthly upkeep), `release-due.md` (weekly release judgement), `security-release.md` (daily, a confirmed security fix only) |
