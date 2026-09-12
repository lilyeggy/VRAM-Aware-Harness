/**
 * N28 主机制回归：Pi 上游压缩默认值在本部署的模型窗口下会退化成空操作。
 *
 * 这条测试锁的是「根因」，不是「配置项存在」：
 *   Pi 的触发条件是 contextTokens > contextWindow - reserveTokens，
 *   而切点要保留 keepRecentTokens 的近期历史。
 *   上游默认 reserveTokens=16384 / keepRecentTokens=20000 是为大窗口调的，
 *   在 32768 窗口下触发点是 16384——比它被要求保留的 20000 还小。
 *   于是 findCutPoint 一路退到会话开头，prepareCompaction 得到空的
 *   messagesToSummarize 并返回 undefined，压缩静默不执行；会话撞窗后
 *   每个请求被上游 400 拒绝，且 Pi 的 overflow 恢复只允许重试一次，
 *   失败后该会话永久不可用（真机 8 小时长稳实测出现过 142 次连续失败）。
 */

import { expect, test } from "bun:test";

import {
    DEFAULT_COMPACTION_SETTINGS,
    findCutPoint,
    shouldCompact,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";

/** 本部署 vLLM 的实际配置：--max-model-len 32768，单次输出上限 4096。 */
const MODEL_CONTEXT_WINDOW = 32_768;
const MODEL_MAX_OUTPUT_TOKENS = 4_096;

/** Harness 下发的参数，与 HarnessConfig 默认值保持一致。 */
const HARNESS_COMPACTION = {
    enabled: true,
    reserveTokens: 12_288,
    keepRecentTokens: 8_192,
} as const;

/**
 * 造一段合成的会话分支：每轮 = 1 条 user + 1 条 assistant，
 * 两侧各 `charsPerMessage` 个字符。estimateTokens 对这两种角色都是
 * ceil(chars / 4)，因此每轮固定消耗 charsPerMessage / 4 * 2 个 token。
 */
function buildTurns(
    turnCount: number,
    charsPerMessage: number,
): SessionEntry[] {
    const text = "x".repeat(charsPerMessage);
    const entries: SessionEntry[] = [];
    for (let index = 0; index < turnCount; index++) {
        entries.push({
            type: "message",
            id: `u${index}`,
            parentId: index === 0 ? null : `a${index - 1}`,
            timestamp: new Date(index * 1_000).toISOString(),
            message: {
                role: "user",
                content: text,
                timestamp: index * 1_000,
            },
        } as SessionEntry);
        entries.push({
            type: "message",
            id: `a${index}`,
            parentId: `u${index}`,
            timestamp: new Date(index * 1_000 + 500).toISOString(),
            message: {
                role: "assistant",
                content: [{ type: "text", text }],
                timestamp: index * 1_000 + 500,
            },
        } as SessionEntry);
    }
    return entries;
}

/** 每轮消耗的 token 数：两侧各 4000 字符 ≈ 1000 token。 */
const TOKENS_PER_TURN = 2_000;

test("上游默认参数在 32768 窗口下无法产生可摘要内容", () => {
    // 9 轮 ≈ 18000 token：已越过默认触发点 16384，但还没到所要求的保留量 20000。
    const entries = buildTurns(9, 4_000);
    const contextTokens = entries.length / 2 * TOKENS_PER_TURN;

    expect(contextTokens).toBeGreaterThan(
        MODEL_CONTEXT_WINDOW - DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    );
    expect(contextTokens).toBeLessThanOrEqual(
        DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
    );
    // 触发条件成立，Pi 会认为「该压缩了」。
    expect(shouldCompact(
        contextTokens,
        MODEL_CONTEXT_WINDOW,
        DEFAULT_COMPACTION_SETTINGS,
    )).toBe(true);

    // 但切点退到了会话开头，preparation.firstKeptEntryId 就是第一条 entry，
    // prepareCompaction 据此得到空的 messagesToSummarize → 返回 undefined。
    const cutPoint = findCutPoint(
        entries,
        0,
        entries.length,
        DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
    );
    expect(cutPoint.firstKeptEntryIndex).toBe(0);
    expect(cutPoint.isSplitTurn).toBe(false);
});

test("Harness 下发的参数让切点落在历史中间，压缩真正可执行", () => {
    // 11 轮 ≈ 22000 token：越过 Harness 触发点 20480。
    const entries = buildTurns(11, 4_000);
    const contextTokens = entries.length / 2 * TOKENS_PER_TURN;

    expect(contextTokens).toBeGreaterThan(
        MODEL_CONTEXT_WINDOW - HARNESS_COMPACTION.reserveTokens,
    );
    expect(shouldCompact(
        contextTokens,
        MODEL_CONTEXT_WINDOW,
        HARNESS_COMPACTION,
    )).toBe(true);

    const cutPoint = findCutPoint(
        entries,
        0,
        entries.length,
        HARNESS_COMPACTION.keepRecentTokens,
    );

    // 切点落在历史中间：前面有内容可摘要，后面保留近期若干轮。
    expect(cutPoint.firstKeptEntryIndex).toBeGreaterThan(0);
    expect(cutPoint.firstKeptEntryIndex).toBeLessThan(entries.length);

    // 按 prepareCompaction 的算法复算「将被摘要的历史」长度，必须非空。
    const historyEnd = cutPoint.isSplitTurn
        ? cutPoint.turnStartIndex
        : cutPoint.firstKeptEntryIndex;
    expect(historyEnd).toBeGreaterThan(0);

    // 且保留的近期历史不超过 keepRecentTokens + 一轮的粒度。
    const keptTokens = (entries.length - cutPoint.firstKeptEntryIndex) / 2
        * TOKENS_PER_TURN;
    expect(keptTokens).toBeLessThanOrEqual(
        HARNESS_COMPACTION.keepRecentTokens + TOKENS_PER_TURN,
    );
});

test("Harness 默认参数满足两条不变量：预留给输出、且大于保留量", () => {
    // 不变量 1：预留量必须大于单次输出上限，否则触发时已无输出空间。
    expect(HARNESS_COMPACTION.reserveTokens)
        .toBeGreaterThan(MODEL_MAX_OUTPUT_TOKENS);
    // 不变量 2：预留量必须大于保留量，否则切点够不到、压缩退化成空操作。
    expect(HARNESS_COMPACTION.reserveTokens)
        .toBeGreaterThan(HARNESS_COMPACTION.keepRecentTokens);
    // 上游默认值恰好违反不变量 2——这正是根因。
    expect(DEFAULT_COMPACTION_SETTINGS.reserveTokens)
        .toBeLessThan(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens);
    // 触发点 + 预留量必须留在窗口以内，避免「压缩后仍然超限」。
    expect(MODEL_CONTEXT_WINDOW - HARNESS_COMPACTION.reserveTokens)
        .toBeLessThan(MODEL_CONTEXT_WINDOW - MODEL_MAX_OUTPUT_TOKENS);
});

test("applyOverrides 在内存中生效，且不会写回部署方的 settings.json", async () => {
    const { SettingsManager } = await import(
        "@earendil-works/pi-coding-agent"
    );
    const { existsSync, mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    // 造一个「部署方已经写过 settings.json」的环境：保留项必须不被覆盖。
    const cwd = mkdtempSync(join(tmpdir(), "pi-compaction-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-"));
    const globalSettingsPath = join(agentDir, "settings.json");
    const original = JSON.stringify({
        theme: "dark",
        compaction: { keepRecentTokens: 99_999 },
    });
    writeFileSync(globalSettingsPath, original);

    const manager = SettingsManager.create(cwd, agentDir);
    manager.applyOverrides({ compaction: HARNESS_COMPACTION });

    // 生效：compaction 子树被覆盖，且是 Pi 实际读取的那份取值。
    expect(manager.getCompactionSettings()).toEqual({
        enabled: true,
        reserveTokens: HARNESS_COMPACTION.reserveTokens,
        keepRecentTokens: HARNESS_COMPACTION.keepRecentTokens,
    });
    // 未落盘：部署方的 settings.json 逐字节不变。
    expect(readFileSync(globalSettingsPath, "utf8")).toBe(original);
    expect(existsSync(join(cwd, ".pi", "settings.json"))).toBe(false);
});
