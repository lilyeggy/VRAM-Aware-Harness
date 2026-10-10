import { describe, it, expect } from "bun:test";
import { VmUidAllocator } from "../../src/sandbox/microvm/vm-uid-allocator";
import { VmCidAllocator } from "../../src/sandbox/microvm/vm-cid-allocator";

/**
 * 多 VM 并发相关的单测（P0）。
 *
 * ## 为什么需要
 *
 * 此前全仓库**没有任何测试同时跑两台以上 microVM**：唯一的 Promise.all 是串口桥
 * 在同一 bridge 上跑两条命令，不是两台 VM。而产品核心承诺是"多租户每人一台云
 * 电脑"——唯一没有证据的维度恰好是卖点。
 *
 * 并发下最危险的是**号段分配竞争**：
 * - guest CID：重复会导致 vsock 连错 VM（数据串租户，最严重）
 * - UID/GID：重复会让两个 VM 以同一宿主身份运行，jailer 隔离被削弱
 *
 * 这些分配器在同步代码里看似安全，但一旦被放进 `await` 交错的异步流程
 * （真实 createVm 就是），"检查-占位"之间就可能出现间隙。
 */

/** 模拟真实 createVm 的异步交错：每个 VM 在分配前后都有 await 间隙 */
async function withConcurrency<T>(items: T[], fn: (item: T, i: number) => Promise<void>): Promise<void> {
    await Promise.all(items.map((item, i) => fn(item, i)));
}

describe("并发分配：guest CID 唯一性（防 vsock 串租户）", () => {
    it("50 个 VM 并发分配，CID 全部唯一且无空洞泄漏", async () => {
        const alloc = new VmCidAllocator();
        const ids = Array.from({ length: 50 }, (_, i) => `vm-${i}`);

        await withConcurrency(ids, async (id) => {
            // 真实流程里 allocate 前后都有 await（socket 等待、磁盘复制等）
            await new Promise((r) => setTimeout(r, Math.random() * 5));
            alloc.allocate(id);
            await new Promise((r) => setTimeout(r, Math.random() * 5));
        });

        const cids = ids.map((id) => alloc.get(id));
        // 每个 VM 都必须拿到 CID
        expect(cids.every((c) => c !== undefined)).toBe(true);
        // 唯一性 —— 重复 CID 会导致 vsock 连错 VM（跨租户数据泄漏）
        expect(new Set(cids).size).toBe(50);
        // 从 base(3) 起连续分配，不应有空洞
        const sorted = [...cids].sort((a, b) => a! - b!);
        expect(sorted[0]).toBe(3);
        expect(sorted[49]).toBe(52);
    });

    it("同一 sandboxId 重复分配返回同一 CID（幂等，不会泄漏号段）", async () => {
        const alloc = new VmCidAllocator();
        const first = alloc.allocate("same");
        const second = alloc.allocate("same");
        expect(second).toBe(first);
    });

    it("release 后号段可被复用，且不会与存量冲突", async () => {
        const alloc = new VmCidAllocator();
        const a = alloc.allocate("a");
        alloc.allocate("b");
        alloc.release("a");
        // a 的号段应被回收给新 VM
        const c = alloc.allocate("c");
        expect(c).toBe(a);
    });

    it("CID 池耗尽时抛错而非静默重复分配", () => {
        const alloc = new VmCidAllocator(3, 5); // 只有 3 个可用
        alloc.allocate("a");
        alloc.allocate("b");
        alloc.allocate("c");
        // 第 4 个必须失败——绝不能重复分配已有 CID
        expect(() => alloc.allocate("d")).toThrow(/exhausted/);
    });
});

describe("并发分配：UID/GID 唯一性（保 jailer 隔离）", () => {
    it("50 个 VM 并发分配，UID/GID 全部唯一", async () => {
        const alloc = new VmUidAllocator();
        const ids = Array.from({ length: 50 }, (_, i) => `vm-${i}`);

        await withConcurrency(ids, async (id) => {
            await new Promise((r) => setTimeout(r, Math.random() * 5));
            alloc.allocate(id);
            await new Promise((r) => setTimeout(r, Math.random() * 5));
        });

        // get() 返回 VmUidGid 对象，必须取 .uid 比较内容
        // （若误用对象引用比较会永远"唯一"，测不出号段冲突）
        const uids = ids.map((id) => alloc.get(id)?.uid);
        expect(uids.every((u) => u !== undefined)).toBe(true);
        // 唯一性 —— 重复 UID 会让两个 VM 以同一宿主身份运行，隔离被削弱
        expect(new Set(uids).size).toBe(50);
        // base 默认 20000，应连续占满 20000-20049
        expect(Math.min(...uids as number[])).toBe(20000);
        expect(Math.max(...uids as number[])).toBe(20049);
    });

    it("UID 与 GID 一一对应（同值），保证 chown 一致", () => {
        const alloc = new VmUidAllocator();
        const { uid, gid } = alloc.allocate("vm-x");
        expect(gid).toBe(uid);
    });

    it("并发分配 + 并发 release 不产生重复号段", async () => {
        const alloc = new VmUidAllocator();
        const first = Array.from({ length: 20 }, (_, i) => `vm-${i}`);
        first.forEach((id) => alloc.allocate(id));

        // 一边释放一边新分配
        await withConcurrency(
            Array.from({ length: 20 }, (_, i) => ({
                // noUncheckedIndexedAccess 下 first[i] 是 string | undefined，
                // 这里数组长度与 i 严格对应，非空可证，故断言收窄。
                release: first[i] as string,
                alloc: `new-${i}`,
            })),
            async ({ release, alloc: id }) => {
                await new Promise((r) => setTimeout(r, Math.random() * 3));
                alloc.release(release);
                await new Promise((r) => setTimeout(r, Math.random() * 3));
                alloc.allocate(id);
            },
        );

        // get() 返回 VmUidGid（{uid, gid}）而不是裸 number，
        // 因此唯一性要分别对 uid 和 gid 断言。
        const activeUids = [...Array(20).keys()]
            .map((i) => alloc.get(`new-${i}`))
            .filter((u): u is NonNullable<typeof u> => u !== undefined);
        expect(activeUids).toHaveLength(20);
        expect(new Set(activeUids.map((u) => u.uid)).size).toBe(20);
        expect(new Set(activeUids.map((u) => u.gid)).size).toBe(20);
    });

    it("UID 池耗尽时抛错而非静默重复分配", () => {
        const alloc = new VmUidAllocator(20000, 20002); // 只有 3 个
        alloc.allocate("a");
        alloc.allocate("b");
        alloc.allocate("c");
        expect(() => alloc.allocate("d")).toThrow(/exhausted/);
    });

    it("拒绝使用系统号段（baseUid < 1000 直接抛错）", () => {
        expect(() => new VmUidAllocator(999)).toThrow(/baseUid/);
    });
});

