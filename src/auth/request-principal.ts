export interface RequestPrincipal {
    readonly tenantId: string;
    readonly scopes: readonly string[];
}

export function hasScope(
    principal: RequestPrincipal,
    required: string,
): boolean {
    return principal.scopes.includes("*")
        || principal.scopes.includes(required);
}
