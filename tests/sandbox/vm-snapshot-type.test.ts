import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..", "..");
const read = (relative: string): string => readFileSync(resolve(repoRoot, relative), "utf8");

describe("快照类型旋钮（Full / Diff）与冷启动归因台账（O8）", () => {
    it("/snapshot/create 的 snapshot_type 跟随配置，默认 Full、Diff 需显式开启", () => {
        const driver = read("src/sandbox/microvm/firecracker-sandbox-driver.ts");
        expect(driver).toContain("snapshot_type: this.snapshotType");
        expect(driver).toContain('readonly snapshotType?: "Full" | "Diff";');
        expect(driver).toContain(
            '(process.env.HARNESS_VM_SNAPSHOT_TYPE === "Diff" ? "Diff" : "Full")',
        );
    });

    it("vsock 握手保持 100ms 间隔 / 300ms 单次超时（密集重试会在 guest 里引发 agent 进程风暴）", () => {
        const driver = read("src/sandbox/microvm/firecracker-sandbox-driver.ts");
        expect(driver).toContain("await vsockBridge.connectWithRetry(20000, 100, 300);");
    });

    it("台账 O8 记录实测数字与被否证的结论", () => {
        const ledger = read("docs/vm-startup-optimizations.zh-CN.md");
        // 静态应答器 vs 96MB Bun agent 的对照（同一套参数）
        expect(ledger).toContain("208~228ms");
        expect(ledger).toContain("96,352,640");
        // Diff 快照实测：稀疏化与恢复可用性
        expect(ledger).toContain("74.6MiB");
        expect(ledger).toContain("1301 → 1140ms");
        expect(ledger).toContain("5/5 次恢复 + exec 探针全部成功");
        // 被否证的两条旧归因
        expect(ledger).toContain("socat 启动占 340ms");
        expect(ledger).toContain("229~653ms");
    });

    it(".env.example 说明 Diff 旋钮", () => {
        const env = read(".env.example");
        expect(env).toContain("HARNESS_VM_SNAPSHOT_TYPE");
    });
});
