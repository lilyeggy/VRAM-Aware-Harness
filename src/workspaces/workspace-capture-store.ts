import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { isWithin } from "../utils/path-utils.ts";

export type WorkspaceCaptureKind = "baseline" | "result";

export type WorkspaceCaptureEntry =
    | { readonly path: string; readonly kind: "directory"; readonly mode: number }
    | { readonly path: string; readonly kind: "file"; readonly mode: number; readonly size: number; readonly hash: string };

export interface WorkspaceCaptureManifest {
    readonly version: 1;
    readonly userId: string;
    readonly workspaceId: string;
    readonly attemptId: string;
    readonly kind: WorkspaceCaptureKind;
    readonly entries: readonly WorkspaceCaptureEntry[];
}

export interface WorkspaceCapture {
    readonly manifest: WorkspaceCaptureManifest;
    /** Private files used as the seed or as preserved results. */
    readonly filesPath: string;
}

export interface WorkspaceCaptureInput {
    readonly userId: string;
    readonly workspaceId: string;
    readonly attemptId: string;
    readonly sourcePath: string;
}

export interface WorkspaceCaptureLimits {
    readonly maxFiles?: number;
    readonly maxBytes?: number;
    readonly maxDepth?: number;
}

/**
 * Creates private, independently published filesystem copies for one attempt.
 * The caller must coordinate Workspace writers while capturing a baseline and
 * must stop the VM before capturing a result. This class is not a file lock.
 * Its rename boundary protects publication from process interruption, not power
 * loss. Cleanup/reconciliation of abandoned temporary folders is a separate job.
 */
export class WorkspaceCaptureStore {
    private readonly root: string;

    constructor(rootPath: string, private readonly limits: WorkspaceCaptureLimits = {}) {
        this.root = resolve(rootPath);
        for (const [name, value] of Object.entries(limits)) {
            if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
                throw new Error(`${name} must be a non-negative safe integer`);
            }
        }
    }

    async captureBaseline(input: WorkspaceCaptureInput): Promise<WorkspaceCapture> {
        return this.capture(input, "baseline");
    }

    async captureResult(input: WorkspaceCaptureInput): Promise<WorkspaceCapture> {
        const baseline = await this.get(input, "baseline");
        if (baseline === null) throw new Error("Cannot capture a result without its baseline");
        return this.capture(input, "result");
    }

    async get(identity: Omit<WorkspaceCaptureInput, "sourcePath">, kind: WorkspaceCaptureKind): Promise<WorkspaceCapture | null> {
        const parent = this.attemptPath(identity);
        const capturePath = join(parent, kind);
        let raw: string;
        try {
            raw = await readFile(join(capturePath, "manifest.json"), "utf8");
        } catch (error) {
            if (isMissing(error)) return null;
            throw error;
        }
        const manifest = JSON.parse(raw) as WorkspaceCaptureManifest;
        if (manifest.version !== 1 || manifest.kind !== kind || manifest.userId !== identity.userId
            || manifest.workspaceId !== identity.workspaceId || manifest.attemptId !== identity.attemptId
            || !Array.isArray(manifest.entries)) {
            throw new Error("Workspace capture manifest does not match its identity");
        }
        const filesPath = join(capturePath, "files");
        if (!(await lstat(filesPath)).isDirectory()) throw new Error("Workspace capture files are missing");
        return { manifest, filesPath };
    }

    private attemptPath(identity: Omit<WorkspaceCaptureInput, "sourcePath">): string {
        for (const id of [identity.userId, identity.workspaceId, identity.attemptId]) {
            if (typeof id !== "string" || id.trim().length === 0 || id.length > 256) {
                throw new Error("Workspace capture identity is invalid");
            }
        }
        // Hash each identity component so callers cannot choose filesystem paths.
        const key = (value: string) => createHash("sha256").update(value).digest("hex");
        return join(this.root, key(identity.userId), key(identity.workspaceId), key(identity.attemptId));
    }

    private async capture(input: WorkspaceCaptureInput, kind: WorkspaceCaptureKind): Promise<WorkspaceCapture> {
        const parent = this.attemptPath(input);
        const sourceInfo = await lstat(input.sourcePath);
        if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error("Capture source must be a directory");
        const source = await realpath(input.sourcePath);
        const prospectiveRoot = await resolveFromExistingAncestor(this.root);
        if (isWithin(prospectiveRoot, source) || isWithin(source, prospectiveRoot)) {
            throw new Error("Capture source and storage must not overlap");
        }
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        const root = await realpath(this.root);
        if (isWithin(root, source) || isWithin(source, root)) throw new Error("Capture source and storage must not overlap");
        await mkdir(parent, { recursive: true, mode: 0o700 });
        const temporary = await mkdtemp(join(parent, `.${kind}-`));
        const destination = join(parent, kind);
        try {
            const filesPath = join(temporary, "files");
            await mkdir(filesPath, { mode: 0o700 });
            const entries: WorkspaceCaptureEntry[] = [];
            let count = 0;
            let bytes = 0;
            const walk = async (current: string, depth: number): Promise<void> => {
                if (depth > (this.limits.maxDepth ?? 32)) throw new Error("Workspace capture exceeds maximum depth");
                for (const entry of await readdir(current, { withFileTypes: true })) {
                    const path = join(current, entry.name);
                    const rel = relative(source, path);
                    const destinationPath = join(filesPath, rel);
                    const info = await lstat(path);
                    if (info.isSymbolicLink()) throw new Error(`Unsupported symbolic link: ${rel}`);
                    if ((info.mode & 0o7000) !== 0) throw new Error(`Unsupported special mode bits: ${rel}`);
                    if (info.isDirectory()) {
                        await mkdir(destinationPath, { mode: 0o700 });
                        entries.push({ path: rel, kind: "directory", mode: info.mode & 0o777 });
                        await walk(path, depth + 1);
                        await chmod(destinationPath, info.mode & 0o777);
                    } else if (info.isFile()) {
                        if (info.nlink !== 1) throw new Error(`Unsupported hard-linked file: ${rel}`);
                        count += 1;
                        bytes += info.size;
                        if (count > (this.limits.maxFiles ?? 20_000)) throw new Error("Workspace capture exceeds maximum file count");
                        if (this.limits.maxBytes !== undefined && bytes > this.limits.maxBytes) throw new Error("Workspace capture exceeds maximum bytes");
                        const copied = await copyStableFile(path, destinationPath, info.dev, info.ino);
                        if (copied.size !== info.size) throw new Error(`Source changed during capture: ${rel}`);
                        entries.push({ path: rel, kind: "file", ...copied });
                    } else {
                        throw new Error(`Unsupported filesystem entry: ${rel}`);
                    }
                }
            };
            await walk(source, 0);
            entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
            const manifest: WorkspaceCaptureManifest = {
                version: 1, userId: input.userId, workspaceId: input.workspaceId, attemptId: input.attemptId,
                kind, entries,
            };
            const manifestFile = await open(join(temporary, "manifest.json"), "wx", 0o600);
            try { await manifestFile.writeFile(JSON.stringify(manifest)); await manifestFile.sync(); }
            finally { await manifestFile.close(); }
            // A published directory is non-empty. A duplicate capture therefore
            // cannot replace it via rename; failed temporary copies are removed.
            await rename(temporary, destination);
            return { manifest, filesPath: join(destination, "files") };
        } finally {
            await removeTemporaryCapture(temporary);
        }
    }
}

