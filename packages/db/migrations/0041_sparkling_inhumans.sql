-- `IF NOT EXISTS` added by hand, so replaying this file over a schema that has the value is a no-op.
ALTER TYPE "public"."provider_id" ADD VALUE IF NOT EXISTS 'opencode-go' BEFORE 'ollama';