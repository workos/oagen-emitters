/**
 * workos-kotlin v7.4.0 compatibility table.
 *
 * The 7.5.0 regeneration moved, inserted or dropped parameters that v7.4.0
 * callers pass positionally, so old calls either stopped compiling or silently
 * sent values in other fields. Each entry below pins the v7.4.0 slots, in
 * order, for one generated signature; the emitter appends every other
 * parameter after them (including after `requestOptions`), so a v7.4.0
 * positional call keeps its meaning or fails to compile.
 *
 * Slots are Kotlin parameter names; a trailing `?` marks a defaulted slot. An
 * entry applies only while every listed name still exists with the same
 * requiredness — when the shape changes, the entry is skipped and the
 * signature falls back to the emitter's normal order.
 */
export const V74_METHOD_SLOTS: Record<string, readonly string[]> = {
  // fun authorizeDataIntegration(slug: String, userId: String, organizationId: String? = null,
  //   connectionOwner: PipesOwnership? = null, returnTo: String? = null, config: Map<String, String>? = null,
  //   requestOptions: RequestOptions? = null): DataIntegrationAuthorizeUrlResponse
  'Pipes.authorizeDataIntegration': [
    'slug',
    'userId',
    'organizationId?',
    'connectionOwner?',
    'returnTo?',
    'config?',
    'requestOptions?',
  ],
  // fun updateDataIntegrationApiKey(slug: String, userId: String, secret: String, organizationId: String? = null,
  //   connectedAccountId: String? = null, connectionOwner: PipesOwnership? = null,
  //   requestOptions: RequestOptions? = null): ConnectedAccount
  'Pipes.updateDataIntegrationApiKey': [
    'slug',
    'userId',
    'secret',
    'organizationId?',
    'connectedAccountId?',
    'connectionOwner?',
    'requestOptions?',
  ],
  // fun updateDataIntegrationClientCredentials(slug: String, userId: String, clientId: String, clientSecret: String,
  //   organizationId: String? = null, connectedAccountId: String? = null, connectionOwner: PipesOwnership? = null,
  //   config: Map<String, String>? = null, requestOptions: RequestOptions? = null): ConnectedAccount
  'Pipes.updateDataIntegrationClientCredentials': [
    'slug',
    'userId',
    'clientId',
    'clientSecret',
    'organizationId?',
    'connectedAccountId?',
    'connectionOwner?',
    'config?',
    'requestOptions?',
  ],
  // fun createUserConnectedAccount(userId: String, slug: String, organizationId: String? = null,
  //   accessToken: String? = null, refreshToken: String? = null, expiresAt: OffsetDateTime? = null,
  //   scopes: List<String>? = null, state: PipeConnectedAccountState? = null,
  //   requestOptions: RequestOptions? = null): ConnectedAccount
  'Pipes.createUserConnectedAccount': [
    'userId',
    'slug',
    'organizationId?',
    'accessToken?',
    'refreshToken?',
    'expiresAt?',
    'scopes?',
    'state?',
    'requestOptions?',
  ],
  // fun updateUserConnectedAccount(userId: String, slug: String, organizationId: String? = null,
  //   supportsMultipleConnections: Boolean? = null, connectedAccountId: String? = null, accessToken: String? = null,
  //   refreshToken: String? = null, expiresAt: OffsetDateTime? = null, scopes: List<String>? = null,
  //   state: PipeConnectedAccountState? = null, requestOptions: RequestOptions? = null): ConnectedAccount
  'Pipes.updateUserConnectedAccount': [
    'userId',
    'slug',
    'organizationId?',
    'supportsMultipleConnections?',
    'connectedAccountId?',
    'accessToken?',
    'refreshToken?',
    'expiresAt?',
    'scopes?',
    'state?',
    'requestOptions?',
  ],
  // fun createOrganizationConnectedAccount(organizationId: String, slug: String, accessToken: String? = null,
  //   refreshToken: String? = null, expiresAt: OffsetDateTime? = null, scopes: List<String>? = null,
  //   state: PipeConnectedAccountState? = null, requestOptions: RequestOptions? = null): ConnectedAccount
  // The now-required `userId` lands after these slots, so old positional calls fail to compile.
  'Pipes.createOrganizationConnectedAccount': [
    'organizationId',
    'slug',
    'accessToken?',
    'refreshToken?',
    'expiresAt?',
    'scopes?',
    'state?',
    'requestOptions?',
  ],
  // fun updateOrganizationConnectedAccount(organizationId: String, slug: String,
  //   supportsMultipleConnections: Boolean? = null, connectedAccountId: String? = null, accessToken: String? = null,
  //   refreshToken: String? = null, expiresAt: OffsetDateTime? = null, scopes: List<String>? = null,
  //   state: PipeConnectedAccountState? = null, requestOptions: RequestOptions? = null): ConnectedAccount
  // The now-required `userId` lands after these slots, so old positional calls fail to compile.
  'Pipes.updateOrganizationConnectedAccount': [
    'organizationId',
    'slug',
    'supportsMultipleConnections?',
    'connectedAccountId?',
    'accessToken?',
    'refreshToken?',
    'expiresAt?',
    'scopes?',
    'state?',
    'requestOptions?',
  ],
  // fun getProfileAndToken(code: String? = null, subjectToken: String? = null, subjectTokenType: String? = null,
  //   organizationId: String? = null, requestOptions: RequestOptions? = null): SSOTokenResponse
  'SSO.getProfileAndToken': ['code?', 'subjectToken?', 'subjectTokenType?', 'organizationId?', 'requestOptions?'],
  // fun generateLink(organization: String, returnUrl: String? = null, successUrl: String? = null,
  //   intent: GenerateLinkIntent? = null, itContactEmails: List<String>? = null,
  //   requestOptions: RequestOptions? = null): PortalLinkResponse
  'AdminPortal.generateLink': [
    'organization',
    'returnUrl?',
    'successUrl?',
    'intent?',
    'itContactEmails?',
    'requestOptions?',
  ],
  // fun createBlueprint(name: String, description: String? = null, permissions: List<String>? = null,
  //   invocableBy: AgentBlueprintsCreateRequestInvocableBy? = null,
  //   sessionSettings: AgentBlueprintsCreateRequestSessionSetting? = null,
  //   requestOptions: RequestOptions? = null): AgentBlueprint
  'Agents.createBlueprint': [
    'name',
    'description?',
    'permissions?',
    'invocableBy?',
    'sessionSettings?',
    'requestOptions?',
  ],
  // fun updateBlueprint(agentBlueprintId: String, name: PatchField<String> = PatchField.Absent,
  //   description: PatchField<String?> = ..., permissions: PatchField<List<String>> = ...,
  //   invocableBy: PatchField<AgentBlueprintsUpdateRequestInvocableBy> = ...,
  //   sessionSettings: PatchField<AgentBlueprintsUpdateRequestSessionSetting> = ...,
  //   requestOptions: RequestOptions? = null): AgentBlueprint
  'Agents.updateBlueprint': [
    'agentBlueprintId',
    'name?',
    'description?',
    'permissions?',
    'invocableBy?',
    'sessionSettings?',
    'requestOptions?',
  ],
};

