import { describe, it, expect } from "bun:test";
import { FirecrackerSandboxDriver } from "../../src/sandbox/microvm/firecracker-sandbox-driver";

/**
 * 快照模式安全门禁回归。
 *
 * 真机复现（172.17.43.193，非 jailer + HARNESS_VM_SNAPSHOTS_ENABLED=true）：
 * snapshot/load 恢复出的 10 台 VM 并未使用各自 run 目录里的 workspace.ext4，
 * 而是全部使用 vm.snap 中固化的黄金 VM 宿主绝对路径，导致跨租户写入共享同一
 * 工作区磁盘，terminate 导出只有 0/10。jailer 模式因每个 VM 拥有独立 chroot
 * 与 mount namespace，仍可用 /workspace.ext4 保持隔离。
 */
describe("Firecracker 快照模式门禁", () => {
    it("非 jailer + snapshotsEnabled=true 必须 fail-closed", () => {
        expect(() => new FirecrackerSandboxDriver({
            useJailer: false,
            snapshotsEnabled: true,
        })).toThrow(/非 jailer 模式不允许启用 microVM 快照加速/);
    });

    it("非 jailer + snapshotsEnabled=false 可以构造", () => {
        expect(() => new FirecrackerSandboxDriver({
            useJailer: false,
            snapshotsEnabled: false,
        })).not.toThrow();
    });

    it("jailer + snapshotsEnabled=true 可以构造", () => {
        expect(() => new FirecrackerSandboxDriver({
            useJailer: true,
            snapshotsEnabled: true,
        })).not.toThrow();
    });
});
