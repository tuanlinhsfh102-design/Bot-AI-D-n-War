import { tool, ToolSet, generateText } from "ai";
import z from "zod";
import fs from "fs";
import path from "path";
// ⭐ v1.7.0 — Switch sang OpenCode Zen API.
import { withZenModel, ZEN_DEFAULT_MODEL } from "../apikey";

const memoryFilePath = path.join(process.cwd(), "data", "memory.json");

// Typed structure of memory.json
export type MemoryFile = {
    is_update: boolean;
    summarize: string;
    memory: string[];
};

const MAX_MEMORY_ITEMS = 40;
const KEEP_RECENT_MEMORY_ITEMS = 16;
const MAX_MEMORY_NOTE_LENGTH = 400;

function normalizeNote(input: string): string {
    return String(input ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_MEMORY_NOTE_LENGTH);
}

function dedupeNotes(notes: string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const note of notes) {
        const normalized = normalizeNote(note);
        if (!normalized) continue;
        const key = normalized.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(normalized);
    }
    return out;
}

function ensureMemoryFile(): void {
    const dir = path.dirname(memoryFilePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(memoryFilePath)) {
        const initial: MemoryFile = { is_update: false, summarize: "", memory: [] };
        fs.writeFileSync(memoryFilePath, JSON.stringify(initial, null, 2));
    }
}

function loadMemoryObj(): MemoryFile {
    ensureMemoryFile();
    try {
        const raw = fs.readFileSync(memoryFilePath, "utf-8");
        const obj = JSON.parse(raw);
        if (typeof obj === 'object' && Array.isArray((obj as any).memory)) {
            return {
                is_update: !!(obj as any).is_update,
                summarize: typeof (obj as any).summarize === 'string' ? (obj as any).summarize : '',
                memory: (obj as any).memory as string[],
            };
        }
        // fallback if file is array (old format)
        return { is_update: false, summarize: '', memory: Array.isArray(obj) ? (obj as string[]) : [] };
    } catch (e) {
        return { is_update: false, summarize: '', memory: [] };
    }
}

function saveMemoryObj(obj: MemoryFile): void {
    ensureMemoryFile();
    fs.writeFileSync(memoryFilePath, JSON.stringify(obj, null, 2));
}

async function summarizeNotesAI(notes: string[]): Promise<string> {
    if (notes.length === 0) return "Không có ghi chú nào.";
    try {
        const convo = notes.map((n, i) => `- [${i + 1}] ${n}`).join('\n');
        const { text } = await withZenModel(ZEN_DEFAULT_MODEL, async (model) => {
            return generateText({
                model,
                prompt:
                    `Tóm tắt ngắn gọn bằng tiếng Việt các ghi chú dưới đây, giữ lại các ý chính và thông tin quan trọng để tiếp tục tương tác với người dùng. ` +
                    `Trả về ở dạng 5-10 gạch đầu dòng, ngắn gọn, rõ ràng, không quá 800 ký tự. KHÔNG đặt trong code block.\n\n` +
                    `Ghi chú:\n${convo}`,
                // ⚠️ v1.7.0 — OpenAI-compatible không dùng `google.*` providerOptions.
            });
        });
        return String(text ?? '').trim();
    } catch (e) {
        console.warn('AI summarization failed, falling back to simple summary:', e);
        // fallback
        if (notes.length <= 3) return `Tóm tắt (${notes.length}): ${notes.join("; ")}`;
        const first = notes.slice(0, 3).join("; ");
        return `Tóm tắt: Có ${notes.length} ghi chú. Các ý chính: ${first}...`;
    }
}

async function compactMemoryIfNeeded(obj: MemoryFile): Promise<MemoryFile> {
    obj.memory = dedupeNotes(obj.memory);
    if (obj.memory.length <= MAX_MEMORY_ITEMS) {
        return obj;
    }

    const older = obj.memory.slice(0, obj.memory.length - KEEP_RECENT_MEMORY_ITEMS);
    const recent = obj.memory.slice(-KEEP_RECENT_MEMORY_ITEMS);
    const summaryInput = obj.summarize?.trim()
        ? [`Tóm tắt trước đó: ${obj.summarize}`, ...older]
        : older;

    obj.summarize = await summarizeNotesAI(summaryInput);
    obj.memory = recent;
    obj.is_update = false;
    return obj;
}