/** Copied directories may be read-only; restore owner access before cleanup. */
async function removeTemporaryCapture(path: string): Promise<void> {
    let info;
    try { info = await lstat(path); }
    catch (error) { if (isMissing(error)) return; throw error; }
    if (info.isDirectory()) {
        await chmod(path, 0o700);
        for (const name of await readdir(path)) await removeTemporaryCapture(join(path, name));
    }
    await rm(path, { recursive: true, force: true });
}

/** Resolve existing parent symlinks before creating any storage directory. */
async function resolveFromExistingAncestor(path: string): Promise<string> {
    let ancestor = path;
    while (true) {
        try {
            return resolve(await realpath(ancestor), relative(ancestor, path));
        } catch (error) {
            if (!isMissing(error)) throw error;
            const parent = dirname(ancestor);
            if (parent === ancestor) throw error;
            ancestor = parent;
        }
    }
}

async function copyStableFile(source: string, destination: string, expectedDevice: number, expectedInode: number): Promise<{ mode: number; size: number; hash: string }> {
    const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const before = await input.stat();
        if (!before.isFile() || before.nlink !== 1 || before.dev !== expectedDevice || before.ino !== expectedInode) {
            throw new Error(`Unsupported or changed source file: ${source}`);
        }
        const output = await open(destination, "wx", 0o600);
        try {
            const hash = createHash("sha256");
            const buffer = Buffer.allocUnsafe(64 * 1024);
            let size = 0;
            while (true) {
                const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
                if (bytesRead === 0) break;
                if (size + bytesRead > before.size) throw new Error(`Source grew during capture: ${source}`);
                hash.update(buffer.subarray(0, bytesRead));
                let written = 0;
                while (written < bytesRead) {
                    const result = await output.write(buffer, written, bytesRead - written, null);
                    if (result.bytesWritten === 0) throw new Error("Workspace capture write made no progress");
                    written += result.bytesWritten;
                }
                size += bytesRead;
            }
            const after = await input.stat();
            if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
                || after.ctimeMs !== before.ctimeMs || after.nlink !== 1) {
                throw new Error(`Source changed during capture: ${source}`);
            }
            await output.sync();
            const mode = before.mode & 0o777;
            await chmod(destination, mode);
            await output.sync();
            return { mode, size, hash: hash.digest("hex") };
        } finally { await output.close(); }
    } finally { await input.close(); }
}

function isMissing(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
