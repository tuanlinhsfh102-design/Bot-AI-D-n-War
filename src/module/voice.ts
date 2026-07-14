import { GoogleGenAI } from '@google/genai';
import mime from 'mime';
import { ThreadType } from 'zca-js';
import type { EmotionState } from './emotion';
import { EMOTION_VOICE_MAP } from './emotion';
import { streamWithGoogleGenAI } from './apikey';

/**
 * voice.ts — Text-to-Speech cho Bot Nguyễn Đình Dương
 *
 * Persona Nguyễn Đình Dương: nam, gắt gao, bá đạo, hay khịa, sẵn sàng chửi.
 * Đa voice theo mood:
 *   - neutral/chill → Orus (nam nhẹ, bình tĩnh)
 *   - cocky/savage/triumphant/annoyed → Charon (nam trầm, ác, bá đạo)
 *   - triggered/aggressive → Fenrir (nam gắt, lớn giọng)
 *   - hyped/petty → Puck (nam cao, phấn khích)
 *   - bored → Aoede (nam chậm, chán)
 *
 * Pipeline:
 *   1. Sinh audio bằng Gemini 3.1 Flash TTS Preview
 *   2. Nếu raw PCM → convert sang WAV
 *   3. Upload lên tmpfiles.org → nhận public URL
 *   4. Gửi voice qua Zalo API:
 *      sendVoice(options: {voiceUrl, ttl?}, threadId, type?: ThreadType)
 *      type mặc định = ThreadType.User (chat riêng)
 */

const DEFAULT_VOICE = 'Orus';

function pickVoice(emotion?: EmotionState): string {
    if (!emotion) return DEFAULT_VOICE;
    return EMOTION_VOICE_MAP[emotion] ?? DEFAULT_VOICE;
}

interface TtsOptions {
    text: string;
    emotion?: EmotionState;
    voiceName?: string; // override nếu cần
    // style instructions để điều khiển cảm xúc qua text prompt style
    styleHint?: string;
}

