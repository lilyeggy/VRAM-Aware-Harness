import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");

function read(relativePath: string): string {
    return readFileSync(join(repoRoot, relativePath), "utf8");
}

/**
 * 冷启动优化（O4/O5）的守卫测试。
 *
 * 这几条参数是"真机量出来才敢定"的值，容易被顺手改回去；改动必须同时更新
 * docs/vm-startup-optimizations.zh-CN.md 台账与 docs/vm-lifecycle-benchmark.zh-CN.md 数字。
 */
describe("冷启动优化（O4 rootfs 共享 / O5 预热与握手快探测）", () => {
    test("vsock 握手用短超时 + 密重试（真机证明时间由 guest 就绪决定，非超时白等）", () => {
        const bridge = read("src/sandbox/microvm/firecracker-vsock-bridge.ts");
        expect(bridge).toContain("attemptTimeoutMs = 1000");
        expect(bridge).toContain("await this.connect(attemptTimeoutMs)");
        const driver = read("src/sandbox/microvm/firecracker-sandbox-driver.ts");
        expect(driver).toContain("await vsockBridge.connectWithRetry(20000, 100, 300)");
    });

    test("消费 guest 串口：拆出 serial-first-line，避免 stdout pipe 堵死", () => {
        const driver = read("src/sandbox/microvm/firecracker-sandbox-driver.ts");
        expect(driver).toContain('proc.stdout?.on("data"');
        expect(driver).toContain('this.tracePhase(sandboxId, "serial-first-line", spawnAtMs)');
        expect(driver).toContain("private readonly serialTail = new Map<string, string>()");
    });

    test("并发冷启动区分真写快照与等闸门复用", () => {
        const driver = read("src/sandbox/microvm/firecracker-sandbox-driver.ts");
        expect(driver).toContain('this.tracePhase(options.id, "snapshot-reuse", phaseAt)');
        expect(driver).toContain("if (reusedSnapshot === false) {");
    });

    test("内核启动日志默认 quiet，可显式打开排障", () => {
        const driver = read("src/sandbox/microvm/firecracker-sandbox-driver.ts");
        expect(driver).toContain("HARNESS_VM_BOOT_VERBOSE");
        expect(driver).toContain("${COLD_START_BOOT_ARGS} quiet loglevel=3 printk.time=1");
    });

    test("预热脚本幂等、以 broker 同套环境算出同一个 templateHash", () => {
        const scriptPath = "scripts/vm-snapshot-prewarm.ts";
        expect(existsSync(join(repoRoot, scriptPath))).toBe(true);
        const script = read(scriptPath);
        expect(script).toContain("computeTemplateHash(kernelPath, rootfsPath, guestAgentVersion)");
        expect(script).toContain("manager.hasSnapshot(templateHash) && force === false");
        expect(script).toContain("VM_PREWARM_SKIP");
        expect(script).toContain("VM_PREWARM_OK");
        expect(script).toContain("VM_PREWARM_FAIL");
        expect(script).toContain("FIRECRACKER_KERNEL_PATH");
        expect(script).toContain("HARNESS_VM_SNAPSHOT_POOL_DIR");
        expect(script).toContain("HARNESS_USE_JAILER");
    });

    test("部署示例：开机预热单元与 broker 同环境、禁用网络出站", () => {
        const service = read("deploy/harness-vm-prewarm.service.example");
        expect(service).toContain("EnvironmentFile=/etc/harness/broker.env");
        expect(service).toContain("IPAddressDeny=any");
        expect(service).toContain("scripts/vm-snapshot-prewarm.ts");
        const timer = read("deploy/harness-vm-prewarm.timer.example");
        expect(timer).toContain("OnBootSec=20s");
        expect(timer).toContain("Unit=harness-vm-prewarm.service");
        // 必须用 OnCalendar：OnUnitActiveSec 对 oneshot 服务算不出下次触发（list-timers 显示 n/a）
        expect(timer).toContain("OnCalendar=hourly");
        // 该文件里 OnUnitActiveSec 只应出现在解释"为什么用它"的注释里
        expect(timer).toContain("用 OnCalendar 而不是 OnUnitActiveSec");
    });

    test("guest 镜像为只读 rootfs 准备 tmpfs（/tmp /run /var/tmp）", () => {
        const build = read("scripts/microvm/build-guest-rootfs.sh");
        expect(build).toContain("mount -t tmpfs -o mode=1777,size=64m tmpfs /tmp");
        expect(build).toContain("mount -t tmpfs -o mode=755,size=16m tmpfs /run");
        expect(build).toContain("mount -t tmpfs -o mode=1777,size=32m tmpfs /var/tmp");
    });

    test("存量镜像可原地补 tmpfs 补丁（幂等 + 先备份）", () => {
        const script = read("scripts/microvm/patch-guest-rootfs-tmpfs.sh");
        expect(script).toContain("PATCH_TMPFS_SKIP");
        expect(script).toContain("PATCH_TMPFS_OK");
        expect(script).toContain('cp -a "$IMAGE" "$IMAGE.bak-tmpfs"');
        expect(script).toContain("mount -t tmpfs -o mode=1777,size=64m tmpfs /tmp");
        expect(script).toContain('debugfs -w -R "write $WORK/inittab /etc/inittab"');
    });

    test("优化台账存在且保留了记录规则与可回退信息", () => {
        const ledger = read("docs/vm-startup-optimizations.zh-CN.md");
        expect(ledger).toContain("O1");
        expect(ledger).toContain("O2");
        expect(ledger).toContain("O3");
        expect(ledger).toContain("HARNESS_VM_SHARE_BASE_FILES");
        expect(ledger).toContain("HARNESS_VM_BOOT_VERBOSE");
        expect(ledger).toContain("回退");
    });
});
