import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const driver = readFileSync("src/sandbox/microvm/firecracker-sandbox-driver.ts", "utf8");
const shared = readFileSync("src/sandbox/microvm/shared-base-files.ts", "utf8");
const manager = readFileSync("src/sandbox/microvm/vm-snapshot-manager.ts", "utf8");

describe("共享只读基础文件接线（§9.8 维护：启动路径优化）", () => {
    test("内核/rootfs/快照文件走 shareBaseFile，而不是逐 VM 复制", () => {
        expect(driver).toContain("HARNESS_VM_SHARE_BASE_FILES");
        expect(driver).toContain("HARNESS_VM_SHARE_ROOTFS");
        // 基础文件共享默认开、rootfs 共享默认关（RO rootfs 会改 guest 语义）
        expect(driver).toContain('process.env.HARNESS_VM_SHARE_BASE_FILES !== "0"');
        expect(driver).toContain('process.env.HARNESS_VM_SHARE_ROOTFS === "1"');
        expect(driver).toContain("shareBaseFile(");
        // 三个共享点位：kernel.bin / rootfs.ext4 / restore.snap + restore.mem
        expect(driver).toContain('resolve(chrootRoot, "kernel.bin")');
        expect(driver).toContain('resolve(chrootRoot, "rootfs.ext4")');
        expect(driver).toContain('resolve(chrootRootForVm, "restore.snap")');
        expect(driver).toContain('resolve(chrootRootForVm, "restore.mem")');
        expect(driver).toContain('"share-base"');
        expect(driver).toContain('"share-snapshot"');
        // 旧路径仍然保留（可用 env 关闭共享）
        expect(driver).toContain('"copy-snapshot"');
        expect(driver).toContain('"copy-disks"');
    });

    test("共享 rootfs 必须以只读盘挂给 guest，且发布快照不原地截断", () => {
        expect(driver).toContain("is_read_only: sharedRootfsReadOnly");
        // RO 标志跟随"是否请求共享"，不跟随硬链接结果：
        // shareBaseFile 无论 linked 还是 copied 都会 chmod 0444，
        // 若此时盘仍以 O_RDWR 打开，降权后的 Firecracker 会 EACCES。
        expect(driver).toContain("sharedRootfsReadOnly = this.shareRootfs;");
        expect(driver.includes('sharedRootfsReadOnly = rootfsShare === "linked"')).toBe(false);
        expect(driver).toContain("O_RDWR");
        expect(driver).toContain("publishStaging(templateHash, stagingDir)");
        expect(driver).toContain("discardStaging(stagingDir)");
        expect(driver).toContain("createStagingDir(templateHash)");
        // 绝不能再出现"把 chroot 内快照 cp 覆盖池内路径"的写法。
        // 现在改为硬链接进 staging（O7）：同 inode、零拷贝，跨设备才退回复制。
        expect(driver).toContain("await shareBaseFile(snapInChroot, stagingPaths.snapshotPath, {");
        expect(driver.includes("copyFileReflink(snapInChroot, poolPaths.snapshotPath)")).toBe(false);
        expect(driver.includes("copyFileReflink(memInChroot, poolPaths.memFilePath)")).toBe(false);
    });

    test("共享语义有明确文档依据：MAP_PRIVATE 只读映射 + 文件不可变", () => {
        expect(shared).toContain("MAP_PRIVATE");
        expect(shared).toContain("sharing of memory pages and read only disks");
        expect(shared).toContain("must be considered immutable");
        expect(shared).toContain("SHARED_BASE_FILE_MODE = 0o444");
        // 0444 只给驱动自有的快照文件；模板不传 mode，避免硬链接改掉模板权限。
        // 4 处：加载快照 1（share-snapshot）+ rootfs 1 + 制作快照后硬链接进 staging 2
        // （snapInChroot / memInChroot，O7）
        expect(driver.match(/mode: SHARED_BASE_FILE_MODE/g)?.length).toBe(4);
        expect(manager).toContain("createStagingDir");
        expect(manager).toContain("renameSync(stagingDir, finalDir)");
    });
});
