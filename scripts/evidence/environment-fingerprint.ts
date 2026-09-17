import { existsSync, readFileSync } from "node:fs";
import { release as osRelease } from "node:os";

/**
 * A fingerprint of the machine that actually ran (or will run) the sandbox.
 * Evidence without environment context is hard to re-check; this makes an
 * evidence record reproducible and auditable later.
 */
export interface EnvironmentFingerprint {
    readonly platform: string;
    readonly kernel: string;
    readonly nodeVersion: string;
    readonly cpuVirt: readonly string[];
    readonly kvmDevice: boolean;
    readonly dockerVersion: string | null;
    readonly runcVersion: string | null;
    readonly runscVersion: string | null;
}

export interface EnvironmentProbeOverrides {
    readonly platform?: string;
    readonly kernel?: string;
    readonly cpuVirt?: readonly string[];
    readonly kvmDevice?: boolean;
    readonly dockerVersion?: string | null;
    readonly runcVersion?: string | null;
    readonly runscVersion?: string | null;
}

/** Pure constructor; callers (and tests) inject probe results. */
export function makeEnvironmentFingerprint(
    overrides: EnvironmentProbeOverrides = {},
): EnvironmentFingerprint {
    return Object.freeze({
        platform: overrides.platform ?? process.platform,
        kernel: overrides.kernel ?? osRelease(),
        nodeVersion: process.version,
        cpuVirt: Object.freeze([...(overrides.cpuVirt ?? [])]),
        kvmDevice: overrides.kvmDevice ?? existsSync("/dev/kvm"),
        dockerVersion: overrides.dockerVersion ?? null,
        runcVersion: overrides.runcVersion ?? null,
        runscVersion: overrides.runscVersion ?? null,
    });
}

/** Reads CPU virtualization capability flags from /proc/cpuinfo (Linux). */
export function probeCpuVirt(path = "/proc/cpuinfo"): readonly string[] {
    let text: string;
    try {
        text = readFileSafe(path);
    } catch {
        return Object.freeze([]);
    }
    const flags = new Set<string>();
    for (const line of text.split("\n")) {
        if (/^flags\s*:/i.test(line)) {
            for (const word of line.split(/\s+/)) {
                if (word === "vmx" || word === "svm") flags.add(word);
            }
        }
    }
    return Object.freeze([...flags]);
}

function readFileSafe(path: string): string {
    return readFileSync(path, "utf8");
}
