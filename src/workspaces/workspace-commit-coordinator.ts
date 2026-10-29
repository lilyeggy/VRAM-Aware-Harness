import { chmod, chown, copyFile, cp, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { createHash } from "node:crypto";
import { WorkspaceCaptureStore, type WorkspaceCapture, type WorkspaceCaptureInput } from "./workspace-capture-store.ts";
import { planWorkspaceChanges } from "./workspace-conflict-plan.ts";

/** Single-Broker coordinator. All Workspace writers must use this instance. */
export class WorkspaceCommitCoordinator {
    private readonly tails = new Map<string, Promise<void>>();
    private readonly captures: WorkspaceCaptureStore;
    private readonly receiptRoot: string;

    constructor(captureRoot: string, private readonly onPhase?: (phase: "before-exchange" | "after-exchange" | "after-receipt") => Promise<void>) {
        this.captures = new WorkspaceCaptureStore(captureRoot); this.receiptRoot = join(captureRoot, "commit-receipts");
    }

    async getReceipt(input: WorkspaceCaptureInput): Promise<CommitReceipt | null> {
        return this.locked(input.sourcePath, async () => {
            try { await this.recover(input.sourcePath); }
            catch (error) {
                if (error instanceof UnknownCommitError && error.attemptId === input.attemptId) return this.readReceipt(input);
                throw error;
            }
            return this.readReceipt(input);
        });
    }

    async baseline(input: WorkspaceCaptureInput): Promise<WorkspaceCapture> {
        return this.locked(input.sourcePath, async () => {
            await this.recover(input.sourcePath);
            return this.captures.captureBaseline(input);
        });
    }

    async result(input: WorkspaceCaptureInput): Promise<WorkspaceCapture> {
        return this.captures.captureResult(input);
    }

    async commit(input: WorkspaceCaptureInput): Promise<{ conflicts: readonly string[] }> {
        return this.locked(input.sourcePath, async () => {
            await this.recover(input.sourcePath);
            const receipt = await this.readReceipt(input);
            if (receipt?.status === "COMMITTED") return { conflicts: [] };
            if (receipt?.status === "CONFLICT") return { conflicts: receipt.conflicts };
            const baseline = await this.captures.get(input, "baseline");
            const result = await this.captures.get(input, "result");
            if (!baseline || !result) throw new Error("提交缺少基线或成果暂存");
            const current = await this.captures.captureBaseline({ ...input, attemptId: crypto.randomUUID() });
            const plan = planWorkspaceChanges(baseline.manifest, result.manifest, current.manifest);
            if (plan.conflicts.length) {
                await this.writeReceipt({ ...identity(input), status: "CONFLICT", conflicts: [...plan.conflicts] });
                return { conflicts: plan.conflicts };
            }
            if (!plan.changes.length) {
                await this.writeReceipt({ ...identity(input), status: "COMMITTED", conflicts: [] });
                return { conflicts: [] };
            }
            const workspace = resolve(input.sourcePath);
            const tx = transactionPath(workspace);
            const candidate = join(tx, "candidate");
            const owner = await stat(workspace);
            await mkdir(tx, { mode: 0o700 });
            try {
                await cp(current.filesPath, candidate, { recursive: true, errorOnExist: true });
                await makeDirectoriesWritable(candidate);
                const resultByPath = new Map(result.manifest.entries.map((entry) => [entry.path, entry]));
                // Remove affected files and deleted/replaced directories first.
                for (const path of [...plan.changes].sort((a, b) => b.length - a.length)) {
                    const target = resultByPath.get(path);
                    const destination = join(candidate, path);
                    const existing = await maybeStat(destination);
                    if (existing && (!target || target.kind === "file" || !existing.isDirectory())) {
                        await rm(destination, { recursive: true, force: true });
                    }
                }
                for (const path of [...plan.changes].sort((a, b) => a.length - b.length)) {
                    const entry = resultByPath.get(path);
                    if (!entry) continue;
                    const destination = join(candidate, path);
                    if (entry.kind === "directory") await mkdir(destination, { recursive: true, mode: 0o700 });
                    else {
                        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
                        await copyFile(join(result.filesPath, path), destination);
                    }
                    if (entry.kind === "file") await chmod(destination, entry.mode);
                }
                await assignOwner(candidate, owner.uid, owner.gid);
                const finalDirectories = new Map(current.manifest.entries.filter((entry) => entry.kind === "directory").map((entry) => [entry.path, entry.mode]));
                for (const path of plan.changes) {
                    const entry = resultByPath.get(path);
                    if (entry?.kind === "directory") finalDirectories.set(path, entry.mode);
                    else finalDirectories.delete(path);
                }
                for (const [path, mode] of [...finalDirectories].sort((a, b) => b[0].length - a[0].length)) {
                    const target = join(candidate, path);
                    if ((await maybeStat(target))?.isDirectory()) await chmod(target, mode);
                }
                await chmod(candidate, owner.mode & 0o777);
                const old = await lstat(workspace);
                const next = await lstat(candidate);
                const intent: CommitIntent = { version: 1, ...identity(input), oldDev: old.dev, oldIno: old.ino, newDev: next.dev, newIno: next.ino };
                await writeDurableJson(join(tx, "intent.json"), intent);
                await this.onPhase?.("before-exchange");
                // A single filesystem operation publishes the whole directory;
                // readers never observe a missing or partially updated root.
                exchangeDirectories(workspace, candidate);
                await this.onPhase?.("after-exchange");
            } catch (error) {
                await this.recover(workspace);
                throw error;
            }
            await this.recover(workspace);
            return { conflicts: [] };
        });
    }

    private async recover(path: string): Promise<void> {
        const workspace = resolve(path);
        const tx = transactionPath(workspace);
        const existing = await maybeStat(tx);
        if (!existing) return;
        if (!existing.isDirectory()) throw new Error("工作区事务目录异常");
        let intent: CommitIntent | null = null;
        try { intent = JSON.parse(await readFile(join(tx, "intent.json"), "utf8")) as CommitIntent; }
        catch (error) { if (!isMissing(error)) throw error; }
        if (intent !== null) {
            if (intent.version !== 1 || resolve(intent.sourcePath) !== workspace) throw new Error("工作区提交意图无效，拒绝清理");
            const live = await maybeStat(workspace);
            const candidate = await maybeStat(join(tx, "candidate"));
            if (!live || !candidate) {
                await this.writeReceipt({ ...identity(intent), status: "UNKNOWN", conflicts: [] });
                throw new UnknownCommitError(intent.attemptId);
            }
            if (sameInode(live, intent.newDev, intent.newIno) && sameInode(candidate, intent.oldDev, intent.oldIno)) {
                await this.writeReceipt({ ...identity(intent), status: "COMMITTED", conflicts: [] });
                await this.onPhase?.("after-receipt");
            } else if (!(sameInode(live, intent.oldDev, intent.oldIno) && sameInode(candidate, intent.newDev, intent.newIno))) {
                await this.writeReceipt({ ...identity(intent), status: "UNKNOWN", conflicts: [] });
                throw new UnknownCommitError(intent.attemptId);
            }
        }
        const backup = join(tx, "backup");
        if (!await maybeStat(workspace)) {
            if (!await maybeStat(backup)) throw new Error("工作区和事务备份均不存在，拒绝继续");
            await rename(backup, workspace);
        }
        await removeTree(tx);
    }

    private receiptPath(input: Pick<WorkspaceCaptureInput, "userId" | "workspaceId" | "attemptId">): string {
        const key = createHash("sha256").update(JSON.stringify([input.userId, input.workspaceId, input.attemptId])).digest("hex");
        return join(this.receiptRoot, `${key}.json`);
    }
    private async readReceipt(input: WorkspaceCaptureInput): Promise<CommitReceipt | null> {
        try {
            const receipt = JSON.parse(await readFile(this.receiptPath(input), "utf8")) as CommitReceipt;
            if (receipt.userId !== input.userId || receipt.workspaceId !== input.workspaceId || receipt.attemptId !== input.attemptId
                || resolve(receipt.sourcePath) !== resolve(input.sourcePath) || !["COMMITTED", "CONFLICT", "UNKNOWN"].includes(receipt.status)) {
                throw new Error("提交回执身份无效");
            }
            return receipt;
        } catch (error) { if (isMissing(error)) return null; throw error; }
    }
    private async writeReceipt(receipt: CommitReceipt): Promise<void> {
        await mkdir(this.receiptRoot, { recursive: true, mode: 0o700 });
        await writeDurableJson(this.receiptPath(receipt), receipt);
    }

    private async locked<T>(path: string, action: () => Promise<T>): Promise<T> {
        const key = resolve(path);
        const previous = this.tails.get(key) ?? Promise.resolve();
        let release!: () => void;
        const gate = new Promise<void>((done) => { release = done; });
        const tail = previous.then(() => gate);
        this.tails.set(key, tail);
        await previous;
        try { return await action(); }
        finally { release(); if (this.tails.get(key) === tail) this.tails.delete(key); }
    }
}

export interface CommitReceipt extends WorkspaceCaptureInput { readonly status: "COMMITTED" | "CONFLICT" | "UNKNOWN"; readonly conflicts: readonly string[] }
class UnknownCommitError extends Error {
    constructor(readonly attemptId: string) { super("工作区提交结果未知，保留事务等待人工检查"); }
}
interface CommitIntent extends WorkspaceCaptureInput { readonly version: 1; readonly oldDev: number; readonly oldIno: number; readonly newDev: number; readonly newIno: number }
function identity(input: WorkspaceCaptureInput): WorkspaceCaptureInput {
    return { userId: input.userId, workspaceId: input.workspaceId, attemptId: input.attemptId, sourcePath: input.sourcePath };
}
function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
function sameInode(info: { dev: number; ino: number }, dev: number, ino: number): boolean { return info.dev === dev && info.ino === ino; }
async function writeDurableJson(path: string, value: unknown): Promise<void> {
    const temp = `${path}.${crypto.randomUUID()}.tmp`;
    try {
        await writeFile(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
        const file = await open(temp, "r"); try { await file.sync(); } finally { await file.close(); }
        await rename(temp, path);
        const directory = await open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temp, { force: true }); }
}

function exchangeDirectories(left: string, right: string): void {
    const a = Buffer.from(`${left}\0`);
    const b = Buffer.from(`${right}\0`);
    if (process.platform === "linux") {
        const lib = dlopen("libc.so.6", { renameat2: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 } });
        try {
            if (lib.symbols.renameat2(-100, ptr(a), -100, ptr(b), 2) !== 0) throw new Error("Workspace 原子交换失败");
        } finally { lib.close(); }
        return;
    }
    if (process.platform === "darwin") {
        const lib = dlopen("/usr/lib/libSystem.B.dylib", { renamex_np: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 } });
        try {
            if (lib.symbols.renamex_np(ptr(a), ptr(b), 2) !== 0) throw new Error("Workspace 原子交换失败");
        } finally { lib.close(); }
        return;
    }
    throw new Error(`不支持 Workspace 原子交换的平台: ${process.platform}`);
}

function transactionPath(workspace: string): string {
    return join(dirname(workspace), `.${basename(workspace)}.harness-transaction`);
}
async function maybeStat(path: string) {
    try { return await lstat(path); }
    catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null; throw error; }
}
async function assignOwner(path: string, uid: number, gid: number): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("工作区事务包含符号链接");
    if (info.isDirectory()) {
        for (const name of await readdir(path)) await assignOwner(join(path, name), uid, gid);
    }
    if (info.uid !== uid || info.gid !== gid) await chown(path, uid, gid);
}
async function makeDirectoriesWritable(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isDirectory()) return;
    await chmod(path, (info.mode & 0o777) | 0o700);
    for (const name of await readdir(path)) await makeDirectoriesWritable(join(path, name));
}
async function removeTree(path: string): Promise<void> {
    const info = await maybeStat(path);
    if (!info) return;
    if (info.isDirectory()) {
        await chmod(path, 0o700);
        for (const name of await readdir(path)) await removeTree(join(path, name));
    }
    await rm(path, { recursive: true, force: true });
}
