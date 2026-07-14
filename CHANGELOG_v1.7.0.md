# CHANGELOG v1.7.0 — Switch từ Gemini sang OpenCode Zen API

> Thay toàn bộ AI text generation từ Google Gemini sang **OpenCode Zen API** (https://opencode.ai/docs/zen/).
> Default model: `deepseek-v4-flash-free` (FREE — limited time).
> Voice TTS vẫn dùng Gemini (Zen chỉ là text-to-text).

---

## 🎯 Tổng quan

| Trước (v1.6.2) | Sau (v1.7.0) |
|---|---|
| Main AI: Gemini (`gemini-3.1-flash-lite`) | Main AI: Zen (`deepseek-v4-flash-free`) |
| Provider: `@ai-sdk/google` | Provider: `@ai-sdk/openai-compatible` |
| Endpoint: Google AI Studio | Endpoint: `https://opencode.ai/zen/v1/chat/completions` |
| API key: `GOOGLE_GENERATIVE_AI_API_KEY` | API key: `OPENCODE_ZEN_API_KEY` |
| Cấu hình `providerOptions.google.*` (safetySettings, thinkingConfig) | Bỏ (OpenAI-compatible không dùng) |
| Voice TTS: Gemini | Voice TTS: Gemini (giữ nguyên — Zen không có TTS) |

---

## ✨ Lợi ích

1. **FREE**: `deepseek-v4-flash-free` miễn phí (limited time). Cũng có `MiMo-V2.5 Free`, `North Mini Code Free`, `Nemotron 3 Ultra Free`, `Big Pickle` free.
2. **Multi-model**: 1 API key truy cập 50+ model (DeepSeek, GLM, Kimi, Claude, GPT, Gemini, Qwen, MiniMax, Grok...)
3. **OpenAI-compatible**: chuẩn OpenAI API → dễ swap model mà không sửa code
4. **Smart Key Rotation**: giữ nguyên cơ chế rotate key khi 429/quota/401

---

## 📦 Files changed

### Source code (8 files)
- `src/module/apikey.ts` — Thêm service `zen`, helpers `withZenModel` + `streamWithZenModel` + `ZEN_DEFAULT_MODEL`
- `src/module/env.ts` — Validate `OPENCODE_ZEN_API_KEY` (BẮT BUỘC), Gemini key xuống thành TUỲ CHỌN
- `src/module/ai.ts` — `streamWithGoogleModel('gemini-3.1-flash-lite')` → `streamWithZenModel(ZEN_DEFAULT_MODEL)`
- `src/module/AiTool.ts` — RoastPerson: `withGoogleModel` → `withZenModel`; admin tools thêm service `zen`
- `src/module/tool.ts` — aiImageToText, aiVideoToText, summarizeTalkEntriesAI: switch sang Zen
- `src/module/tool/memory.ts` — summarizeNotesAI: switch sang Zen
- `src/module/tool/enemyFace.ts` — face-check: switch sang Zen
- `src/module/proactive.ts` — generateProvokerMessage: switch sang Zen
- `src/module/voice.ts` — TTS vẫn Gemini, nhưng check key + throw error rõ ràng nếu thiếu
- `src/module/keystore_server.ts` — Web UI: thêm option `zen`, default service = `zen`

### Config
- `package.json` — Thêm `@ai-sdk/openai-compatible@^1.0.42` (compatible với `ai@5.x`/LanguageModelV2)
- `.env.example` — Tạo mới, hướng dẫn đầy đủ cho Zen + Gemini + Brave + MongoDB + admin

---

## 🔧 Cách migrate

### 1. Lấy Zen API key
- Truy cập: https://opencode.ai/zen
- Sign in → Add billing details (có free credit)
- Copy API key

### 2. Cấu hình .env
```bash
# BẮT BUỘC:
OPENCODE_ZEN_API_KEY=zen_xxx...your_key

# TUỲ CHỌN (chỉ cần cho voice TTS):
# GOOGLE_GENERATIVE_AI_API_KEY=AIza...your_gemini_key
```

### 3. (Tuỳ chọn) Đổi model
Mặc định là `deepseek-v4-flash-free` (FREE). Có thể đổi sang:
```bash
# Models FREE:
OPENCODE_ZEN_MODEL=deepseek-v4-flash-free      # default
# OPENCODE_ZEN_MODEL=mimo-v2.5-free
# OPENCODE_ZEN_MODEL=north-mini-code-free
# OPENCODE_ZEN_MODEL=nemotron-3-ultra-free
# OPENCODE_ZEN_MODEL=big-pickle

# Models trả phí (cần billing):
# OPENCODE_ZEN_MODEL=glm-5.2              # $1.40/$4.40 per 1M tokens
# OPENCODE_ZEN_MODEL=kimi-k2.7-code       # $0.95/$4.00
# OPENCODE_ZEN_MODEL=claude-sonnet-5      # $2.00/$10.00
# OPENCODE_ZEN_MODEL=gpt-5.4              # $2.50/$15.00
# OPENCODE_ZEN_MODEL=gemini-3.5-flash     # $1.50/$9.00
```

Full pricing: https://opencode.ai/docs/zen/

### 4. (Tuỳ chọn) Nhiều key (rotation)
```bash
OPENCODE_ZEN_API_KEYS=zen_key1,zen_key2,zen_key3
# Hoặc drop vào: data/api_keys/zen.txt (HOT-RELOAD — không cần restart)
```

---

## ⚠️ Breaking changes

1. **`OPENCODE_ZEN_API_KEY` là BẮT BUỘC** (trước đó là `GOOGLE_GENERATIVE_AI_API_KEY`)
2. **`GOOGLE_GENERATIVE_AI_API_KEY` xuống thành TUỲ CHỌN** — chỉ cần cho voice TTS
3. **`providerOptions.google.*` bị bỏ** ở tất cả `generateText` / `streamText` calls — OpenAI-compatible không dùng safetySettings/thinkingConfig
4. **Tool admin `ListApiKeys`/`AddApiKey`/`RemoveApiKey`/`ReviveApiKey`** thêm service `zen` vào enum

---

## 🧪 Compatibility

- `ai@5.0.210` (LanguageModelV2) ✓
- `@ai-sdk/openai-compatible@1.0.42` (LanguageModelV2 — compatible với ai 5.x) ✓
- `@ai-sdk/google@2.0.8` (giữ nguyên cho TTS) ✓
- `@google/genai@1.15.0` (giữ nguyên cho TTS) ✓

---

## 📚 Tham khảo
- Zen docs: https://opencode.ai/docs/zen/
- Zen models + pricing: https://opencode.ai/docs/zen/#models
- @ai-sdk/openai-compatible: https://ai-sdk.dev/providers/community-providers/openai-compatible
