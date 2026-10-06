import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { VmSnapshotManager } from "../../src/sandbox/microvm/vm-snapshot-manager";
import { MicrovmWarmPool, mapResourceToTier } from "../../src/sandbox/microvm/microvm-warm-pool";
import { MockMicrovmDriver } from "../../src/sandbox/microvm/mock-microvm-driver";

describe("VmSnapshotManager", () => {
    const testPoolDir = resolve(process.cwd(), "data/test-snapshots");
    const kernelFile = join(testPoolDir, "kernel.bin");
    const rootfsFile = join(testPoolDir, "rootfs.ext4");

    beforeEach(() => {
        rmSync(testPoolDir, { recursive: true, force: true });
        mkdirSync(testPoolDir, { recursive: true });
        writeFileSync(kernelFile, "mock-kernel-v1");
        writeFileSync(rootfsFile, "mock-rootfs-v1");
    });

    afterEach(() => {
        rmSync(testPoolDir, { recursive: true, force: true });
    });

    it("计算模板哈希并在 agent 版本或镜像变更时自动失效", () => {
        const mgr = new VmSnapshotManager({ snapshotPoolDir: testPoolDir });

        const hash1 = mgr.computeTemplateHash(kernelFile, rootfsFile, "1.0.0");
        const hash2 = mgr.computeTemplateHash(kernelFile, rootfsFile, "1.0.0");
        expect(hash1).toBe(hash2);

        // agent 版本变化
        const hashVersionChanged = mgr.computeTemplateHash(kernelFile, rootfsFile, "1.0.1");
        expect(hashVersionChanged).not.toBe(hash1);

        // 镜像内容更新
        writeFileSync(rootfsFile, "mock-rootfs-v2-updated");
        const hashContentChanged = mgr.computeTemplateHash(kernelFile, rootfsFile, "1.0.0");
        expect(hashContentChanged).not.toBe(hash1);
    });

    it("管理快照目录、检查存在性并在 invalidate 时清理", () => {
        const mgr = new VmSnapshotManager({ snapshotPoolDir: testPoolDir });
        const hash = "test-hash-123";

        expect(mgr.hasSnapshot(hash)).toBe(false);

        mgr.ensureDir(hash);
        const paths = mgr.getSnapshotPaths(hash);
        writeFileSync(paths.snapshotPath, "mock-snap");
        writeFileSync(paths.memFilePath, "mock-mem");

        expect(mgr.hasSnapshot(hash)).toBe(true);

        mgr.invalidate(hash);
        expect(mgr.hasSnapshot(hash)).toBe(false);
    });
});

describe("MicrovmWarmPool", () => {
    it("mapResourceToTier 分档映射准确 (S/M/L)", () => {
        expect(mapResourceToTier(1, 256)).toBe("S");
        expect(mapResourceToTier(2, 512)).toBe("M");
        expect(mapResourceToTier(1, 512)).toBe("M");
        expect(mapResourceToTier(4, 2048)).toBe("L");
        expect(mapResourceToTier(8, 4096)).toBe("L");
    });

    it("预热入池、出池与 TTL 自动回收", async () => {
        const driver = new MockMicrovmDriver();
        const pool = new MicrovmWarmPool(driver, { ttlMs: 50 }); // 短 TTL 用于测试

        const inst1 = await driver.create({
            id: "vm-warm-1",
            runId: "run-w1",
            workspacePath: "/workspace",
        });

        pool.put("tmpl-hash-a", "S", inst1);
        expect(pool.has("tmpl-hash-a", "S")).toBe(true);
        expect(pool.size()).toBe(1);

        // 命中取出
        const taken = pool.take("tmpl-hash-a", "S");
        expect(taken).not.toBeNull();
        expect(taken?.instance.id).toBe("vm-warm-1");
        expect(pool.size()).toBe(0);

        // 再次取出应为空
        expect(pool.take("tmpl-hash-a", "S")).toBeNull();

        // 验证 TTL 回收
        const inst2 = await driver.create({
            id: "vm-warm-2",
            runId: "run-w2",
            workspacePath: "/workspace",
        });
        pool.put("tmpl-hash-b", "M", inst2);
        expect(pool.has("tmpl-hash-b", "M")).toBe(true);

        // 等待 TTL 触发
        await new Promise((r) => setTimeout(r, 70));
        expect(pool.has("tmpl-hash-b", "M")).toBe(false);
        expect(driver.instances.has("vm-warm-2")).toBe(false);

        await pool.close();
    });
});

/**
 * 协议级回归：pause/resume 必须走官方 `PATCH /vm {"state":...}`。
 *
 * 背景：Firecracker 官方从未提供 `InstancePause`/`InstanceResume` 动作
 * （swagger 的 InstanceActionInfo 枚举只有 FlushMetrics / InstanceStart /
 * SendCtrlAltDel），真机实测该请求返回
 * 400 unknown variant `InstancePause`。这里用真实 Unix socket 断言
 * 请求方法与路径，防止回退到已失效的旧 API。
 */
