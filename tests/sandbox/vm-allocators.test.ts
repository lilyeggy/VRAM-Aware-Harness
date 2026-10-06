import { describe, it, expect } from "bun:test";
import { VmUidAllocator } from "../../src/sandbox/microvm/vm-uid-allocator";
import { VmCidAllocator } from "../../src/sandbox/microvm/vm-cid-allocator";

describe("VmUidAllocator", () => {
    it("UID/GID 分配唯一性与基本范围 (base 20000)", () => {
        const allocator = new VmUidAllocator(20000, 20005);
        const u1 = allocator.allocate("vm-1");
        const u2 = allocator.allocate("vm-2");

        expect(u1.uid).toBe(20000);
        expect(u1.gid).toBe(20000);
        expect(u2.uid).toBe(20001);
        expect(u2.gid).toBe(20001);

        // 同一个 vmId 多次获取返回相同分配
        expect(allocator.allocate("vm-1")).toEqual(u1);
    });

    it("释放后可复用", () => {
        const allocator = new VmUidAllocator(20000, 20005);
        const u1 = allocator.allocate("vm-1");
        const u2 = allocator.allocate("vm-2");
        expect(u1.uid).toBe(20000);
        expect(u2.uid).toBe(20001);

        allocator.release("vm-1");
        // 下一次分配优先复用释放出来的最小未用值
        const u3 = allocator.allocate("vm-3");
        expect(u3.uid).toBe(20000);
        expect(u3.gid).toBe(20000);
    });

    it("耗尽抛错", () => {
        const allocator = new VmUidAllocator(20000, 20001);
        allocator.allocate("vm-1");
        allocator.allocate("vm-2");
        expect(() => allocator.allocate("vm-3")).toThrow(/UID pool exhausted/);
    });

    it("baseUid 非法校验 (< 1000 拒绝)", () => {
        expect(() => new VmUidAllocator(999)).toThrow(/baseUid must be >= 1000/);
    });
});

describe("VmCidAllocator", () => {
    it("CID 分配唯一性与基本范围 (base 3, 保留 0-2)", () => {
        const allocator = new VmCidAllocator(3, 5);
        const c1 = allocator.allocate("vm-1");
        const c2 = allocator.allocate("vm-2");

        expect(c1).toBe(3);
        expect(c2).toBe(4);
        expect(allocator.allocate("vm-1")).toBe(3);
    });

    it("释放后可复用", () => {
        const allocator = new VmCidAllocator(3, 5);
        allocator.allocate("vm-1");
        allocator.allocate("vm-2");

        allocator.release("vm-1");
        const c3 = allocator.allocate("vm-3");
        expect(c3).toBe(3);
    });

    it("耗尽抛错", () => {
        const allocator = new VmCidAllocator(3, 4);
        allocator.allocate("vm-1");
        allocator.allocate("vm-2");
        expect(() => allocator.allocate("vm-3")).toThrow(/CID pool exhausted/);
    });

    it("baseCid < 3 拒绝", () => {
        expect(() => new VmCidAllocator(2)).toThrow(/baseCid must be >= 3/);
    });
});
