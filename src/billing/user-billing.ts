import type { Database } from "bun:sqlite";

export interface UserBillingPricing {
    readonly currency: string;
    /** 平台对模型输入 token 的单价（每 100 万 token）；默认 0，使用 Provider 上报成本。 */
    readonly modelInputPerMillionTokens: number;
    /** 平台对模型输出 token 的单价（每 100 万 token）；默认 0。 */
    readonly modelOutputPerMillionTokens: number;
    /** 沙箱运行秒单价；默认 0。 */
    readonly sandboxSecond: number;
    /** 工具调用单价；默认 0。 */
    readonly toolCall: number;
}

export interface UserBillingLineItem {
    readonly category: string;
    readonly quantity: number;
    readonly unit: string;
    readonly unitPrice: number;
    readonly amount: number;
}

export interface UserBillingSummary {
    readonly userId: string;
    readonly currency: string;
    readonly generatedAt: string;
    readonly pricing: UserBillingPricing;
    readonly totals: {
        readonly modelCalls: number;
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly totalTokens: number;
        /** Provider 上报的模型成本（usage.cost.total 求和）。 */
        readonly providerCost: number;
        readonly sandboxSeconds: number;
        readonly toolCalls: number;
        /** Provider 成本 + 平台 token/沙箱/工具费用。 */
        readonly amount: number;
    };
    readonly lineItems: readonly UserBillingLineItem[];
}

export const DEFAULT_USER_BILLING_PRICING: UserBillingPricing = {
    currency: "USD",
    modelInputPerMillionTokens: 0,
    modelOutputPerMillionTokens: 0,
    sandboxSecond: 0,
    toolCall: 0,
};

/**
 * §9.7 v1.3 第 5 项：用户成本账单。
 *
 * 默认只汇总 Provider 在 MODEL_COMPLETED 事件里上报的模型成本，不凭空
 * 定价；平台可通过 HARNESS_BILLING_* 配置 token/沙箱/工具调用单价作为
 * 平台侧费用。账单是只读聚合视图，数据源是已有的 run_events /
 * sandboxes / tool_executions，不新增写入路径，避免计费与执行事实漂移。
 */
export class UserBillingStore {
    constructor(
        private readonly db: Database,
        private readonly pricing: UserBillingPricing = resolveUserBillingPricing(),
    ) {}

