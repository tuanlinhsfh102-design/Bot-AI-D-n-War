// fetch-url.ts
import { ProxyAgent, fetch as undiciFetch, RequestInit } from "undici";

/** Error shaping giống bản Python */
export const INTERNAL_ERROR = "INTERNAL_ERROR" as const;

export interface ErrorData {
    code: typeof INTERNAL_ERROR;
    message: string;
}

export class McpError extends Error {
    code: typeof INTERNAL_ERROR;
    constructor(data: ErrorData) {
        super(data.message);
        this.code = data.code;
        this.name = "McpError";
    }
}

/**
 * Tương đương: fetch_url(url, user_agent, force_raw=False, proxy_url=None) -> Tuple[str, str]
 * Trả về [content, prefix]
 */
export async function fetchUrl({
    url,
    forceRaw = false,
}: any): Promise<[string, string]> {
    const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"
    const controller = new AbortController();
    const timeoutMs = 30_000;
    const to = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = {
        "User-Agent": userAgent,
        "Accept": "*/*",
    };

    const init: RequestInit = {
        method: "GET",
        headers,
        redirect: "follow",
        signal: controller.signal,
    };

    try {
        const res = await undiciFetch(url, init);
        if (res.status >= 400) {
            throw new Error(`Failed to fetch ${url} - status code ${res.status}`);
        }

        const pageRaw = await res.text();
        const contentType = res.headers.get("content-type") ?? "";
        const isPageHtml =
            pageRaw.slice(0, 100).toLowerCase().includes("<html") ||
            contentType.includes("text/html") ||
            contentType === "";

        if (isPageHtml && !forceRaw) {
            return [extractContentFromHtml(pageRaw), ""];
        }

        return [
            pageRaw,
            `Content type ${contentType || "(unknown)"} cannot be simplified to markdown, but here is the raw content:\n`,
        ];
    } catch (e: any) {
        if (e?.name === "AbortError") {
            throw new Error(`Failed to fetch ${url}: Timeout after ${timeoutMs}ms`);
        }
        if (e instanceof McpError) throw e;
        throw new Error(`Failed to fetch ${url}: ${String(e)}`);
    } finally {
        clearTimeout(to);
    }
}

/**
 * extract_content_from_html(page_raw) -> markdown
 * Bản rút gọn, không dùng thư viện ngoài:
 * - Gỡ script/style/noscript
 * - Lấy <title>, <meta name="description">
 * - Chuyển đổi các thẻ cơ bản thành Markdown
 * - Gom nội dung có ý nghĩa (headers, paragraphs, lists, links)
 */
export function extractContentFromHtml(html: string): string {
    // Chuẩn hoá: bỏ BOM và xuống dòng đồng nhất
    let h = html.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

    // Bỏ script/style/noscript
    h = h
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "");

    // Lấy title và description (nếu có)
    const titleMatch = h.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? decodeEntities(stripTags(titleMatch[1]).trim()) : "";

    const metaDescMatch = h.match(
        /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i
    );
    const metaDesc = metaDescMatch ? decodeEntities(metaDescMatch[1].trim()) : "";

    // Chuyển đổi một số block-level tags thành xuống dòng
    h = h
        .replace(/<\/(p|div|section|article|header|footer|main|aside)>/gi, "\n\n")
        .replace(/<br\s*\/?>/gi, "\n");

    // Headings -> Markdown
    for (let level = 6; level >= 1; level--) {
        const re = new RegExp(`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`, "gi");
        h = h.replace(re, (_m, inner) => {
            const text = decodeEntities(stripTags(inner).trim());
            return `${"#".repeat(level)} ${text}\n\n`;
        });
    }

    // Links: <a href="...">text</a> -> [text](href)
    h = h.replace(
        /<a\b([^>]*)>([\s\S]*?)<\/a>/gi,
        (_m, attrs, inner) => {
            const hrefMatch = String(attrs).match(/\bhref\s*=\s*["']([^"']+)["']/i);
            const href = hrefMatch ? hrefMatch[1] : "";
            const text = decodeEntities(stripTags(inner).trim());
            if (!href) return text;
            return `[${text}](${href})`;
        }
    );

    // Lists: <li> -> "- item"
    h = h.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner) => {
        const text = decodeEntities(stripTags(inner).trim());
        return `- ${text}\n`;
    });
    // Loại bỏ ul/ol còn lại
    h = h.replace(/<\/?(ul|ol)[^>]*>/gi, "\n");

    // Bảng (cực tối giản): thay <th>/<td> bằng " | " và mỗi hàng xuống dòng
    h = h.replace(/<tr[^>]*>/gi, "\n").replace(/<\/tr>/gi, "\n");
    h = h.replace(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi, (_m, inner) => {
        const text = decodeEntities(stripTags(inner).trim());
        return ` ${text} |`;
    });
    h = h.replace(/<\/?table[^>]*>/gi, "\n");

    // Bỏ mọi thẻ còn lại
    h = stripTags(h);

    // Dọn whitespace
    const body = collapseBlankLines(h)
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n")
        .trim();

    // Ghép title + description + body
    const parts: string[] = [];
    if (title) parts.push(`# ${title}`);
    if (metaDesc) parts.push(`> ${metaDesc}`);
    if (body) parts.push(body);

    return parts.join("\n\n").trim();
}

// ==== Helpers ====

function stripTags(input: string): string {
    return input.replace(/<\/?[^>]+>/g, "");
}

function collapseBlankLines(input: string): string {
    return input.replace(/\n{3,}/g, "\n\n");
}

function decodeEntities(s: string): string {
    // Decode một số entity phổ biến (đủ dùng cho extractor tối giản)
    const map: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
        nbsp: " ",
    };
    return s
        // numeric entities
        .replace(/&#(\d+);/g, (_m, code) => {
            const n = Number(code);
            return Number.isFinite(n) ? String.fromCharCode(n) : _m;
        })
        .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
            const n = parseInt(hex, 16);
            return Number.isFinite(n) ? String.fromCharCode(n) : _m;
        })
        // named entities
        .replace(/&([a-zA-Z]+);/g, (_m, name) => (name in map ? map[name] : _m));
}
