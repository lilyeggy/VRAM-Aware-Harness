import { createHash, timingSafeEqual } from "node:crypto";

/**
 * 注册策略错误：路由层应把它映射为 403（而不是凭据冲突的 409），
 * 让调用方明确「不是账号已存在，而是本部署不允许这样注册」。
 */
export class RegistrationPolicyError extends Error {
    constructor(message:string) {
        super(message);
        this.name = "RegistrationPolicyError";
    }
}

export type RegistrationMode = "open" | "invite" | "closed";

/**
 * 注册收口：把「谁可以注册」从路由层收敛到配置层。
 *
 * - open：保持旧行为（默认）；
 * - invite：必须携带与 HARNESS_REGISTRATION_INVITE_CODE 一致的邀请码；
 * - closed：拒绝一切自助注册。
 *
 * 邀请码比较先做 SHA-256 再做 timingSafeEqual：既避免明文比较的时序侧信道，
 * 也不因长度不同直接短路（长度本身不泄露给客户端，但比较路径保持恒定）。
 */
export function assertRegistrationAllowed(input:{
    mode:RegistrationMode;
    inviteCode?:string;
    providedInviteCode?:string;
}):void {
    if (input.mode === "open") {
        return;
    }
    if (input.mode === "closed") {
        throw new RegistrationPolicyError(
            "本部署已关闭自助注册，请联系管理员开通账号",
        );
    }
    if (input.inviteCode === undefined || input.inviteCode.length === 0) {
        // 配置层已保证 invite 模式必须有邀请码；这里再 fail-closed 一次，
        // 防止绕过 loadHarnessConfig 直接构造配置的调用方。
        throw new RegistrationPolicyError("本部署需要邀请码才能注册");
    }
    if (input.providedInviteCode === undefined || input.providedInviteCode.length === 0) {
        throw new RegistrationPolicyError("本部署需要邀请码才能注册");
    }
    if (!inviteCodesEqual(input.providedInviteCode, input.inviteCode)) {
        throw new RegistrationPolicyError("邀请码不正确");
    }
}

function inviteCodesEqual(provided:string, expected:string):boolean {
    const providedHash = createHash("sha256").update(provided).digest();
    const expectedHash = createHash("sha256").update(expected).digest();
    return timingSafeEqual(providedHash, expectedHash);
}
