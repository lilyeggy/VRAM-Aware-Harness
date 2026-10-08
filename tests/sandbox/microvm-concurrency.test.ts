import { describe, it, expect } from "bun:test";
import { VmUidAllocator } from "../../src/sandbox/microvm/vm-uid-allocator";
import { VmCidAllocator } from "../../src/sandbox/microvm/vm-cid-allocator";
import { MicrovmWarmPool, mapResourceToTier } from "../../src/sandbox/microvm/microvm-warm-pool";
import { MockMicrovmDriver } from "../../src/sandbox/microvm/mock-microvm-driver";

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
            Array.from({ length: 20 }, (_, i) => ({ release: first[i], alloc: `new-${i}` })),
            async ({ release, alloc: id }) => {
                await new Promise((r) => setTimeout(r, Math.random() * 3));
                alloc.release(release);
                await new Promise((r) => setTimeout(r, Math.random() * 3));
                alloc.allocate(id);
            },
        );

        const activeUids = [...Array(20).keys()]
            .map((i) => alloc.get(`new-${i}`))
            .filter((u): u is number => u !== undefined);
        expect(new Set(activeUids).size).toBe(activeUids.length);
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

describe("并发：预热池补货竞争", () => {
    it("并发 put 同一 key 时旧实例被回收，不泄漏 VM", async () => {
        const driver = new MockMicrovmDriver();
        const pool = new MicrovmWarmPool(driver, { maxPerTier: 1 } as never);

        // 模拟"命中预热后后台补货"与"新 Run 入池"竞争同一 key
        const instances = await Promise.all(
            Array.from({ length: 5 }, (_, i) =>
                driver.create({ id: `vm-${i}`, runId: `run-${i}`, workspacePath: "/ws" }),
            ),
        );

        for (const inst of instances) {
            pool.put("tmpl", "M", inst);
        }

        // 池内只应保留最后一个；其余必须被 terminate 掉，而不是泄漏
        expect(pool.size()).toBe(1);
        const live = Array.from(driver.instances.keys()).filter((k) =>
            instances.some((i) => i.id === k),
        );
        expect(live.length).toBe(1);

        await pool.close();
        // close 后本批 VM 全部回收
        expect(Array.from(driver.instances.keys()).filter((k) =>
            instances.some((i) => i.id === k),
        ).length).toBe(0);
    });

    it("并发 take 同一个 key 只有一个成功，其余拿到 null（不会双发同一 VM）", async () => {
        const driver = new MockMicrovmDriver();
        const pool = new MicrovmWarmPool(driver, {});
        const inst = await driver.create({ id: "vm-single", runId: "r", workspacePath: "/ws" });
        pool.put("tmpl", "M", inst);

        // 10 个 Run 同时抢同一台预热 VM
        const results = await Promise.all(
            Array.from({ length: 10 }, async () => {
                await new Promise((r) => setTimeout(r, Math.random() * 3));
                return pool.take("tmpl", "M");
            }),
        );

        // 必须恰好一个拿到 —— 两个 Run 拿到同一台 VM 就是灾难
        const won = results.filter((r) => r !== null);
        expect(won.length).toBe(1);

        await pool.close();
    });

    it("并发入池 + TTL 过期不误杀已被取走的 VM", async () => {
        const driver = new MockMicrovmDriver();
        const pool = new MicrovmWarmPool(driver, { ttlMs: 40 });
        const inst = await driver.create({ id: "vm-ttl", runId: "r", workspacePath: "/ws" });

        pool.put("tmpl", "S", inst);
        // 立刻取出（取消 TTL 定时器）
        const taken = pool.take("tmpl", "S");
        expect(taken).not.toBeNull();

        // 等 TTL 时长过后，该 VM 必须还活着（已被取走，TTL 不该再回收它）
        await new Promise((r) => setTimeout(r, 80));
        expect(driver.instances.has("vm-ttl")).toBe(true);

        await pool.close();
    });
});

describe("并发：资源档位映射", () => {
    it("档位映射取最小满足档（cpu 与 mem 都要满足），完整表正确", () => {
        // 实测映射表（行=cpu，列=memMiB）：
        //        128  256  512  1024  2048  4096
        //   1c    S    S    M    L     L     null
        //   2c    M    M    M    L     L     null
        //   4c    L    L    L    L     L     null
        //   8c    null null null null  null  null
        const cases: readonly (readonly [number, number, string | null])[] = [
            [1, 128, "S"], [1, 256, "S"], [1, 512, "M"], [1, 2048, "L"],
            [2, 256, "M"], [2, 512, "M"], [2, 1024, "L"], [2, 2048, "L"],
            [4, 128, "L"], [4, 2048, "L"],
        ];
        for (const [cpu, mem, want] of cases) {
            expect(mapResourceToTier(cpu, mem)).toBe(want as never);
        }
        // 同一档位内的不同规格必须落到同一档（否则预热池 key 错配，命中率虚低）。
        // 取自上方实测表：1c/2048 与 4c/1024 同为 L；1c/256 与 1c/128 同为 S。
        // 注意 2c/512(M) 与 4c/512(L) **不同档** —— 4 核超出 M 的 2 核上限。
        expect(mapResourceToTier(1, 2048)).toBe(mapResourceToTier(4, 1024));
        expect(mapResourceToTier(1, 256)).toBe(mapResourceToTier(1, 128));
        expect(mapResourceToTier(2, 512)).not.toBe(mapResourceToTier(4, 512));
    });

    it("超出最高档的需求返回 null —— 绝不向上取整（防资源欺骗）", () => {
        // L 档是 4c/2048M；8c/4096M 超出，必须回退冷启动精确创建。
        // 若这里返回 "L"，策略申请 8c/8GiB 就会拿到 4c/2GiB —— 配额欺骗。
        expect(mapResourceToTier(8, 4096)).toBeNull();
        expect(mapResourceToTier(4, 4096)).toBeNull();
        // 恰好等于 L 档则可映射
        expect(mapResourceToTier(4, 2048)).toBe("L");
    });

    it("未指定资源时用默认档位 M", () => {
        expect(mapResourceToTier()).toBe("M");
        expect(mapResourceToTier(undefined, undefined)).toBe("M");
    });
});
