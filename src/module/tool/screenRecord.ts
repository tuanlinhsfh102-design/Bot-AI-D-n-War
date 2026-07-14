/**
 * screenRecord.ts — Quay màn hình hiện tại bằng ffmpeg, đa nền tảng.
 *
 * Hỗ trợ:
 *   - Windows: gdigrab (capture desktop)
 *   - macOS:   avfoundation (capture screen "1:")
 *   - Linux:   x11grab (khi có $DISPLAY) hoặc fbdev /dev/fb0 (headless server)
 *
 * Output: file mp4 (H.264 + yuv420p) trong os.tmpdir(), tự cleanup sau khi dùng.
 *
 * Reference:
 *   - https://trac.ffmpeg.org/wiki/Capture/Desktop
 *   - https://ffmpeg.org/ffmpeg-devices.html
 */
import { spawn } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';

export interface RecordScreenOptions {
    durationSec?: number;    // thời lượng quay (giây). Mặc định 10, max 30, min 1.
    framerate?: number;      // fps. Mặc định 20, max 30, min 5.
    width?: number;          // chiều rộng (auto-detect nếu bỏ trống)
    height?: number;         // chiều cao
    outDir?: string;         // thư mục output (mặc định os.tmpdir())
}

export interface RecordScreenResult {
    filePath: string;        // đường dẫn tuyệt đối tới file mp4
    fileSize: number;        // bytes
    durationSec: number;     // thời lượng thực tế
    width: number;
    height: number;
    framerate: number;
    method: string;          // 'gdigrab' | 'avfoundation' | 'x11grab' | 'fbdev'
    cleanup: () => void;     // xóa file tạm
}

const MIN_DURATION = 1;
const MAX_DURATION = 30;
const DEFAULT_DURATION = 10;

const MIN_FRAMERATE = 5;
const MAX_FRAMERATE = 30;
const DEFAULT_FRAMERATE = 20;