describe("VmSnapshotManager pause/resume 协议", () => {
    const sockDir = resolve(process.cwd(), "data/test-snap-sock");
    const sockPath = join(sockDir, "api.sock");
    const testPoolDir = resolve(process.cwd(), "data/test-snap-pool");
    let server: import("node:net").Server;
    let calls: Array<{ method: string; path: string; body: unknown }> = [];

    beforeEach(async () => {
        rmSync(sockDir, { recursive: true, force: true });
        rmSync(testPoolDir, { recursive: true, force: true });
        mkdirSync(sockDir, { recursive: true });
        mkdirSync(testPoolDir, { recursive: true });
        calls = [];

        const net = await import("node:net");
        server = net.createServer((conn) => {
            let buf = "";
            conn.on("data", (chunk) => {
                buf += chunk.toString();
                const idx = buf.indexOf("\r\n\r\n");
                if (idx < 0) return;
                const head = buf.slice(0, idx);
                const reqLine = head.split("\r\n")[0] ?? "";
                const method = reqLine.split(" ")[0] ?? "";
                const rawPath = reqLine.split(" ")[1] ?? "";
                const path = rawPath.replace(/^https?:\/\/[^/]+/, "");
                const m = /content-length:\s*(\d+)/i.exec(head);
                const need = Number(m?.[1] ?? 0);
                const bodyStart = idx + 4;
                if (buf.length < bodyStart + need) return;
                const raw = buf.slice(bodyStart, bodyStart + need);
                let parsed: unknown = raw;
                try { parsed = JSON.parse(raw); } catch { /* keep raw */ }
                calls.push({ method, path, body: parsed });
                conn.end("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            });
        });
        await new Promise<void>((r) => server.listen(sockPath, r));
    });

    afterEach(async () => {
        await new Promise<void>((r) => server.close(() => r()));
        rmSync(sockDir, { recursive: true, force: true });
        rmSync(testPoolDir, { recursive: true, force: true });
    });

    it("createSnapshot 使用 PATCH /vm Paused + PUT /snapshot/create + PATCH /vm Resumed", async () => {
        const mgr = new VmSnapshotManager({ snapshotPoolDir: testPoolDir });
        const hash = "proto-hash";
        const paths = await mgr.createSnapshot(sockPath, hash);

        expect(paths.snapshotPath).toBe(join(testPoolDir, hash, "vm.snap"));
        expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
            "PATCH /vm",
            "PUT /snapshot/create",
            "PATCH /vm",
        ]);
        expect(calls[0]?.body).toEqual({ state: "Paused" });
        expect(calls[1]?.body).toMatchObject({ snapshot_type: "Full" });
        expect(calls[2]?.body).toEqual({ state: "Resumed" });
    });

    it("快照创建失败时仍恢复 vCPU，避免 VM 卡在 Paused", async () => {
        // 让 /snapshot/create 返回 500
        const net = await import("node:net");
        await new Promise<void>((r) => server.close(() => r()));
        server = net.createServer((conn) => {
            let buf = "";
            conn.on("data", (chunk) => {
                buf += chunk.toString();
                const idx = buf.indexOf("\r\n\r\n");
                if (idx < 0) return;
                const head = buf.slice(0, idx);
                const reqLine = head.split("\r\n")[0] ?? "";
                const method = reqLine.split(" ")[0] ?? "";
                const rawPath = reqLine.split(" ")[1] ?? "";
                const path = rawPath.replace(/^https?:\/\/[^/]+/, "");
                const m = /content-length:\s*(\d+)/i.exec(head);
                const need = Number(m?.[1] ?? 0);
                const bodyStart = idx + 4;
                if (buf.length < bodyStart + need) return;
                calls.push({ method, path, body: JSON.parse(buf.slice(bodyStart, bodyStart + need)) });
                if (path === "/snapshot/create") {
                    const msg = JSON.stringify({ fault_message: "boom" });
                    conn.end(`HTTP/1.1 500 Internal Server Error\r\nContent-Length: ${msg.length}\r\nConnection: close\r\n\r\n${msg}`);
                } else {
                    conn.end("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                }
            });
        });
        await new Promise<void>((r) => server.listen(sockPath, r));

        const mgr = new VmSnapshotManager({ snapshotPoolDir: testPoolDir });
        await expect(mgr.createSnapshot(sockPath, "fail-hash")).rejects.toThrow();

        // 关键：失败后必须有 PATCH /vm Resumed
        expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
            "PATCH /vm",
            "PUT /snapshot/create",
            "PATCH /vm",
        ]);
        expect(calls[2]?.body).toEqual({ state: "Resumed" });
    });

    it("loadSnapshot 使用 PUT /snapshot/load 且依赖 resume_vm 自恢复", async () => {
        const mgr = new VmSnapshotManager({ snapshotPoolDir: testPoolDir });
        const hash = "load-hash";
        mgr.ensureDir(hash);
        const p = mgr.getSnapshotPaths(hash);
        writeFileSync(p.snapshotPath, "snap");
        writeFileSync(p.memFilePath, "mem");

        await mgr.loadSnapshot(sockPath, hash);

        expect(calls).toHaveLength(1);
        expect(calls[0]?.method).toBe("PUT");
        expect(calls[0]?.path).toBe("/snapshot/load");
        expect(calls[0]?.body).toMatchObject({ resume_vm: true, enable_diff_snapshots: false });
    });
});
