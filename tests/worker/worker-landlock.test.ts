import { describe, expect, test } from "bun:test";
import {
    applyWorkerLandlock,
    computeHandledAccessMask,
    defaultWritableFiles,
    defaultWritablePaths,
    resolveWorkerLandlockMode,
} from "../../src/worker/worker-landlock.ts";

describe("worker-landlock", () => {
    test("computeHandledAccessMask 按 ABI 递增掩码", () => {
        expect(computeHandledAccessMask(1)).toBe((1n << 13n) - 1n);
        expect(computeHandledAccessMask(2)).toBe(((1n << 13n) - 1n) | (1n << 13n));
        expect(computeHandledAccessMask(3)).toBe(((1n << 14n) - 1n) | (1n << 14n));
        expect(computeHandledAccessMask(5)).toBe(((1n << 15n) - 1n) | (1n << 15n));
        // ABI 4 没有 IOCTL_DEV（bit 15），与 ABI 3 相同。
        expect(computeHandledAccessMask(4)).toBe(computeHandledAccessMask(3));
    });

    test("resolveWorkerLandlockMode 解析开关", () => {
        expect(resolveWorkerLandlockMode({})).toBe("off");
        expect(resolveWorkerLandlockMode({ HARNESS_WORKER_LANDLOCK: "0" })).toBe("off");
        expect(resolveWorkerLandlockMode({ HARNESS_WORKER_LANDLOCK: "false" })).toBe("off");
        expect(resolveWorkerLandlockMode({ HARNESS_WORKER_LANDLOCK: "1" })).toBe("on");
        expect(resolveWorkerLandlockMode({ HARNESS_WORKER_LANDLOCK: "true" })).toBe("on");
        expect(resolveWorkerLandlockMode({ HARNESS_WORKER_LANDLOCK: "required" })).toBe("required");
        expect(resolveWorkerLandlockMode({ HARNESS_WORKER_LANDLOCK: " REQUIRED " })).toBe("required");
    });

    test("defaultWritablePaths 包含 TMPDIR、HOME、Broker 目录与显式配置", () => {
        const paths = defaultWritablePaths({
            HOME: "/var/lib/harness-worker",
            HARNESS_WORKER_LANDLOCK_WRITABLE_PATHS: "/srv/data, /var/cache/harness-worker",
        });
        expect(paths).toContain("/tmp");
        expect(paths).toContain("/var/lib/harness-worker");
        expect(paths).toContain("/run/harness");
        expect(paths).toContain("/srv/data");
        expect(paths).toContain("/var/cache/harness-worker");
    });

    test("defaultWritableFiles 包含常见设备文件", () => {
        const files = defaultWritableFiles();
        expect(files).toContain("/dev/null");
        expect(files).toContain("/dev/urandom");
    });

    test("mode=off 时不应用且不触碰系统", () => {
        const result = applyWorkerLandlock({ mode: "off" });
        expect(result.applied).toBe(false);
        expect(result.reason).toBe("disabled");
    });

    test("非 Linux 上 mode=on 返回不可用", () => {
        if (process.platform === "linux") {
            return;
        }
        const result = applyWorkerLandlock({ mode: "on" });
        expect(result.applied).toBe(false);
        expect(result.reason).toContain("非 Linux");
    });
});
