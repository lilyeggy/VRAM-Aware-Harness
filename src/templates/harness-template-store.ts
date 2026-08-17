import type { Database } from "bun:sqlite";

import {
    createHarnessTemplate,
    createPiTemplateVersion,
} from "./harness-template.ts";
import type {
    HarnessTemplate,
    HarnessTemplateVersion,
    PiTemplateSpec,
} from "./harness-template.ts";
import {
    assertNextTemplateVersion,
} from "./template-version-policy.ts";

interface TemplateVersionRow {
    id: string;
    templateId: string;
    version: number;
    runtimeKind: string;
    specJson: string;
    createdAt: string;
}

interface LatestVersionRow {
    latestVersion: number | null;
}

/**
 * HarnessTemplateStore 是模板领域对象与 SQLite 之间的持久化边界。
 *
 * Store 不决定版本发布规则。它只负责在同一个事务内读取当前最新版本、
 * 调用领域策略，再追加新版本，保证校验依据和写入不会分离。
 */
export class HarnessTemplateStore {
    constructor(private readonly db: Database) {}

    createTemplate(template: HarnessTemplate): void {
        const validated = createHarnessTemplate({
            id: template.id,
            tenantId: template.tenantId,
            createdAt: template.createdAt,
        });
        const parameters = {
            id: validated.id,
            tenantId: validated.tenantId,
            createdAt: validated.createdAt,
        };

        this.db
            .query<unknown, typeof parameters>(`
                INSERT INTO harness_templates (
                    id,
                    tenant_id,
                    created_at
                )
                VALUES (
                    $id,
                    $tenantId,
                    $createdAt
                );
            `)
            .run(parameters);
    }

    getTemplate(templateId: string): HarnessTemplate | null {
        const row = this.db
            .query<HarnessTemplate, { templateId: string }>(`
                SELECT
                    id,
                    tenant_id AS tenantId,
                    created_at AS createdAt
                FROM harness_templates
                WHERE id = $templateId;
            `)
            .get({ templateId });

        return row === null
            ? null
            : createHarnessTemplate(row);
    }

    /**
     * 向指定模板追加一个新版本。
     *
     * 模板存在性检查、最新版本查询、领域规则校验和 INSERT 位于同一事务。
     * Store 不提供 UPDATE 版本的方法，因此已发布版本只能被读取或追加后继版本。
     */
    publishVersion(
        templateId: string,
        candidate: HarnessTemplateVersion,
    ): void {
        const validated = this.validateVersion(candidate);

        const publishTransaction = this.db.transaction(() => {
            if (this.getTemplate(templateId) === null) {
                throw new Error(`找不到 HarnessTemplate：${templateId}`);
            }

            const latestVersion = this.getLatestVersionNumber(templateId);
            assertNextTemplateVersion(
                templateId,
                latestVersion,
                validated,
            );

            const parameters = {
                id: validated.id,
                templateId: validated.templateId,
                version: validated.version,
                runtimeKind: validated.spec.runtimeKind,
                specJson: JSON.stringify(validated.spec),
                createdAt: validated.createdAt,
            };

            this.db
                .query<unknown, typeof parameters>(`
                    INSERT INTO harness_template_versions (
                        id,
                        template_id,
                        version,
                        runtime_kind,
                        spec_json,
                        created_at
                    )
                    VALUES (
                        $id,
                        $templateId,
                        $version,
                        $runtimeKind,
                        $specJson,
                        $createdAt
                    );
                `)
                .run(parameters);
        });

        publishTransaction();
    }

    getVersion(versionId: string): HarnessTemplateVersion | null {
        const row = this.db
            .query<TemplateVersionRow, { versionId: string }>(`
                SELECT
                    id,
                    template_id AS templateId,
                    version,
                    runtime_kind AS runtimeKind,
                    spec_json AS specJson,
                    created_at AS createdAt
                FROM harness_template_versions
                WHERE id = $versionId;
            `)
            .get({ versionId });

        return row === null ? null : this.versionFromRow(row);
    }

