import { type ModelTable, rates, tiered } from "../rates"

/**
 * OpenCode Go's published per-Mtok list prices.
 *
 * Provenance: opencode.ai/v2/docs/console/go, the token price table, read 2026-11-06, with the ids
 * from `GET /inference/go/v1/models` that day. Blast radius: the attributed total for `opencode-go`
 * accounts. The plan is a flat fee, so these are an attribution, never a bill.
 *
 * DeepSeek's two models double during weekday peak hours (01:00–04:00 and 06:00–10:00 UTC). A row
 * has no clock, so they carry the off-peak card and under-report a peak request. Free models carry
 * no row: nothing to attribute. `gemini-4-argon` is a discount that ends 2026-11-30.
 */
export const OPENCODE_GO_MODELS: ModelTable = {
  "glm-5.3-flash": rates(0.15, 0.5, { read: 0.03 }),
  "glm-5.3": rates(1.4, 4.4, { read: 0.26 }),
  "glm-5.2": rates(1.4, 4.4, { read: 0.26 }),
  "kimi-k3.1-pro": rates(2, 10, { read: 0.2, write: 2 }),
  "kimi-k3": rates(3, 15, { read: 0.3, write: 3 }),
  "kimi-k2.7-code": rates(0.95, 4, { read: 0.19 }),
  "longcat-2.0": rates(0.3, 1.2, { read: 0.006 }),
  "step-5-preview": rates(1, 2.7, { read: 0.1 }),
  "mimo-v2.6-flash": rates(0.14, 0.28, { read: 0.0028 }),
  "mimo-v2.6-pro": rates(0.435, 0.87, { read: 0.003625 }),
  "minimax-m3.1-flash": rates(0.15, 0.6, { read: 0.015 }),
  "minimax-m3": tiered(rates(0.3, 1.2, { read: 0.06 }), 512_000, rates(0.6, 2.4, { read: 0.12 })),
  "muse-spark-1.3-contributor": rates(0.1, 0.2, { read: 0.002 }),
  "muse-spark-1.2-contributor": rates(0.1, 0.2, { read: 0.002 }),
  "qwen3.8-max": rates(2, 6, { read: 0.25, write: 2.5 }),
  "qwen3.8-flash": rates(0.15, 0.47, { read: 0.016, write: 0.2 }),
  "qwen3.7-plus": tiered(
    rates(0.4, 1.6, { read: 0.04, write: 0.5 }),
    256_000,
    rates(1.2, 4.8, { read: 0.12, write: 1.5 }),
  ),
  "deepseek-v4.1-flash": rates(0.15, 0.6, { read: 0.003 }),
  "deepseek-v4-pro": rates(0.66, 1.98, { read: 0.022 }),
  hy4: rates(0.834, 2.501, { read: 0.042 }),
  "hy4-preview": rates(0.834, 2.501, { read: 0.042 }),
  hy3: rates(0.14, 0.58, { read: 0.035 }),
  "grok-4.7": tiered(rates(2, 6, { read: 0.5 }), 200_000, rates(4, 12, { read: 1 })),
  "gpt-6-luna": tiered(
    rates(0.1, 0.5, { read: 0.01, write: 0.125 }),
    272_000,
    rates(0.2, 0.75, { read: 0.02, write: 0.25 }),
  ),
  "gpt-5.6-luna": tiered(
    rates(0.2, 1.2, { read: 0.02, write: 0.25 }),
    272_000,
    rates(0.4, 1.8, { read: 0.04, write: 0.5 }),
  ),
  "claude-haiku-5-5": tiered(
    rates(0.1, 0.5, { read: 0.01, write: 0.125 }),
    100_000,
    rates(0.5, 2.5, { read: 0.05, write: 0.625 }),
  ),
  "gemini-4-argon": rates(2, 10, { read: 0.1 }),
}
