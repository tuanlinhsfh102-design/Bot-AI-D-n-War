import { processThread } from './ai';

export type Action = { type: 'sendMessage'; content: string } | { type: 'delay'; time: number } | Record<string, any>;

/**
 * ThreadKind — alias nội bộ cho ThreadType của zca-js.
 * zca-js enum chỉ có 2 giá trị:
 *   - ThreadType.User  = 0  (Direct Message / chat riêng)
 *   - ThreadType.Group = 1  (Group chat)
 * Không có "DirectMessage" — đây là alias để code dễ đọc.
 */
export type ThreadKind = 'User' | 'Group';

type Executor = (threadId: string, actions: Action[]) => Promise<void> | void;

/**
 * ⚠️ FIX v1.5.0 — Per-thread concurrency
 * =======================================
 * Trước đây queue dùng 1 flag `processing` GLOBAL → chỉ 1 thread được xử lý
 * tại 1 thời điểm. Khi group A đang được xử lý (mất 15-75s do AI gen + multiple
 * sendMessage với human-like delay), TẤT CẢ thread khác (group B, C, DM, ...)
 * bị BLOCK trong queue. User thấy bot "chỉ rep ở 1 group, bơ mấy group còn lại".
 *
 * Fix: thay `processing: boolean` bằng `processingThreads: Set<string>`.
 * Mỗi thread có thể chạy processThread độc lập. Constraint: chỉ 1 processThread
 * chạy đồng thời PER THREAD (tránh 2 turn reply đan xen trên cùng 1 thread → lộ bot).
 *
 * Thêm `maxConcurrency` (default 5) để tránh spam API khi nhiều thread đến cùng lúc.
 * Khi activeCount >= maxConcurrency, processNext sẽ chờ — sẽ được kick lại khi 1
 * thread hoàn thành (trong finally block).
 *
 * Behavior:
 * - Group A đang xử lý → group B message đến → processNext pick B → xử lý song song ✓
 * - Group A đang xử lý → group A message mới đến → buffer gom lại, đợi A xong rồi
 *   pick A lần nữa (vì processingThreads.has(A) → skip) ✓
 * - 6 thread đến cùng lúc → 5 chạy, 1 chờ → khi 1 xong, thread thứ 6 được pick ✓
 */
const DEFAULT_MAX_CONCURRENCY = 5;

export class MessageQueue {
  private queue: string[] = [];
  private inQueue = new Set<string>();
  /**
   * Per-thread processing lock. Một thread chỉ được xử lý bởi 1 processThread
   * tại 1 thời điểm để tránh 2 turn reply đan xen (lộ bot).
   */
  private processingThreads = new Set<string>();
  private activeCount = 0;
  private readonly maxConcurrency: number;
  private executor: Executor;
  private buffers = new Map<string, string[]>();
  private latestShortId = new Map<string, string>();
  private threadTypes = new Map<string, ThreadKind>();
  private senderIds = new Map<string, string | undefined>();
  /**
   * ⚠️ FIX v1.5.20 — Track TẤT CẢ senderIds trong 1 batch (multi-mention).
   * Trước đây chỉ lưu senderId cuối → bot chỉ mention 1 người dù nhiều user chửi.
   * Giờ: lưu array senderIds → bot mention tất cả @user1 @user2 @user3 trong 1 tin.
   */
  private allSenderIds = new Map<string, string[]>();
  /** ⭐ Admin flag — khi admin nói, bot vâng lời tuyệt đối */
  private isAdminFlags = new Map<string, boolean>();

  // Stats để debug/monitor
  private totalProcessed = 0;
  private totalErrors = 0;
  private peakConcurrency = 0;

