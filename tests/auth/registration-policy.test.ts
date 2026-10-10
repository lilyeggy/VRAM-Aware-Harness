import { expect, test } from "bun:test";

import {
    assertRegistrationAllowed,
    RegistrationPolicyError,
} from "../../src/auth/registration-policy.ts";

test("open 模式无条件放行", () => {
    expect(() => assertRegistrationAllowed({ mode:"open" })).not.toThrow();
    expect(() => assertRegistrationAllowed({ mode:"open", providedInviteCode:"whatever" })).not.toThrow();
});

test("closed 模式拒绝", () => {
    expect(() => assertRegistrationAllowed({ mode:"closed" })).toThrow(RegistrationPolicyError);
    expect(() => assertRegistrationAllowed({ mode:"closed" })).toThrow("已关闭自助注册");
});

test("invite 模式要求邀请码且 timing-safe 比较", () => {
    expect(() => assertRegistrationAllowed({
        mode:"invite",
        inviteCode:"lab-code",
    })).toThrow("需要邀请码");

    expect(() => assertRegistrationAllowed({
        mode:"invite",
        inviteCode:"lab-code",
        providedInviteCode:"wrong",
    })).toThrow("邀请码不正确");

    // 不同长度也不应短路成非策略错误。
    expect(() => assertRegistrationAllowed({
        mode:"invite",
        inviteCode:"lab-code",
        providedInviteCode:"lab-code-but-longer",
    })).toThrow(RegistrationPolicyError);

    expect(() => assertRegistrationAllowed({
        mode:"invite",
        inviteCode:"lab-code",
        providedInviteCode:"lab-code",
    })).not.toThrow();
});
