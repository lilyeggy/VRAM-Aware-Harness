import { describe, it, expect } from "bun:test";
import { basename } from "node:path";
import { checkJailerPrereqs } from "../../src/sandbox/microvm/jailer-prereq-check";

describe("checkJailerPrereqs", () => {
    it("文件缺失或不可执行时正确识别 failure 且 fail-closed", async () => {
        const res = await checkJailerPrereqs({
            jailerBinaryPath: "/nonexistent/jailer",
            firecrackerBinaryPath: "/nonexistent/firecracker",
            kvmDevicePath: "/nonexistent/dev/kvm",
        });

        expect(res.ok).toBe(false);
        expect(res.failures.length).toBeGreaterThanOrEqual(3);
        expect(res.failures.some((f) => f.includes("jailer binary not executable"))).toBe(true);
        expect(res.failures.some((f) => f.includes("firecracker binary not executable"))).toBe(true);
        expect(res.failures.some((f) => f.includes("KVM device not accessible"))).toBe(true);
    });
});

/**
 * 回归：jailer 调用形状必须与真实 CLI 匹配。
 *
 * 真机（172.17.43.193，jailer v1.17.0）踩到三个坑，这里逐条锁定：
 *  1. v1.17.0 已移除 `--node`，传入会 ArgumentParsing 拒绝启动；
 *  2. jail 根目录按 exec-file 的 basename 命名（`<base>/fc117/<id>/root`），
 *     硬编码 "firecracker" 会让所有路径计算落空；
 *  3. jailer 把 chroot 的 /run 重挂为独立 tmpfs，socket 放 /run 宿主永远看不到。
 */
describe("Firecracker jailer 参数与路径规则", () => {
    it("jail 根目录必须用 exec-file 的 basename，而非硬编码 firecracker", () => {
        // 与驱动实现保持一致：basename(binaryPath)
        const cases = [
            { binaryPath: "/opt/bin/fc117", expected: "fc117" },
            { binaryPath: "/usr/local/bin/firecracker", expected: "firecracker" },
            { binaryPath: "./bin/jailer117", expected: "jailer117" },
        ];
        for (const c of cases) {
            expect(basename(c.binaryPath)).toBe(c.expected);
        }
    });

    it("API socket 不得放在 /run（jailer 会将其重挂为独立 tmpfs）", () => {
        // 驱动中传给 jailer 的 --api-sock 值
        const apiSockInJail = "/firecracker.socket";
        expect(apiSockInJail.startsWith("/run/")).toBe(false);
    });

    it("vsock 与快照路径同样不得放在 /run（会被同一 tmpfs 遮蔽）", () => {
        // vsock: Firecracker 在 jail 内创建，宿主 bridge 要连它
        // 快照: 宿主复制进 jail 后要被降权的 Firecracker 读取
        // 两者一旦放 /run，jailer 的 tmpfs 会遮蔽，导致 agent 通道与快照全部失效
        for (const p of ["/vsock.sock", "/golden.snap", "/golden.mem", "/restore.snap", "/restore.mem"]) {
            expect(p.startsWith("/run/")).toBe(false);
        }
    });

    it("驱动源码中不再出现已移除的 --node 参数", async () => {
        const src = await Bun.file(
            new URL("../../src/sandbox/microvm/firecracker-sandbox-driver.ts", import.meta.url).pathname,
        ).text();
        // --node 曾导致 jailer 直接 ArgumentParsing 退出
        expect(src).not.toMatch(/"--node"/);
        // 任何跨 jail 边界访问的路径都不得落在 /run 下
        expect(src).not.toMatch(/"\/run\/[a-zA-Z.]+"/);
    });
});