  constructor(options?: { executor?: Executor; maxConcurrency?: number }) {
    this.executor = options?.executor ?? (async (threadId, actions) => {
      console.info(`[Queue] Actions for ${threadId}:`, actions);
    });
    this.maxConcurrency = Math.max(1, options?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
  }

  /**
   * Enqueue a thread for processing.
   * - messages: optional buffer of raw messages
   * - newestShortId: latest short id from storage
   * - threadType: 'User' (DM) or 'Group'
   * - senderId: userId của người đang chat với bot (sender cuối cùng).
   * - allSenderIds: ⚠️ FIX v1.5.20 — array TẤT CẢ senderIds trong batch (multi-mention)
   *   Dùng để bot mention @user1 @user2 @user3 trong 1 tin khi nhiều người chửi.
   */
  enqueue(
    threadId: string,
    messages?: string[],
    newestShortId?: string,
    threadType?: ThreadKind,
    senderId?: string,
    allSenderIds?: string[],
    isAdmin?: boolean, // ⭐ admin flag
  ) {
    if (messages && messages.length > 0) {
      const buf = this.buffers.get(threadId) ?? [];
      buf.push(...messages);
      this.buffers.set(threadId, buf);
    }
    if (newestShortId) this.latestShortId.set(threadId, newestShortId);
    if (threadType) this.threadTypes.set(threadId, threadType);
    if (senderId !== undefined) this.senderIds.set(threadId, senderId);
    // ⚠️ FIX v1.5.20 — Merge allSenderIds (dedupe)
    if (allSenderIds && allSenderIds.length > 0) {
      const existing = this.allSenderIds.get(threadId) ?? [];
      const merged = Array.from(new Set([...existing, ...allSenderIds.filter(Boolean)]));
      this.allSenderIds.set(threadId, merged);
    }
    // ⭐ Admin flag
    if (isAdmin !== undefined) this.isAdminFlags.set(threadId, true);

    // Nếu thread đang được xử lý → KHÔNG re-add vào queue (sẽ tự pick lại khi xong
    // vì buffer đã được merge ở trên). Chỉ kick processNext để xem có slot trống không.
    if (this.processingThreads.has(threadId)) {
      void this.processNext();
      return;
    }

    if (this.inQueue.has(threadId)) {
      // Đã trong queue → đẩy về cuối để ưu tiên thread mới active hơn
      const idx = this.queue.indexOf(threadId);
      if (idx !== -1) this.queue.splice(idx, 1);
      this.queue.push(threadId);
    } else {
      this.queue.push(threadId);
      this.inQueue.add(threadId);
    }

    // ⚠️ FIX: luôn kick processNext, KHÔNG gate bằng global processing flag.
    // processNext sẽ tự check maxConcurrency và processingThreads.
    void this.processNext();
  }

  /**
   * Pick threadId tiếp theo KHÔNG đang được xử lý, và khởi chạy processThread.
   * Per-thread lock đảm bảo không có 2 processThread chạy song song trên cùng 1 thread.
   * maxConcurrency đảm bảo không spam API khi nhiều thread đến cùng lúc.
   */
  private async processNext(): Promise<void> {
    // Đạt max concurrency → chờ (sẽ được kick trong finally của runThread)
    if (this.activeCount >= this.maxConcurrency) return;

    // Tìm threadId đầu tiên trong queue mà KHÔNG đang được xử lý
    let nextId: string | undefined;
    let i = 0;
    while (i < this.queue.length) {
      const candidate = this.queue[i];
      if (this.processingThreads.has(candidate)) {
        // Thread đang được xử lý → buffer mới đã được merge vào buffers
        // current processThread sẽ KHÔNG pick được buffer mới (đã snapshot rồi)
        // → phải giữ trong queue để pick lại sau khi xong
        i++;
        continue;
      }
      // Tìm thấy → remove khỏi queue
      this.queue.splice(i, 1);
      this.inQueue.delete(candidate);
      nextId = candidate;
      break;
    }

    if (!nextId) return;

    // Đánh dấu đang xử lý + tăng activeCount
    this.processingThreads.add(nextId);
    this.activeCount++;
    if (this.activeCount > this.peakConcurrency) {
      this.peakConcurrency = this.activeCount;
    }

    // Chạy async — không await để processNext có thể return ngay,
    // cho phép enqueue tiếp theo kick thêm processNext khác nếu còn slot.
    void this.runThread(nextId);

    // Nếu còn slot và còn thread khác trong queue → tiếp tục pick
    if (this.activeCount < this.maxConcurrency && this.queue.length > 0) {
      void this.processNext();
    }
  }

  private async runThread(threadId: string): Promise<void> {
    const startedAt = Date.now();
    try {
      const msgs = this.buffers.get(threadId) ?? [];
      this.buffers.delete(threadId);
      const shortId = this.latestShortId.get(threadId);
      this.latestShortId.delete(threadId);
      const threadType = this.threadTypes.get(threadId) ?? 'User';
      this.threadTypes.delete(threadId);
      const senderId = this.senderIds.get(threadId);
      this.senderIds.delete(threadId);
      // ⚠️ FIX v1.5.20 — Lấy allSenderIds cho multi-mention
      const allSenderIds = this.allSenderIds.get(threadId) ?? [];
      this.allSenderIds.delete(threadId);

      // ⭐ isAdmin — lấy và xoá
      const isAdmin = this.isAdminFlags.get(threadId) ?? false;
      this.isAdminFlags.delete(threadId);

      console.info(
        `[Queue] ▶ Processing ${threadId} (active=${this.activeCount}/${this.maxConcurrency}, queued=${this.queue.length}, msgs=${msgs.length}, senders=${allSenderIds.length}${isAdmin ? ', ADMIN' : ''})`,
      );

      // ⚠️ processThread await executeAI → đảm bảo 1 thread chỉ có 1 turn chạy
      // tại 1 thời điểm. Multiple threads có thể chạy song song.
      const actions = await processThread(threadId, msgs, shortId, { threadType, senderId, allSenderIds, isAdmin });
      await this.executor(threadId, Array.isArray(actions) ? actions : []);

      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.info(`[Queue] ✓ Done ${threadId} in ${elapsed}s`);
      this.totalProcessed++;
    } catch (err) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.error(`[Queue] ✗ Error processing ${threadId} after ${elapsed}s:`, err);
      this.totalErrors++;
    } finally {
      this.processingThreads.delete(threadId);
      this.activeCount--;

      // Pick thread tiếp theo nếu queue còn.
      // Đặc biệt quan trọng: nếu thread này có buffer mới đến trong lúc xử lý,
      // buffer đó đã được enqueue() đẩy vào queue (vì processingThreads.has() = true
      // lúc đó, enqueue() skip phần add-to-queue). Nhưng buffer nằm trong this.buffers,
      // nên khi threadId được pick lại, processThread sẽ thấy messages mới.
      //
      // Wait — re-check: trong enqueue(), nếu thread đang được xử lý thì ta KHÔNG
      // add vào queue (chỉ kick processNext). Vậy khi runThread xong, làm sao
      // threadId được pick lại?
      // → Ta cần check buffer sau khi runThread xong, nếu còn messages → re-enqueue.
      const remaining = this.buffers.get(threadId);
      if (remaining && remaining.length > 0) {
        // Có messages mới đến trong lúc xử lý → re-enqueue
        if (!this.inQueue.has(threadId)) {
          this.queue.push(threadId);
          this.inQueue.add(threadId);
        }
      }

      if (this.queue.length > 0) void this.processNext();
    }
  }

  /**
   * Get stats for monitoring/debug.
   */
  getStats(): {
    active: number;
    maxConcurrency: number;
    queued: number;
    totalProcessed: number;
    totalErrors: number;
    peakConcurrency: number;
  } {
    return {
      active: this.activeCount,
      maxConcurrency: this.maxConcurrency,
      queued: this.queue.length,
      totalProcessed: this.totalProcessed,
      totalErrors: this.totalErrors,
      peakConcurrency: this.peakConcurrency,
    };
  }

  /**
   * Check xem 1 thread có đang được xử lý không (dùng cho test/debug).
   */
  isProcessing(threadId: string): boolean {
    return this.processingThreads.has(threadId);
  }
}
