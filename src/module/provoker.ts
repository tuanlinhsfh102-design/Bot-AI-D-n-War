/**
 * provoker.ts — Hệ thống câu cà khịa cho Bot Nguyễn Đình Dương
 *
 * Bot là dân war, thích gây sự, va chạm, cục tính, cà khịa đối phương.
 * Module này load các câu khiêu khích từ data/provoker_lines.txt (≈454 câu)
 * và pick random theo từng mood/đối tượng.
 *
 * - Pick random câu cà khịa
 * - Pick theo category (cay cú, rét, lú, quê, đú, nổ, gáy, sủa, ...)
 * - Pick theo độ "nóng" (mild / medium / spicy)
 * - Cache in-memory sau khi load lần đầu
 */
import fs from 'fs';
import path from 'path';

export type ProvokerLevel = 'mild' | 'medium' | 'spicy';

export interface ProvokerLine {
    text: string;
    level: ProvokerLevel;
    category: string;  // tentative: 'cay_cú' | 'rét' | 'lú' | 'quê' | 'đú' | 'nổ' | 'gáy' | 'sủa' | 'khịa' | 'khác'
}

let cachedLines: ProvokerLine[] | null = null;
const DATA_FILE = path.join(process.cwd(), 'data', 'provoker_lines.txt');

// ============================================================
// Heuristic classify: dựa vào keyword trong câu
// ============================================================
const CATEGORY_KEYWORDS: Array<{ category: string; level: ProvokerLevel; keywords: string[] }> = [
    { category: 'cay_cú', level: 'medium', keywords: ['cay', 'cú', 'tức', 'hèn', 'yếu'] },
    { category: 'rét', level: 'medium', keywords: ['rét', 'run', 'sợ', 'nhát', 'phèn', 'én'] },
    { category: 'lú', level: 'medium', keywords: ['lú', 'ngu', 'đần', 'óc', 'đĩ', 'cức', 'ngáo'] },
    { category: 'quê', level: 'medium', keywords: ['quê', 'phèn', 'nghèo'] },
    { category: 'nổ', level: 'medium', keywords: ['nổ', 'chém', 'bá', 'đánh', 'banh', 'tung'] },
    { category: 'gáy', level: 'medium', keywords: ['gáy', 'sủa', 'câm', 'hét', 'gào'] },
    { category: 'khịa', level: 'mild', keywords: ['khịa', 'trêu', 'đú', 'mặn', 'đanh'] },
    { category: 'khác', level: 'mild', keywords: [] },  // fallback
];

function classify(text: string): { category: string; level: ProvokerLevel } {
    const t = text.toLowerCase();

    // Xác định level trước
    const isSpicy = /(đĩ|điếm|cặc|lồn|fuck|dcm|đmm|đm mẹ|lồn mẹ)/i.test(t);
    const isMild = /^[^=]*=+\)?/.test(t) && !isSpicy;  // có "=)))" cười → nhẹ hơn

    // Xác định category theo keyword
    let category = 'khác';
    for (const rule of CATEGORY_KEYWORDS) {
        if (rule.keywords.some((kw) => t.includes(kw))) {
            category = rule.category;
            break;
        }
    }

    // Override level theo spicy detection
    let level: ProvokerLevel = 'medium';
    if (isSpicy) level = 'spicy';
    else if (isMild) level = 'mild';

    return { category, level };
}

// ============================================================
// Loader
// ============================================================
export function loadProvokerLines(): ProvokerLine[] {
    if (cachedLines) return cachedLines;
    if (!fs.existsSync(DATA_FILE)) {
        console.warn(`[Provoker] Không tìm thấy ${DATA_FILE} — trả empty list`);
        cachedLines = [];
        return cachedLines;
    }
    try {
        const raw = fs.readFileSync(DATA_FILE, 'utf-8');
        const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        cachedLines = lines.map((text) => {
            const { category, level } = classify(text);
            return { text, level, category };
        });
        console.log(`[Provoker] Loaded ${cachedLines.length} câu cà khịa từ ${path.basename(DATA_FILE)}`);
        return cachedLines;
    } catch (e) {
        console.warn('[Provoker] Load failed:', e);
        cachedLines = [];
        return cachedLines;
    }
}

// ============================================================
// Picker
// ============================================================
function pickRandom<T>(arr: T[]): T | null {
    if (!arr || arr.length === 0) return null;
    return arr[Math.floor(Math.random() * arr.length)];
}

export function randomProvokerLine(): string | null {
    const all = loadProvokerLines();
    const picked = pickRandom(all);
    return picked ? picked.text : null;
}

export function pickByLevel(level: ProvokerLevel): string | null {
    const all = loadProvokerLines().filter((l) => l.level === level);
    const picked = pickRandom(all);
    return picked ? picked.text : null;
}

export function pickByCategory(category: string): string | null {
    const all = loadProvokerLines().filter((l) => l.category === category);
    const picked = pickRandom(all);
    return picked ? picked.text : null;
}

export function listCategories(): string[] {
    const all = loadProvokerLines();
    const set = new Set(all.map((l) => l.category));
    return Array.from(set);
}

/**
 * Pick N câu cà khịa khác nhau (dùng khi muốn spam nhiều câu)
 */
export function pickMany(n: number, level?: ProvokerLevel): string[] {
    const all = loadProvokerLines();
    const pool = level ? all.filter((l) => l.level === level) : all;
    if (pool.length === 0) return [];
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(n, shuffled.length)).map((l) => l.text);
}

/**
 * Pick theo keyword trong câu của đối phương — trả câu cà khịa phù hợp "để chửi lại"
 * Ví dụ: đối phương nói "tức quá" → bot pick câu có "tức" để khịa ngược lại
 */
export function pickByKeywordMatch(userText: string): string | null {
    const all = loadProvokerLines();
    if (all.length === 0) return null;
    const t = (userText || '').toLowerCase();
    const matches = all.filter((l) => {
        const words = l.text.toLowerCase().split(/\s+/);
        return words.some((w) => w.length >= 3 && t.includes(w));
    });
    const picked = pickRandom(matches.length > 0 ? matches : all);
    return picked ? picked.text : null;
}
