import { expect, test } from "bun:test";
import { LazySandboxLease } from "../../src/sandbox/lazy-sandbox-lease.ts";
import type { SandboxHandle } from "../../src/sandbox/sandbox-provider.ts";

const handle = { id: "sandbox" } as SandboxHandle;

test("没有工具申请时不创建 VM", async () => {
    let acquired = 0; let released = 0;
    const lease = new LazySandboxLease(async () => { acquired++; return handle; }, async () => { released++; });
    await lease.close();
    expect([acquired, released]).toEqual([0, 0]);
    await expect(lease.getOrCreate()).rejects.toThrow("已结束");
});

test("并发首次申请共享一次创建，后续工具复用，结束只释放一次", async () => {
    let acquired = 0; let released = 0;
    let ready!: (handle: SandboxHandle) => void;
    const deferred = new Promise<SandboxHandle>((resolve) => { ready = resolve; });
    const lease = new LazySandboxLease(async () => { acquired++; return deferred; }, async () => { released++; });
    const first = lease.getOrCreate(); const second = lease.getOrCreate();
    ready(handle);
    expect(await Promise.all([first, second])).toEqual([handle, handle]);
    expect(await lease.getOrCreate()).toBe(handle);
    await Promise.all([lease.close(), lease.close()]);
    expect([acquired, released]).toEqual([1, 1]);
});

test("创建过程中结束 Run，等待创建完成并回收，不能继续执行工具", async () => {
    let ready!: (handle: SandboxHandle) => void; let released = 0;
    const deferred = new Promise<SandboxHandle>((resolve) => { ready = resolve; });
    const lease = new LazySandboxLease(async () => deferred, async () => { released++; });
    const request = lease.getOrCreate(); const closing = lease.close();
    ready(handle);
    await expect(request).rejects.toThrow("创建期间 Run 已结束");
    await closing;
    expect(released).toBe(1);
});

test("创建失败不会回退执行；显式再次申请时可以重试", async () => {
    let count = 0;
    const lease = new LazySandboxLease(async () => { if (++count === 1) throw new Error("unavailable"); return handle; }, async () => {});
    await expect(lease.getOrCreate()).rejects.toThrow("unavailable");
    expect(await lease.getOrCreate()).toBe(handle);
    await lease.close();
});