    listVersions(templateId: string): HarnessTemplateVersion[] {
        return this.db
            .query<TemplateVersionRow, { templateId: string }>(`
                SELECT
                    id,
                    template_id AS templateId,
                    version,
                    runtime_kind AS runtimeKind,
                    spec_json AS specJson,
                    created_at AS createdAt
                FROM harness_template_versions
                WHERE template_id = $templateId
                ORDER BY version ASC;
            `)
            .all({ templateId })
            .map((row) => this.versionFromRow(row));
    }

    private getLatestVersionNumber(templateId: string): number | null {
        const row = this.db
            .query<LatestVersionRow, { templateId: string }>(`
                SELECT MAX(version) AS latestVersion
                FROM harness_template_versions
                WHERE template_id = $templateId;
            `)
            .get({ templateId });

        return row?.latestVersion ?? null;
    }

    private validateVersion(
        candidate: HarnessTemplateVersion,
    ): HarnessTemplateVersion {
        if (candidate.spec.runtimeKind !== "PI") {
            throw new Error(
                `当前不支持 Runtime：${String(candidate.spec.runtimeKind)}`,
            );
        }

        return createPiTemplateVersion({
            id: candidate.id,
            templateId: candidate.templateId,
            version: candidate.version,
            provider: candidate.spec.provider,
            modelId: candidate.spec.modelId,
            tools: candidate.spec.tools,
            ...(candidate.spec.skills === undefined
                ? {}
                : { skills: candidate.spec.skills }),
            ...(candidate.spec.requiredCapabilities === undefined
                ? {}
                : { requiredCapabilities: candidate.spec.requiredCapabilities }),
            ...(candidate.spec.optionalCapabilities === undefined
                ? {}
                : { optionalCapabilities: candidate.spec.optionalCapabilities }),
            createdAt: candidate.createdAt,
        });
    }

    private versionFromRow(
        row: TemplateVersionRow,
    ): HarnessTemplateVersion {
        const spec = this.parsePiSpec(row.runtimeKind, row.specJson);

        return createPiTemplateVersion({
            id: row.id,
            templateId: row.templateId,
            version: row.version,
            provider: spec.provider,
            modelId: spec.modelId,
            tools: spec.tools,
            ...(spec.skills === undefined ? {} : { skills: spec.skills }),
            ...(spec.requiredCapabilities === undefined
                ? {}
                : { requiredCapabilities: spec.requiredCapabilities }),
            ...(spec.optionalCapabilities === undefined
                ? {}
                : { optionalCapabilities: spec.optionalCapabilities }),
            createdAt: row.createdAt,
        });
    }

    private parsePiSpec(
        runtimeKind: string,
        specJson: string,
    ): PiTemplateSpec {
        let parsed: unknown;

        try {
            parsed = JSON.parse(specJson) as unknown;
        } catch {
            throw new Error("HarnessTemplateVersion spec_json 不是有效 JSON");
        }

        if (
            runtimeKind !== "PI"
            || typeof parsed !== "object"
            || parsed === null
        ) {
            throw new Error(
                `无法解析 HarnessTemplateVersion Runtime：${runtimeKind}`,
            );
        }

        const record = parsed as Record<string, unknown>;
        if (
            record.runtimeKind !== runtimeKind
            || typeof record.provider !== "string"
            || typeof record.modelId !== "string"
            || !Array.isArray(record.tools)
            || !record.tools.every((tool) => typeof tool === "string")
            || (record.skills !== undefined && (
                !Array.isArray(record.skills)
                || !record.skills.every((skill) => typeof skill === "string")
            ))
            || (record.requiredCapabilities !== undefined
                && !Array.isArray(record.requiredCapabilities))
            || (record.optionalCapabilities !== undefined
                && !Array.isArray(record.optionalCapabilities))
        ) {
            throw new Error("HarnessTemplateVersion spec_json 结构无效");
        }

        return {
            runtimeKind: "PI",
            provider: record.provider,
            modelId: record.modelId,
            tools: record.tools,
            ...(record.skills === undefined
                ? {}
                : { skills: record.skills as string[] }),
            ...(record.requiredCapabilities === undefined
                ? {}
                : { requiredCapabilities: record.requiredCapabilities as PiTemplateSpec["requiredCapabilities"] }),
            ...(record.optionalCapabilities === undefined
                ? {}
                : { optionalCapabilities: record.optionalCapabilities as PiTemplateSpec["optionalCapabilities"] }),
        };
    }
}