/** Data class constructor slots, keyed by model class name. Same rules as {@link V74_METHOD_SLOTS}. */
export const V74_CONSTRUCTOR_SLOTS: Record<string, readonly string[]> = {
  // data class DataIntegrationsUpsertApiKeyRequest(userId: String, secret: String, organizationId: String? = null,
  //   connectedAccountId: String? = null, connectionOwner: ...ConnectionOwner? = null)
  // `connected_account_id` moved to the reauthorize / exact-connection alternatives, so slot 4 is now
  // `connectionOwner` (an enum): an old positional connected-account id fails to compile instead of
  // landing in `accountDisplayName`.
  DataIntegrationsUpsertApiKeyRequest: ['userId', 'secret', 'organizationId?', 'connectionOwner?'],
};

/**
 * v7.4.0 type names kept compiling as typealiases. When `alias` is still a
 * model, it is folded into `target` only if it has every `target` field with
 * the same wire type and requiredness and its extra fields are all optional;
 * `target` then gains those extra fields. When `alias` is no longer a model,
 * it is emitted as a plain typealias while `target` exists.
 */
export const V74_TYPEALIASES: readonly { alias: string; target: string }[] = [
  // v7.4.0 write methods returned ConnectedAccount; 7.5.0 returns ConnectedAccountWriteResponse,
  // which is ConnectedAccount plus optional `warnings`.
  { alias: 'ConnectedAccountWriteResponse', target: 'ConnectedAccount' },
  // v7.4.0 `DataIntegrationCredentialsResponse.credential` type; renamed in 7.5.0.
  { alias: 'DataIntegrationCredentialsResponseCredential', target: 'DataIntegrationVendedCredential' },
];

/**
 * Order `params` with the given v7.4.0 slots first and every other parameter
 * after them, keeping their relative order. Returns `null` (entry skipped)
 * when a slot is missing or its requiredness changed.
 */
export function applySlots<T extends { name: string; optional: boolean }>(
  slots: readonly string[] | undefined,
  params: readonly T[],
): T[] | null {
  if (!slots) return null;
  const pinned: T[] = [];
  for (const slot of slots) {
    const optional = slot.endsWith('?');
    const param = params.find((p) => p.name === slot.replace(/\?$/, ''));
    if (!param || param.optional !== optional) return null;
    pinned.push(param);
  }
  return [...pinned, ...params.filter((p) => !pinned.includes(p))];
}
