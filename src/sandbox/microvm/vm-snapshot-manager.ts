import { existsSync, mkdirSync, chmodSync, rmSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
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

    /** 计算模板哈希: sha256(kernelStat + rootfsStat + agentVersion) */
    computeTemplateHash(kernelPath: string, rootfsPath: string, agentVersion = "1.0.0"): string {
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