export async function ttsToTmpfiles(opts: TtsOptions | string): Promise<{ url: string; filename: string; voice: string }> {
    // Cho phép gọi cũ: ttsToTmpfiles(text)
    const o: TtsOptions = typeof opts === 'string' ? { text: opts } : opts;
    const text = o.text;
    const voiceName = o.voiceName ?? pickVoice(o.emotion);

    // ⭐ v1.7.0 — Voice TTS vẫn dùng Gemini (Zen chỉ là text-to-text, không có TTS).
    // Nếu không có Gemini key → throw error có ý nghĩa để caller skip voice.
    const geminiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
    if (!geminiKey) {
        throw new Error('TTS skipped: chưa cấu hình Gemini API key (OPENCODE_ZEN không hỗ trợ TTS). Set GOOGLE_GENERATIVE_AI_API_KEY trong .env để dùng voice.');
    }

    // Style hint injected vào prompt để điều khiển cảm xúc qua giọng đọc
    const styleInstruction = o.styleHint ?? STYLE_HINT_BY_EMOTION[o.emotion ?? 'neutral'] ?? '';

    // Style instructions chỉ hoạt động qua prompt text, không qua voiceName
    const finalText = styleInstruction ? `${styleInstruction}\n\n${text}` : text;

    const config = {
        temperature: 1,
        responseModalities: ['audio'] as const,
        speechConfig: {
            voiceConfig: {
                prebuiltVoiceConfig: {
                    voiceName,
                },
            },
        },
    } as const;

    // Model TTS chuyên dụng (text-to-speech) của Gemini 3.1.
    const model = 'gemini-3.1-flash-tts-preview';
    const contents = [
        {
            role: 'user',
            parts: [{ text: finalText }],
        },
    ];

    // SMART KEY: dùng streamWithGoogleGenAI để rotate key tự động nếu 429/401
    //
    // ⚠️ FIX LAZY STREAM BUG:
    // generateContentStream() trả về stream object, HTTP request chỉ xảy ra khi
    // consume stream. Nếu consume NGOÀI withGoogleGenAI → 429 lỗi KHÔNG bị bắt
    // → KHÔNG rotate key. Giải pháp: consume INSIDE wrapper (streamWithGoogleGenAI).
    const base64Parts: string[] = [];
    let mimeType: string | undefined;

    await streamWithGoogleGenAI(
        (ai, _apiKey, meta) => {
            console.log(`[Voice] TTS using key ${meta.fingerprint} (attempt ${meta.attempt}/${meta.total})`);
            return (ai.models as any).generateContentStream({
                model,
                config,
                contents,
            });
        },
        async (response) => {
            // ⚠️ Consume INSIDE wrapper — nếu 429/quota xảy ra ở đây,
            // error sẽ được withServiceApiKey bắt → rotate sang key khác.
            // ⚠️ FIX v1.5.11 — Defensive: response có thể là Promise<AsyncIterable> nếu
            // streamWithGoogleGenAI chưa await. Đảm bảo resolved trước khi iterate.
            const resolved = (response as any)?.then ? await (response as any) : response;
            for await (const chunk of resolved as any) {
                const inline = chunk?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
                if (inline?.data) {
                    base64Parts.push(inline.data);
                    mimeType = inline.mimeType || mimeType;
                }
            }
        },
    );

    if (base64Parts.length === 0) {
        throw new Error('TTS generation produced no audio data');
    }

    const base64Joined = base64Parts.join('');
    let buffer = Buffer.from(base64Joined, 'base64');
    let ext = mime.getExtension(mimeType || '') || '';

    if (!ext) {
        buffer = convertToWav(base64Joined, mimeType || '');
        ext = 'wav';
        mimeType = 'audio/wav';
    }

    const filename = `voice_${Date.now()}_${voiceName}.${ext}`;

    // Upload to tmpfiles.org
    const form = new FormData();
    const blob = new Blob([buffer], { type: mimeType || 'audio/wav' });
    form.append('file', blob, filename);

    const uploadRes = await fetch('https://tmpfiles.org/api/v1/upload', {
        method: 'POST',
        body: form as any,
    });
    if (!uploadRes.ok) {
        const textBody = await uploadRes.text().catch(() => '');
        throw new Error(`Upload failed: ${uploadRes.status} ${uploadRes.statusText} - ${textBody}`);
    }
    const uploadJson: any = await uploadRes.json().catch(() => ({}));
    const url: string | undefined = uploadJson?.data?.raw_url || uploadJson?.data?.url || uploadJson?.url;
    if (!url) throw new Error('Upload succeeded but no URL returned');

    const downloadUrl = url.replace(/tmpfiles\.org\//, 'tmpfiles.org/dl/');

    return { url: downloadUrl, filename, voice: voiceName };
}

/**
 * Gửi voice cho Nguyễn Đình Dương, tự động chọn voice theo emotion.
 */
export async function sendVoiceFromText(
    text: string,
    threadId: string,
    options?: { emotion?: EmotionState; threadType?: 'User' | 'Group' },
): Promise<string> {
    const { url } = await ttsToTmpfiles({ text, emotion: options?.emotion });
    const threadType = options?.threadType === 'Group' ? ThreadType.Group : ThreadType.User;
    console.log('[Voice] sending voice', url, 'emotion:', options?.emotion ?? 'neutral', 'threadType:', threadType);
    // zca-js sendVoice signature: sendVoice(options: {voiceUrl, ttl?}, threadId, type?: ThreadType)
    await global.api.sendVoice({ voiceUrl: url }, threadId, threadType);
    return url;
}

// ============================================================
// Style hints — điều khiển cảm xúc giọng đọc qua prompt (Nguyễn Đình Dương)
// ============================================================
const STYLE_HINT_BY_EMOTION: Record<EmotionState, string> = {
    neutral:    'Hãy đọc với giọng nam trẻ, bình tĩnh, tự tin, hơi bá đạo nhẹ.',
    cocky:      'Hãy đọc với giọng nam trẻ, kiêu ngạo, tự tin thái quá, bá đạo, hơi mỉa mai.',
    triggered:  'Hãy đọc với giọng nam trẻ, tức giận, gắt, lớn giọng, cộc lốc, sắp chửi.',
    aggressive: 'Hãy đọc với giọng nam trẻ, hung hăng, lớn giọng, gắt, sẵn sàng đánh.',
    hyped:      'Hãy đọc với giọng nam trẻ, phấn khích, vui, nhanh, năng lượng cao, hay cười nhạt.',
    bored:      'Hãy đọc với giọng nam trẻ, chán, chậm, thở dài, nhạt.',
    savage:     'Hãy đọc với giọng nam trẻ, ác miệng, sắc, mỉa mai, cắn không trượt, lạnh lùng.',
    petty:      'Hãy đọc với giọng nam trẻ, cục cằn, soi mói, hơi bực, ngắn.',
    annoyed:    'Hãy đọc với giọng nam trẻ, khó chịu nhẹ, hơi thở dài, ngắn.',
    triumphant: 'Hãy đọc với giọng nam trẻ, hả hê, vui, bá đạo, "thua chưa".',
    chill:      'Hãy đọc với giọng nam trẻ, mát mẻ, bình tĩnh, chậm, hơi cười nhẹ.',
};

// ============================================================
// WAV conversion helpers (raw PCM → WAV)
// ============================================================
interface WavConversionOptions {
    numChannels: number;
    sampleRate: number;
    bitsPerSample: number;
}

function convertToWav(rawDataBase64: string, mimeType: string) {
    const options = parseMimeType(mimeType);
    const wavHeader = createWavHeader(Buffer.byteLength(rawDataBase64, 'base64'), options);
    const buffer = Buffer.from(rawDataBase64, 'base64');
    return Buffer.concat([wavHeader, buffer]);
}

function parseMimeType(mimeType: string) {
    const [fileType, ...params] = mimeType.split(';').map((s) => s.trim());
    const [, format] = (fileType || '').split('/');

    const options: Partial<WavConversionOptions> = {
        numChannels: 1,
        sampleRate: 24000,
        bitsPerSample: 16,
    };

    if (format && format.startsWith('L')) {
        const bits = parseInt(format.slice(1), 10);
        if (!isNaN(bits)) options.bitsPerSample = bits;
    }
    for (const param of params) {
        const [key, value] = param.split('=').map((s) => s.trim());
        if (key === 'rate') options.sampleRate = parseInt(value, 10);
        if (key === 'channels') options.numChannels = parseInt(value, 10);
    }

    return options as WavConversionOptions;
}

function createWavHeader(dataLength: number, options: WavConversionOptions) {
    const { numChannels, sampleRate, bitsPerSample } = options;
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const buffer = Buffer.alloc(44);

    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataLength, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataLength, 40);

    return buffer;
}