    summarize(userId: string): UserBillingSummary {
        const model = this.db.query<{
            modelCalls: number;
            inputTokens: number;
            outputTokens: number;
            totalTokens: number;
            providerCost: number;
        }, { userId: string }>(`
            SELECT
                COUNT(*) AS modelCalls,
                COALESCE(SUM(json_extract(e.payload_json, '$.usage.inputTokens')), 0) AS inputTokens,
                COALESCE(SUM(json_extract(e.payload_json, '$.usage.outputTokens')), 0) AS outputTokens,
                COALESCE(SUM(json_extract(e.payload_json, '$.usage.totalTokens')), 0) AS totalTokens,
                COALESCE(SUM(json_extract(e.payload_json, '$.usage.cost.total')), 0) AS providerCost
            FROM run_events e
            JOIN agent_runs r ON r.id = e.run_id
            WHERE r.user_id = $userId AND e.type = 'MODEL_COMPLETED';
        `).get({ userId }) ?? {
            modelCalls: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            providerCost: 0,
        };

        const sandbox = this.db.query<{ sandboxSeconds: number }, { userId: string }>(`
            SELECT COALESCE(SUM(
                CASE
                    WHEN s.status IN ('TERMINATED', 'LOST', 'FAILED')
                    THEN MAX(0, (julianday(s.updated_at) - julianday(s.created_at)) * 86400)
                    ELSE 0
                END
            ), 0) AS sandboxSeconds
            FROM sandboxes s
            JOIN agent_runs r ON r.id = s.run_id
            WHERE r.user_id = $userId;
        `).get({ userId }) ?? { sandboxSeconds: 0 };

        const tools = this.db.query<{ toolCalls: number }, { userId: string }>(`
            SELECT COUNT(*) AS toolCalls
            FROM tool_executions t
            JOIN agent_runs r ON r.id = t.run_id
            WHERE r.user_id = $userId
              AND t.status IN ('SUCCEEDED', 'FAILED');
        `).get({ userId }) ?? { toolCalls: 0 };

        const providerCost = roundAmount(model.providerCost);
        const modelInputCost = roundAmount(
            (model.inputTokens / 1_000_000) * this.pricing.modelInputPerMillionTokens,
        );
        const modelOutputCost = roundAmount(
            (model.outputTokens / 1_000_000) * this.pricing.modelOutputPerMillionTokens,
        );
        const sandboxCost = roundAmount(sandbox.sandboxSeconds * this.pricing.sandboxSecond);
        const toolCost = roundAmount(tools.toolCalls * this.pricing.toolCall);
        const amount = roundAmount(
            providerCost + modelInputCost + modelOutputCost + sandboxCost + toolCost,
        );

        const lineItems: UserBillingLineItem[] = [];
        if (model.modelCalls > 0) {
            lineItems.push({
                category: "MODEL_PROVIDER_COST",
                quantity: model.modelCalls,
                unit: "calls",
                unitPrice: providerCost,
                amount: providerCost,
            });
        }
        if (modelInputCost > 0) {
            lineItems.push({
                category: "MODEL_INPUT_TOKENS",
                quantity: model.inputTokens,
                unit: "tokens",
                unitPrice: this.pricing.modelInputPerMillionTokens,
                amount: modelInputCost,
            });
        }
        if (modelOutputCost > 0) {
            lineItems.push({
                category: "MODEL_OUTPUT_TOKENS",
                quantity: model.outputTokens,
                unit: "tokens",
                unitPrice: this.pricing.modelOutputPerMillionTokens,
                amount: modelOutputCost,
            });
        }
        if (sandboxCost > 0) {
            lineItems.push({
                category: "SANDBOX_SECONDS",
                quantity: roundAmount(sandbox.sandboxSeconds, 3),
                unit: "seconds",
                unitPrice: this.pricing.sandboxSecond,
                amount: sandboxCost,
            });
        }
        if (toolCost > 0) {
            lineItems.push({
                category: "TOOL_CALLS",
                quantity: tools.toolCalls,
                unit: "calls",
                unitPrice: this.pricing.toolCall,
                amount: toolCost,
            });
        }

        return {
            userId,
            currency: this.pricing.currency,
            generatedAt: new Date().toISOString(),
            pricing: this.pricing,
            totals: {
                modelCalls: model.modelCalls,
                inputTokens: model.inputTokens,
                outputTokens: model.outputTokens,
                totalTokens: model.totalTokens,
                providerCost,
                sandboxSeconds: roundAmount(sandbox.sandboxSeconds, 3),
                toolCalls: tools.toolCalls,
                amount,
            },
            lineItems,
        };
    }
}

export function resolveUserBillingPricing(
    env: Record<string, string | undefined> = process.env,
): UserBillingPricing {
    return {
        currency: nonEmpty(env.HARNESS_BILLING_CURRENCY) ?? DEFAULT_USER_BILLING_PRICING.currency,
        modelInputPerMillionTokens: nonNegativeNumber(
            env.HARNESS_BILLING_MODEL_INPUT_PER_MTOK,
            DEFAULT_USER_BILLING_PRICING.modelInputPerMillionTokens,
        ),
        modelOutputPerMillionTokens: nonNegativeNumber(
            env.HARNESS_BILLING_MODEL_OUTPUT_PER_MTOK,
            DEFAULT_USER_BILLING_PRICING.modelOutputPerMillionTokens,
        ),
        sandboxSecond: nonNegativeNumber(
            env.HARNESS_BILLING_SANDBOX_SECOND,
            DEFAULT_USER_BILLING_PRICING.sandboxSecond,
        ),
        toolCall: nonNegativeNumber(
            env.HARNESS_BILLING_TOOL_CALL,
            DEFAULT_USER_BILLING_PRICING.toolCall,
        ),
    };
}

function nonNegativeNumber(raw: string | undefined, fallback: number): number {
    if (raw === undefined || raw.trim() === "") {
        return fallback;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function nonEmpty(raw: string | undefined): string | null {
    if (raw === undefined || raw.trim() === "") {
        return null;
    }
    return raw.trim();
}

function roundAmount(value: number, decimals = 6): number {
    const factor = 10 ** decimals;
    return Math.round((value + Number.EPSILON) * factor) / factor;
}