export const memoryTools: ToolSet = {
    saveNote: tool({
        description: "Lưu một ghi chú vào bộ nhớ.",
        inputSchema: z.object({
            input: z.string().describe("Nội dung ghi chú"),
        }),
        async execute(opts: any) {
            const input = normalizeNote(opts?.input ?? '');
            if (!input) return 'Không có ghi chú hợp lệ để lưu.';
            const obj = loadMemoryObj();
            obj.memory.push(input);
            obj.is_update = true;
            await compactMemoryIfNeeded(obj);
            saveMemoryObj(obj);
            return `Đã lưu ghi chú: "${input}"`;
        },
    }),

    readNotes: tool({
        description: "Hiển thị tất cả các ghi chú đã lưu.",
        inputSchema: z.object(),
        async execute() {
            const obj = loadMemoryObj();
            if (obj.memory.length === 0 && !obj.summarize.trim()) return "Không có ghi chú nào.";
            const recent = obj.memory.slice(-10);
            const parts: string[] = [];
            if (obj.summarize.trim()) parts.push(`Tóm tắt:\n${obj.summarize}`);
            if (recent.length > 0) parts.push(`Ghi chú gần đây:\n- ${recent.join("\n- ")}`);
            return parts.join("\n\n");
        },
    }),

    summarizeNotes: tool({
        description: "Tóm tắt các ghi chú đã lưu.",
        inputSchema: z.object(),
        async execute() {
            const obj = loadMemoryObj();
            await compactMemoryIfNeeded(obj);
            // If nothing new, reuse existing summarize
            if (!obj.is_update && obj.summarize && obj.summarize.trim().length > 0) {
                saveMemoryObj(obj);
                return obj.summarize;
            }
            // Otherwise, regenerate and reset the flag
            const summary = await summarizeNotesAI(obj.memory);
            obj.summarize = summary;
            obj.is_update = false;
            saveMemoryObj(obj);
            return summary;
        },
    }),
};

// Standalone functions for reuse outside tools
export function memoryReadNotes(): string[] {
    const obj = loadMemoryObj();
    return obj.memory;
}

export async function memoryAddNote(note: string): Promise<void> {
    const obj = loadMemoryObj();
    const normalized = normalizeNote(note);
    if (!normalized) return;
    obj.memory.push(normalized);
    obj.is_update = true;
    await compactMemoryIfNeeded(obj);
    saveMemoryObj(obj);
}

export async function memorySummarize(): Promise<string> {
    const obj = loadMemoryObj();
    await compactMemoryIfNeeded(obj);
    if (!obj.is_update && obj.summarize && obj.summarize.trim().length > 0) {
        saveMemoryObj(obj);
        // ⚠️ FIX v1.5.17 — Sanitize "Sleiz" → "Nguyễn Đình Dương" trong memory summary
        return sanitizeSleizInMemory(obj.summarize);
    }
    const summary = await summarizeNotesAI(obj.memory);
    obj.summarize = summary;
    obj.is_update = false;
    saveMemoryObj(obj);
    return sanitizeSleizInMemory(summary);
}

export function memoryGetSummaryCached(): string {
    const obj = loadMemoryObj();
    return sanitizeSleizInMemory(obj.summarize || "");
}

/**
 * ⚠️ FIX v1.5.17 — Sanitize "Sleiz" → "Nguyễn Đình Dương" trong memory.
 * Tránh AI tự nhận tên cũ "Sleiz" khi đọc memory summary.
 */
function sanitizeSleizInMemory(text: string): string {
    if (!text || typeof text !== 'string') return text;
    return text
        .replace(/\bSleiz\b/g, 'Nguyễn Đình Dương')
        .replace(/\bsleiz\b/g, 'nguyễn đình dương');
}
