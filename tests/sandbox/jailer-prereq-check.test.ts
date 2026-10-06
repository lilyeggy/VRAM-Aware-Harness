import { describe, it, expect } from "bun:test";
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
