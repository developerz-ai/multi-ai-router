import { defineConfig } from "drizzle-kit"

// drizzle-kit is a developer tool: it generates SQL into ./migrations, which is
// committed. It never runs in the container — the router applies the committed
// files at boot (src/migrate.ts, docs/idea/09-deployment.md).
// `generate` and `check` only read ./src/schema — they never open a connection,
// so demanding a live DATABASE_URL for them breaks `bun run db:generate` on a
// machine (or a CI job) with no database, which is exactly where migrations get
// authored. Only the connecting commands (`push`, `studio`) need real
// credentials, and those fail with their own clear connection error if this
// placeholder is left in place.
const url = process.env.DATABASE_URL ?? "postgres://generate-only@localhost:5432/unused"

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: { url },
  strict: true,
  verbose: true,
})
