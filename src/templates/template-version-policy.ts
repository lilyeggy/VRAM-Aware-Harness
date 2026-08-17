import type {
    HarnessTemplateVersion,
} from "./harness-template.ts";

export function assertNextTemplateVersion(
    templateId:string,
    latestVersion:number | null,
    candidate : HarnessTemplateVersion,
) : void {
    // 1. candidate.template 必须等于 templateId
    if (candidate.templateId !== templateId) {
        throw new Error(
            `模板 ID 不匹配：期望 ${templateId}，实际 ${candidate.templateId}`,
        );
    }
    // 2. 期望版本号是(latestVersion ?? 0) + 1

    const expectedVersion = (latestVersion ?? 0) + 1;

    if (candidate.version !== expectedVersion) {
        throw new Error(
            `模板版本号不连续：期望 ${expectedVersion}，实际 ${candidate.version}`,
        );
    }
    
    
}