import fs from 'node:fs';
import path from 'node:path';

/**
 * Validate environment variables on startup
 * Exits with clear error if no OpenCode Zen API keys found
 */
function validateEnv(): void {
    console.log('[Env] Đang kiểm tra environment variables...');

    // Kiểm tra OpenCode Zen API keys (bắt buộc cho text generation)
    const zenKey = process.env.OPENCODE_ZEN_API_KEY || process.env.ZEN_API_KEY;
    const zenKeys = process.env.OPENCODE_ZEN_API_KEYS || process.env.ZEN_API_KEYS;
    
    const hasZenKey = zenKey ? true : false;
    const hasZenKeys = zenKeys ? zenKeys.split(',').filter(k => k.trim()).length > 0 : false;

    if (!hasZenKey && !hasZenKeys) {
        console.error('\n┌─────────────────────────────────────────────────────────────┐');
        console.error('│  ✗ THIẾU OPENCODE ZEN API KEY                                │');
        console.error('└─────────────────────────────────────────────────────────────┘\n');
        console.error('Bot cần OpenCode Zen API key để chạy AI (text generation).');
        console.error('Zen là gateway của OpenCode — dùng model deepseek-v4-flash-free (FREE)\n');
        console.error('Cách lấy:');
        console.error('  1. Truy cập: https://opencode.ai/zen');
        console.error('  2. Sign in → Add billing details (có free credit)');
        console.error('  3. Copy API key\n');
        console.error('Cách cấu hình (chọn 1 trong 3):');
        console.error('  Cách A — File .env (khuyến nghị): OPENCODE_ZEN_API_KEY=zen_xxx...your_key_here');
        console.error('  Cách B — Nhiều key qua env: OPENCODE_ZEN_API_KEYS=key1,key2');
        console.error('  Cách C — Ném vào folder data/api_keys/ (HOT-RELOAD!): data/api_keys/zen.txt');
        process.exit(1);
    }

    // Log configuration
    if (hasZenKey) {
        console.log('[Env] ✓ OpenCode Zen API key: ' + zenKey.substring(0, 10) + '...');
    }
    if (hasZenKeys) {
        const keyCount = zenKeys.split(',').filter(k => k.trim()).length;
        console.log('[Env] ✓ OpenCode Zen API keys: ' + keyCount + ' keys configured');
    }
}

function ensureEnvFile(): void {
    const envPath = path.join(process.cwd(), '.env');
    const examplePath = path.join(process.cwd(), '.env.example');
    
    if (!fs.existsSync(envPath)) {
        if (fs.existsSync(examplePath)) {
            console.log('[Env] 📋 Tạo file .env từ .env.example');
            try {
                fs.copyFileSync(examplePath, envPath);
                console.log('[Env] ✅ File .env đã được tạo');
            } catch (error) {
                console.warn('[Env] ⚠️ Không thể tạo .env:', error);
            }
        } else {
            console.log('[Env] ℹ️  Không tìm thấy file .env hoặc .env.example');
        }
    }
}

/**
 * Reload environment (hot reload support)
 */
function reloadAndCheckEnv(): void {
    console.log('[Env] 🔄 Đang tải lại environment...');
    validateEnv();
}

// Export tất cả hàm public để sử dụng
export { validateEnv, ensureEnvFile, reloadAndCheckEnv };