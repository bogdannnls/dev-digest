# Insights — reviewer-core/

Engine-specific learnings. For cross-cutting things, see [../INSIGHTS.md](../INSIGHTS.md).

## Entry format

    ## YYYY-MM-DD — short title
    Context: what we were doing
    What we tried: approaches considered or attempted
    What worked: the approach that landed
    Why it matters: what to remember next time

Append-only in spirit.

---

## 2026-06-19 — OpenRouter pre-reserves credits against `max_tokens` (even under BYOK)
Context: reviewer agents failed with `402 This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 1578` against `openrouter/anthropic/claude-opus-4.7`. The user had BYOK (their own Anthropic key) attached to OpenRouter, so the BYOK should have routed billing to Anthropic — but the 402 still fired.
What we tried: assuming BYOK bypassed all OpenRouter billing checks; topping up the underlying Anthropic key; staring at the OpenRouter settings page confirming BYOK was "Always Use".
What worked: explicitly capping `max_tokens` at the adapter level. `OpenRouterProvider.completeStructured` previously sent `max_tokens` only when `req.maxTokens` was supplied; otherwise OpenRouter assumed the model's full output window (65,536 tokens for Opus 4.7) and pre-reserved credits equal to `max_tokens × output_price × 5%` (OpenRouter's surcharge) against the user's OpenRouter balance. Even with BYOK, the surcharge IS billed in OpenRouter credits — so a small OpenRouter balance trips the 402 before BYOK is ever consulted. Fix: default `req.maxTokens ?? 4096` and always forward the field. See `reviewer-core/src/llm/openrouter.ts:30` (`DEFAULT_MAX_TOKENS`).
Why it matters: BYOK doesn't mean "no OpenRouter billing"; it means "the underlying model call bills your provider key, but OpenRouter still bills its 5% surcharge in credits." The pre-reservation logic uses the maximum possible cost (i.e., `max_tokens × price`), not the actual completion length. Always cap `max_tokens` explicitly — it's both a sanity guardrail (reviews don't need 65k of output) and a way to keep small OpenRouter balances usable.
