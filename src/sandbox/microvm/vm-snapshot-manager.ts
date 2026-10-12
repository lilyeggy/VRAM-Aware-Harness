import { existsSync, mkdirSync, chmodSync, renameSync, rmSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import * as http from "node:http";

export interface VmSnapshotPaths {
    readonly snapshotPath: string;
    readonly memFilePath: string;
}

export interface VmSnapshotManagerConfig {
    readonly snapshotPoolDir?: string;
}

export class VmSnapshotManager {
    private readonly poolDir: string;

    constructor(config: VmSnapshotManagerConfig = {}) {
        this.poolDir = config.snapshotPoolDir
            ?? process.env.HARNESS_VM_SNAPSHOT_POOL_DIR
            ?? "/var/lib/harness/snapshots";
    }

    /**
     * 计算模板哈希: sha256(kernelStat + rootfsStat + agentVersion)。
     *
     * agentVersion 必须**显式传入**。此前它是一个会被静默使用的默认参数，
     * 结果是改动 guest agent 却忘记同步版本号时，模板指纹不变、静默复用
     * 含旧 agent 的黄金快照（guest 里跑的是旧代码）。删掉默认值让每个
     * 调用点都必须表明自己的 agent 版本。
     */
    computeTemplateHash(kernelPath: string, rootfsPath: string, agentVersion: string): string {
        const hash = createHash("sha256");
        try {
            if (existsSync(kernelPath)) {
                const st = statSync(kernelPath);
                hash.update(`kernel:${kernelPath}:${st.size}:${st.mtimeMs}`);
            }
            if (existsSync(rootfsPath)) {
                const st = statSync(rootfsPath);
                hash.update(`rootfs:${rootfsPath}:${st.size}:${st.mtimeMs}`);
            }
        } catch {
            hash.update(`fallback:${kernelPath}:${rootfsPath}`);
        }
        hash.update(`agent:${agentVersion}`);
        return hash.digest("hex");
    }

    getSnapshotPaths(templateHash: string): VmSnapshotPaths {
        const dir = resolve(this.poolDir, templateHash);
        return {
            snapshotPath: join(dir, "vm.snap"),
            memFilePath: join(dir, "mem.snap"),
        };
    }

    hasSnapshot(templateHash: string): boolean {
        const paths = this.getSnapshotPaths(templateHash);
        return existsSync(paths.snapshotPath) && existsSync(paths.memFilePath);
    }

    ensureDir(templateHash: string): string {
        const dir = resolve(this.poolDir, templateHash);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        chmodSync(dir, 0o700);
        return dir;
    }

    /**
     * 快照发布用的 staging 目录（同池内父目录，保证 rename 不跨设备）。
     *
     * 为什么不能直接写池内最终路径：共享只读模式下，运行中的 VM 用硬链接
     * 引用池内 mem.snap，Firecracker 以 MAP_PRIVATE 映射它，官方要求该文件
     * 对 Firecracker 与宿主都不可变。若新快照直接覆盖同一 inode（cp 会截断），
     * 等于在 VM 运行期间改它的内存文件 → guest 内存损坏。
     * 因此先写 staging，成功后 rename 目录项：运行中的 VM 继续持有旧 inode，
     * 内容不受影响；新 VM 看到完整的新快照。
     */
    createStagingDir(templateHash: string): string {
        const dir = resolve(
            this.poolDir,
            `${templateHash}.staging-${process.pid}-${randomBytes(4).toString("hex")}`,
        );
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        chmodSync(dir, 0o700);
        return dir;
    }

    stagingSnapshotPaths(stagingDir: string): VmSnapshotPaths {
        return {
            snapshotPath: join(stagingDir, "vm.snap"),
            memFilePath: join(stagingDir, "mem.snap"),
        };
    }

    /** 把 staging 目录原子发布为最终快照目录；缺文件时拒绝发布。 */
    publishStaging(templateHash: string, stagingDir: string): void {
        const staged = this.stagingSnapshotPaths(stagingDir);
        if (existsSync(staged.snapshotPath) === false || existsSync(staged.memFilePath) === false) {
            throw new Error(`staging 目录缺少快照文件，拒绝发布：${stagingDir}`);
        }
        const finalDir = resolve(this.poolDir, templateHash);
        // 只 unlink 旧目录项：正在运行的 VM 通过硬链接仍持有旧 inode。
        rmSync(finalDir, { recursive: true, force: true });
        renameSync(stagingDir, finalDir);
    }

    discardStaging(stagingDir: string): void {
        rmSync(stagingDir, { recursive: true, force: true });
    }

    invalidate(templateHash: string): void {
        const dir = resolve(this.poolDir, templateHash);
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch {
            // best-effort
        }
    }

    /**
     * 发送 Firecracker API 请求:
     * 1. PATCH /vm { state: "Paused" } (先暂停 vCPU)
     * 2. PUT /snapshot/create { snapshot_type: "Full", snapshot_path, mem_file_path }
     * 3. PATCH /vm { state: "Resumed" } (创建完成后恢复)
     *
     * 注意: Firecracker 官方 API 从未提供 `InstancePause`/`InstanceResume` 动作
     * (见 v1.16/v1.17 swagger 的 InstanceActionInfo 枚举，仅含
     * FlushMetrics/InstanceStart/SendCtrlAltDel)。暂停/恢复的唯一官方途径是
     * `PATCH /vm` 携带 `{"state":"Paused"|"Resumed"}`。
     */
    async createSnapshot(
        apiSocketPath: string,
        templateHash: string,
    ): Promise<VmSnapshotPaths> {
        this.ensureDir(templateHash);
        const paths = this.getSnapshotPaths(templateHash);

        // 1. 暂停 vCPU（官方途径: PATCH /vm）
        await this.requestSocket(apiSocketPath, "/vm", { state: "Paused" }, "PATCH");

        try {
            // 2. 创建全量快照
            await this.requestSocket(apiSocketPath, "/snapshot/create", {
                snapshot_type: "Full",
                snapshot_path: paths.snapshotPath,
                mem_file_path: paths.memFilePath,
            }, "PUT");
        } catch (err) {
            // 快照失败时必须恢复 vCPU，否则 VM 会永久停在 Paused 状态。
            await this.resumeVm(apiSocketPath);
            throw err;
        }

        // 3. 恢复 vCPU
        await this.resumeVm(apiSocketPath);

        return paths;
    }

    /** 将已暂停的 VM 恢复运行；失败时向上抛错，不静默吞掉。 */
    private async resumeVm(apiSocketPath: string): Promise<void> {
        await this.requestSocket(apiSocketPath, "/vm", { state: "Resumed" }, "PATCH");
    }

    /**
     * 加载快照:
     * PUT /snapshot/load { snapshot_path, mem_file_path, enable_diff_snapshots: false, resume_vm: true }
     *
     * `resume_vm: true` 会让 Firecracker 在加载完成后自动恢复 vCPU，
     * 因此这里不需要（也不能）再单独调用 PATCH /vm。
     */
    async loadSnapshot(
        apiSocketPath: string,
        templateHash: string,
    ): Promise<void> {
        const paths = this.getSnapshotPaths(templateHash);
        if (!this.hasSnapshot(templateHash)) {
            throw new Error(`Snapshot for template hash ${templateHash} does not exist`);
        }

        await this.requestSocket(apiSocketPath, "/snapshot/load", {
            snapshot_path: paths.snapshotPath,
            mem_file_path: paths.memFilePath,
            enable_diff_snapshots: false,
            resume_vm: true,
        }, "PUT");
    }

    private async requestSocket(
        socketPath: string,
        path: string,
        payload: unknown,
        method: "PUT" | "PATCH",
    ): Promise<void> {
        return new Promise<void>((resolvePromise, rejectPromise) => {
            const data = JSON.stringify(payload);
            const req = http.request({
                socketPath,
                path,
                method,
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "Content-Length": Buffer.byteLength(data),
                },
            }, (res) => {
                let body = "";
                res.on("data", (chunk) => { body += chunk; });
                res.on("end", () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        resolvePromise();
                    } else {
                        rejectPromise(new Error(`Firecracker snapshot API [${method} ${path}] failed: ${res.statusCode} ${body}`));
                    }
                });
            });
            req.on("error", rejectPromise);
            req.write(data);
            req.end();
        });
    }
}