function clamp(n: number, min: number, max: number, fallback: number): number {
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * Detect phương thức quay màn hình phù hợp với platform hiện tại.
 * Trả về null nếu không có display/headless không hỗ trợ.
 */
function detectCaptureMethod(): { method: string; input: string; extraArgs: string[] } | null {
    const platform = process.platform;

    if (platform === 'win32') {
        // Windows: gdigrab, capture toàn bộ desktop
        return { method: 'gdigrab', input: 'desktop', extraArgs: ['-draw_mouse', '1'] };
    }

    if (platform === 'darwin') {
        // macOS: avfoundation, "1:" = capture màn hình 1, không có audio
        return { method: 'avfoundation', input: '1:', extraArgs: ['-capture_cursor', '1', '-capture_mouse_clicks', '1'] };
    }

    if (platform === 'linux') {
        // Linux có X11 display
        const display = process.env.DISPLAY;
        if (display) {
            return { method: 'x11grab', input: display, extraArgs: ['-draw_mouse', '1'] };
        }
        // Linux headless: thử framebuffer /dev/fb0
        if (fs.existsSync('/dev/fb0')) {
            return { method: 'fbdev', input: '/dev/fb0', extraArgs: [] };
        }
        // Không có display
        return null;
    }

    return null;
}

/**
 * Lấy kích thước màn hình tự động theo phương thức capture.
 */
function detectScreenSize(method: string): { width: number; height: number } | null {
    try {
        if (method === 'x11grab' && process.env.DISPLAY) {
            // Dùng xdotool / xdpyinfo nếu có; fallback 1920x1080
            const { execSync } = require('child_process');
            try {
                const out = execSync('xdpyinfo 2>/dev/null | grep dimensions', { encoding: 'utf-8', timeout: 3000 });
                const m = out.match(/(\d+)x(\d+)/);
                if (m) return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
            } catch { /* ignore */ }
        }
        if (method === 'fbdev' && fs.existsSync('/dev/fb0')) {
            // Đọc /sys/class/graphics/fb0/virtual_size hoặc modes
            try {
                const sz = fs.readFileSync('/sys/class/graphics/fb0/virtual_size', 'utf-8');
                const m = sz.match(/(\d+),(\d+)/);
                if (m) return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
            } catch { /* ignore */ }
        }
    } catch { /* ignore */ }
    return null;
}

/**
 * Quay màn hình hiện tại, trả về file mp4 tạm.
 *
 * @throws Error nếu không hỗ trợ platform hoặc ffmpeg thất bại.
 */
export function recordScreen(opts: RecordScreenOptions = {}): Promise<RecordScreenResult> {
    return new Promise((resolve, reject) => {
        const method = detectCaptureMethod();
        if (!method) {
            const platform = process.platform;
            const display = process.env.DISPLAY ?? '(không có)';
            reject(new Error(
                `Không tìm thấy display để quay màn hình. ` +
                `Platform=${platform}, DISPLAY=${display}. ` +
                `Trên Linux headless cần /dev/fb0 hoặc DISPLAY, trên Windows/macOS cần session GUI.`
            ));
            return;
        }

        const durationSec = clamp(opts.durationSec ?? DEFAULT_DURATION, MIN_DURATION, MAX_DURATION, DEFAULT_DURATION);
        const framerate = clamp(opts.framerate ?? DEFAULT_FRAMERATE, MIN_FRAMERATE, MAX_FRAMERATE, DEFAULT_FRAMERATE);

        // Kích thước: ưu tiên opts, fallback auto-detect, cuối cùng 1920x1080
        let width = opts.width;
        let height = opts.height;
        if ((!width || !height)) {
            const detected = detectScreenSize(method.method);
            if (detected) {
                width = width ?? detected.width;
                height = height ?? detected.height;
            }
        }
        width = width ?? 1920;
        height = height ?? 1080;

        // Đảm bảo width/height chẵn (libx264 yêu cầu)
        if (width % 2 !== 0) width -= 1;
        if (height % 2 !== 0) height -= 1;

        // Output file
        const outDir = opts.outDir ?? os.tmpdir();
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        const outPath = path.join(outDir, `screen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`);

        // Build ffmpeg args
        const args: string[] = [
            '-y',                              // overwrite output
            '-f', method.method,
            ...method.extraArgs,
            '-framerate', String(framerate),
        ];

        if (method.method === 'x11grab') {
            args.push('-video_size', `${width}x${height}`);
        } else if (method.method === 'gdigrab') {
            args.push('-video_size', `${width}x${height}`);
        }

        args.push('-i', method.input);

        // Encoding: libx264 + yuv420p cho tương thích rộng
        // + preset fast + crf 28 để file nhỏ (screen capture không cần chất lượng cao)
        args.push(
            '-t', String(durationSec),
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '28',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',      // streamable mp4
            '-vf', `scale=trunc(iw/2)*2:trunc(ih/2)*2`,  // đảm bảo chẵn
            '-an',                           // không có audio
            outPath,
        );

        console.log(`[ScreenRecord] ffmpeg ${args.join(' ')}`);

        const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderrData = '';
        proc.stderr.on('data', (chunk: Buffer) => {
            stderrData += chunk.toString();
            // Giới hạn bộ nhớ
            if (stderrData.length > 8000) stderrData = stderrData.slice(-8000);
        });

        // Timeout: durationSec + 5s buffer
        const timeoutMs = (durationSec + 5) * 1000;
        const timer = setTimeout(() => {
            try { proc.kill('SIGKILL'); } catch { /* ignore */ }
            try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch { /* ignore */ }
            reject(new Error(`ffmpeg timeout sau ${timeoutMs}ms`));
        }, timeoutMs);

        proc.on('error', (err) => {
            clearTimeout(timer);
            try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch { /* ignore */ }
            reject(new Error(`ffmpeg spawn thất bại: ${err.message}. Có thể ffmpeg chưa cài.`));
        });

        proc.on('close', (code: number) => {
            clearTimeout(timer);
            if (code !== 0) {
                try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch { /* ignore */ }
                reject(new Error(`ffmpeg exit code ${code}. stderr: ${stderrData.slice(-2000)}`));
                return;
            }
            if (!fs.existsSync(outPath)) {
                reject(new Error(`ffmpeg chạy xong nhưng không có file output. stderr: ${stderrData.slice(-2000)}`));
                return;
            }
            const stat = fs.statSync(outPath);
            if (stat.size === 0) {
                try { fs.unlinkSync(outPath); } catch { /* ignore */ }
                reject(new Error(`ffmpeg output file rỗng. stderr: ${stderrData.slice(-2000)}`));
                return;
            }
            resolve({
                filePath: outPath,
                fileSize: stat.size,
                durationSec,
                width: width!,
                height: height!,
                framerate,
                method: method.method,
                cleanup: () => {
                    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch { /* ignore */ }
                },
            });
        });
    });
}
