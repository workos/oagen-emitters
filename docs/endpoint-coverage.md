# Endpoint Coverage: OpenAPI Spec vs Generated SDK vs workos-node

Comparison of HTTP verb + path pairs across three sources, with path parameters normalized to `{}`.

- **Spec**: OpenAPI spec baseline (from `smoke-results-spec-baseline.json`)
- **Gen SDK**: Generated SDK in `./sdk` (from `smoke-results-sdk-node.json`)
- **workos-node**: Live SDK at `/workos-node` (extracted via static analysis of `this.workos.<verb>()` calls)

## Summary

| Source        | Endpoints |
| ------------- | --------- |
| OpenAPI Spec  | 154       |
| Generated SDK | 154       |
| workos-node   | 134       |
| **In all 3**  | **114**   |

## Full Comparison

| Endpoint                                                                       | Spec | Gen SDK | workos-node |
| ------------------------------------------------------------------------------ | :--: | :-----: | :---------: |
| `DELETE /api_keys/{}`                                                          |  Y   |    Y    |      Y      |
| `DELETE /auth/factors/{}`                                                      |  Y   |    Y    |      Y      |
| `DELETE /authorization/organization_memberships/{}/role_assignments`           |  Y   |    Y    |      Y      |
| `DELETE /authorization/organization_memberships/{}/role_assignments/{}`        |  Y   |    Y    |      Y      |
| `DELETE /authorization/organizations/{}/resources/{}/{}`                       |  Y   |    Y    |      Y      |
| `DELETE /authorization/organizations/{}/roles/{}`                              |  Y   |    Y    |      Y      |
| `DELETE /authorization/organizations/{}/roles/{}/permissions/{}`               |  Y   |    Y    |      Y      |
| `DELETE /authorization/permissions/{}`                                         |  Y   |    Y    |      Y      |
| `DELETE /authorization/resources/{}`                                           |  Y   |    Y    |      Y      |
| `DELETE /connect/applications/{}`                                              |  Y   |    Y    |      Y      |
| `DELETE /connect/client_secrets/{}`                                            |  Y   |    Y    |      Y      |
| `DELETE /connections/{}`                                                       |  Y   |    Y    |      Y      |
| `DELETE /directories/{}`                                                       |  Y   |    Y    |      Y      |
| `DELETE /feature-flags/{}/targets/{}`                                          |  Y   |    Y    |      Y      |
| `DELETE /fga/v1/resources/{}/{}`                                               |      |         |      Y      |
| `DELETE /organization_domains/{}`                                              |  Y   |    Y    |      Y      |
| `DELETE /organizations/{}`                                                     |  Y   |    Y    |      Y      |
| `DELETE /radar/lists/{}/{}`                                                    |  Y   |    Y    |      Y      |
| `DELETE /user_management/organization_memberships/{}`                          |  Y   |    Y    |      Y      |
| `DELETE /user_management/users/{}`                                             |  Y   |    Y    |      Y      |
| `DELETE /user_management/users/{}/authorized_applications/{}`                  |  Y   |    Y    |             |
| `DELETE /user_management/users/{}/connected_accounts/{}`                       |  Y   |    Y    |             |
| `DELETE /vault/v1/kv/{}`                                                       |      |         |      Y      |
| `DELETE /webhook_endpoints/{}`                                                 |  Y   |    Y    |      Y      |
| `GET /audit_logs/actions`                                                      |  Y   |    Y    |             |
| `GET /audit_logs/actions/{}/schemas`                                           |  Y   |    Y    |             |
| `GET /audit_logs/exports/{}`                                                   |  Y   |    Y    |      Y      |
| `GET /auth/factors/{}`                                                         |  Y   |    Y    |      Y      |
| `GET /authorization/organization_memberships/{}/resources`                     |  Y   |    Y    |      Y      |
| `GET /authorization/organization_memberships/{}/role_assignments`              |  Y   |    Y    |      Y      |
| `GET /authorization/organizations/{}/resources/{}/{}`                          |  Y   |    Y    |      Y      |
| `GET /authorization/organizations/{}/resources/{}/{}/organization_memberships` |  Y   |    Y    |      Y      |
| `GET /authorization/organizations/{}/roles`                                    |  Y   |    Y    |      Y      |
| `GET /authorization/organizations/{}/roles/{}`                                 |  Y   |    Y    |      Y      |
| `GET /authorization/permissions`                                               |  Y   |    Y    |      Y      |
| `GET /authorization/permissions/{}`                                            |  Y   |    Y    |      Y      |
| `GET /authorization/resources`                                                 |  Y   |    Y    |      Y      |
| `GET /authorization/resources/{}`                                              |  Y   |    Y    |      Y      |
| `GET /authorization/resources/{}/organization_memberships`                     |  Y   |    Y    |      Y      |
| `GET /authorization/roles`                                                     |  Y   |    Y    |      Y      |
| `GET /authorization/roles/{}`                                                  |  Y   |    Y    |      Y      |
| `GET /connect/applications`                                                    |  Y   |    Y    |             |
| `GET /connect/applications/{}`                                                 |  Y   |    Y    |      Y      |
| `GET /connect/applications/{}/client_secrets`                                  |  Y   |    Y    |      Y      |
| `GET /connections`                                                             |  Y   |    Y    |             |
| `GET /connections/{}`                                                          |  Y   |    Y    |      Y      |
| `GET /directories`                                                             |  Y   |    Y    |             |
| `GET /directories/{}`                                                          |  Y   |    Y    |      Y      |
| `GET /directory_groups`                                                        |  Y   |    Y    |             |
| `GET /directory_groups/{}`                                                     |  Y   |    Y    |      Y      |
| `GET /directory_users`                                                         |  Y   |    Y    |             |
| `GET /directory_users/{}`                                                      |  Y   |    Y    |      Y      |
| `GET /events`                                                                  |  Y   |    Y    |             |
| `GET /feature-flags`                                                           |  Y   |    Y    |             |
| `GET /feature-flags/{}`                                                        |  Y   |    Y    |      Y      |
| `GET /fga/v1/resources/{}/{}`                                                  |      |         |      Y      |
| `GET /organization_domains/{}`                                                 |  Y   |    Y    |      Y      |
| `GET /organizations`                                                           |  Y   |    Y    |             |
| `GET /organizations/external_id/{}`                                            |  Y   |    Y    |      Y      |
| `GET /organizations/{}`                                                        |  Y   |    Y    |      Y      |
| `GET /organizations/{}/api_keys`                                               |  Y   |    Y    |             |
| `GET /organizations/{}/audit_log_configuration`                                |  Y   |    Y    |             |
| `GET /organizations/{}/audit_logs_retention`                                   |  Y   |    Y    |             |
| `GET /organizations/{}/feature-flags`                                          |  Y   |    Y    |             |
| `GET /organizations/{}/roles`                                                  |      |         |      Y      |
| `GET /sso/authorize`                                                           |  Y   |    Y    |             |
| `GET /sso/jwks/{}`                                                             |  Y   |    Y    |             |
| `GET /sso/logout`                                                              |  Y   |    Y    |             |
| `GET /sso/profile`                                                             |  Y   |    Y    |             |
| `GET /user_management/authorize`                                               |  Y   |    Y    |             |
| `GET /user_management/email_verification/{}`                                   |  Y   |    Y    |      Y      |
| `GET /user_management/invitations`                                             |  Y   |    Y    |             |
| `GET /user_management/invitations/by_token/{}`                                 |  Y   |    Y    |      Y      |
| `GET /user_management/invitations/{}`                                          |  Y   |    Y    |      Y      |
| `GET /user_management/magic_auth/{}`                                           |  Y   |    Y    |      Y      |
| `GET /user_management/organization_memberships`                                |  Y   |    Y    |             |
| `GET /user_management/organization_memberships/{}`                             |  Y   |    Y    |      Y      |
| `GET /user_management/password_reset/{}`                                       |  Y   |    Y    |      Y      |
| `GET /user_management/sessions/logout`                                         |  Y   |    Y    |             |
| `GET /user_management/users`                                                   |  Y   |    Y    |             |
| `GET /user_management/users/external_id/{}`                                    |  Y   |    Y    |      Y      |
| `GET /user_management/users/{}`                                                |  Y   |    Y    |      Y      |
| `GET /user_management/users/{}/auth_factors`                                   |  Y   |    Y    |             |
| `GET /user_management/users/{}/authorized_applications`                        |  Y   |    Y    |             |
| `GET /user_management/users/{}/connected_accounts/{}`                          |  Y   |    Y    |             |
| `GET /user_management/users/{}/data_providers`                                 |  Y   |    Y    |             |
| `GET /user_management/users/{}/feature-flags`                                  |  Y   |    Y    |             |
| `GET /user_management/users/{}/identities`                                     |  Y   |    Y    |      Y      |
| `GET /user_management/users/{}/sessions`                                       |  Y   |    Y    |             |
| `GET /vault/v1/kv/name/{}`                                                     |      |         |      Y      |
| `GET /vault/v1/kv/{}`                                                          |      |         |      Y      |
| `GET /vault/v1/kv/{}/metadata`                                                 |      |         |      Y      |
| `GET /vault/v1/kv/{}/versions`                                                 |      |         |      Y      |
| `GET /webhook_endpoints`                                                       |  Y   |    Y    |             |
| `PATCH /authorization/organizations/{}/resources/{}/{}`                        |  Y   |    Y    |      Y      |
| `PATCH /authorization/organizations/{}/roles/{}`                               |  Y   |    Y    |      Y      |
| `PATCH /authorization/permissions/{}`                                          |  Y   |    Y    |      Y      |
| `PATCH /authorization/resources/{}`                                            |  Y   |    Y    |      Y      |
| `PATCH /authorization/roles/{}`                                                |  Y   |    Y    |      Y      |
| `POST /api_keys/validations`                                                   |  Y   |    Y    |      Y      |
| `POST /audit_logs/actions/{}/schemas`                                          |  Y   |    Y    |      Y      |
| `POST /audit_logs/events`                                                      |  Y   |    Y    |      Y      |
| `POST /audit_logs/exports`                                                     |  Y   |    Y    |      Y      |
| `POST /auth/challenges/{}/verify`                                              |  Y   |    Y    |      Y      |
| `POST /auth/factors/enroll`                                                    |  Y   |    Y    |      Y      |
| `POST /auth/factors/{}/challenge`                                              |  Y   |    Y    |      Y      |
| `POST /authkit/oauth2/complete`                                                |  Y   |    Y    |      Y      |
| `POST /authorization/organization_memberships/{}/check`                        |  Y   |    Y    |      Y      |
| `POST /authorization/organization_memberships/{}/role_assignments`             |  Y   |    Y    |      Y      |
| `POST /authorization/organizations/{}/roles`                                   |  Y   |    Y    |      Y      |
| `POST /authorization/organizations/{}/roles/{}/permissions`                    |  Y   |    Y    |      Y      |
| `POST /authorization/permissions`                                              |  Y   |    Y    |      Y      |
| `POST /authorization/resources`                                                |  Y   |    Y    |      Y      |
| `POST /authorization/roles`                                                    |  Y   |    Y    |      Y      |
| `POST /authorization/roles/{}/permissions`                                     |  Y   |    Y    |      Y      |
| `POST /connect/applications`                                                   |  Y   |    Y    |      Y      |
| `POST /connect/applications/{}/client_secrets`                                 |  Y   |    Y    |      Y      |
| `POST /data-integrations/{}/authorize`                                         |  Y   |    Y    |      Y      |
| `POST /data-integrations/{}/token`                                             |  Y   |    Y    |      Y      |
| `POST /feature-flags/{}/targets/{}`                                            |  Y   |    Y    |      Y      |
| `POST /fga/v1/check`                                                           |      |         |      Y      |
| `POST /fga/v1/resources`                                                       |      |         |      Y      |
| `POST /fga/v1/resources/batch`                                                 |      |         |      Y      |
| `POST /fga/v1/warrants`                                                        |      |         |      Y      |
| `POST /organization_domains`                                                   |  Y   |    Y    |      Y      |
| `POST /organization_domains/{}/verify`                                         |  Y   |    Y    |      Y      |
| `POST /organizations`                                                          |  Y   |    Y    |      Y      |
| `POST /organizations/{}/api_keys`                                              |  Y   |    Y    |      Y      |
| `POST /passwordless/sessions`                                                  |      |         |      Y      |
| `POST /passwordless/sessions/{}/send`                                          |      |         |      Y      |
| `POST /portal/generate_link`                                                   |  Y   |    Y    |      Y      |
| `POST /radar/attempts`                                                         |  Y   |    Y    |      Y      |
| `POST /radar/lists/{}/{}`                                                      |  Y   |    Y    |      Y      |
| `POST /sso/logout/authorize`                                                   |  Y   |    Y    |             |
| `POST /sso/token`                                                              |  Y   |    Y    |             |
| `POST /user_management/authenticate`                                           |  Y   |    Y    |      Y      |
| `POST /user_management/authorize/device`                                       |  Y   |    Y    |             |
| `POST /user_management/cors_origins`                                           |  Y   |    Y    |             |
| `POST /user_management/invitations`                                            |  Y   |    Y    |      Y      |
| `POST /user_management/invitations/{}/accept`                                  |  Y   |    Y    |      Y      |
| `POST /user_management/invitations/{}/resend`                                  |  Y   |    Y    |      Y      |
| `POST /user_management/invitations/{}/revoke`                                  |  Y   |    Y    |      Y      |
| `POST /user_management/magic_auth`                                             |  Y   |    Y    |      Y      |
| `POST /user_management/organization_memberships`                               |  Y   |    Y    |      Y      |
| `POST /user_management/password_reset`                                         |  Y   |    Y    |      Y      |
| `POST /user_management/password_reset/confirm`                                 |  Y   |    Y    |      Y      |
| `POST /user_management/redirect_uris`                                          |  Y   |    Y    |             |
| `POST /user_management/sessions/revoke`                                        |  Y   |    Y    |      Y      |
| `POST /user_management/users`                                                  |  Y   |    Y    |      Y      |
| `POST /user_management/users/{}/auth_factors`                                  |  Y   |    Y    |      Y      |
| `POST /user_management/users/{}/email_verification/confirm`                    |  Y   |    Y    |      Y      |
| `POST /user_management/users/{}/email_verification/send`                       |  Y   |    Y    |      Y      |
| `POST /vault/v1/keys/data-key`                                                 |      |         |      Y      |
| `POST /vault/v1/keys/decrypt`                                                  |      |         |      Y      |
| `POST /vault/v1/kv`                                                            |      |         |      Y      |
| `POST /webhook_endpoints`                                                      |  Y   |    Y    |      Y      |
| `POST /widgets/token`                                                          |  Y   |    Y    |      Y      |
| `POST data-integrations/{}/token`                                              |      |         |      Y      |
| `PUT /authorization/organizations/{}/roles/priority`                           |  Y   |    Y    |             |
| `PUT /authorization/organizations/{}/roles/{}/permissions`                     |  Y   |    Y    |      Y      |
| `PUT /authorization/roles/{}/permissions`                                      |  Y   |    Y    |      Y      |
| `PUT /connect/applications/{}`                                                 |  Y   |    Y    |      Y      |
| `PUT /feature-flags/{}/disable`                                                |  Y   |    Y    |      Y      |
| `PUT /feature-flags/{}/enable`                                                 |  Y   |    Y    |      Y      |
| `PUT /fga/v1/resources/{}/{}`                                                  |      |         |      Y      |
| `PUT /organizations/{}`                                                        |  Y   |    Y    |      Y      |
| `PUT /organizations/{}/audit_logs_retention`                                   |  Y   |    Y    |             |
| `PUT /radar/attempts/{}`                                                       |  Y   |    Y    |      Y      |
| `PUT /user_management/jwt_template`                                            |  Y   |    Y    |             |
| `PUT /user_management/organization_memberships/{}`                             |  Y   |    Y    |      Y      |
| `PUT /user_management/organization_memberships/{}/deactivate`                  |  Y   |    Y    |      Y      |
| `PUT /user_management/organization_memberships/{}/reactivate`                  |  Y   |    Y    |      Y      |
| `PUT /user_management/users/{}`                                                |  Y   |    Y    |      Y      |
| `PUT /vault/v1/kv/{}`                                                          |      |         |      Y      |

## In Spec + Generated SDK but NOT in workos-node (40)

Many of these are list endpoints that workos-node handles via a shared paginated fetch helper which constructs URLs dynamically. Static analysis of the source does not capture these, so the actual runtime coverage is likely higher.

| Endpoint                                                      | Notes                           |
| ------------------------------------------------------------- | ------------------------------- |
| `DELETE /user_management/users/{}/authorized_applications/{}` |                                 |
| `DELETE /user_management/users/{}/connected_accounts/{}`      |                                 |
| `GET /audit_logs/actions`                                     | List endpoint                   |
| `GET /audit_logs/actions/{}/schemas`                          |                                 |
| `GET /connect/applications`                                   | List endpoint                   |
| `GET /connections`                                            | List endpoint                   |
| `GET /directories`                                            | List endpoint                   |
| `GET /directory_groups`                                       | List endpoint                   |
| `GET /directory_users`                                        | List endpoint                   |
| `GET /events`                                                 | List endpoint                   |
| `GET /feature-flags`                                          | List endpoint                   |
| `GET /organizations`                                          | List endpoint                   |
| `GET /organizations/{}/api_keys`                              |                                 |
| `GET /organizations/{}/audit_log_configuration`               |                                 |
| `GET /organizations/{}/audit_logs_retention`                  |                                 |
| `GET /organizations/{}/feature-flags`                         |                                 |
| `GET /sso/authorize`                                          | URL construction, not HTTP call |
| `GET /sso/jwks/{}`                                            |                                 |
| `GET /sso/logout`                                             | URL construction, not HTTP call |
| `GET /sso/profile`                                            |                                 |
| `GET /user_management/authorize`                              | URL construction, not HTTP call |
| `GET /user_management/invitations`                            | List endpoint                   |
| `GET /user_management/organization_memberships`               | List endpoint                   |
| `GET /user_management/sessions/logout`                        | URL construction, not HTTP call |
| `GET /user_management/users`                                  | List endpoint                   |
| `GET /user_management/users/{}/auth_factors`                  |                                 |
| `GET /user_management/users/{}/authorized_applications`       |                                 |
| `GET /user_management/users/{}/connected_accounts/{}`         |                                 |
| `GET /user_management/users/{}/data_providers`                |                                 |
| `GET /user_management/users/{}/feature-flags`                 |                                 |
| `GET /user_management/users/{}/sessions`                      |                                 |
| `GET /webhook_endpoints`                                      | List endpoint                   |
| `POST /sso/logout/authorize`                                  |                                 |
| `POST /sso/token`                                             |                                 |
| `POST /user_management/authorize/device`                      |                                 |
| `POST /user_management/cors_origins`                          |                                 |
| `POST /user_management/redirect_uris`                         |                                 |
| `PUT /authorization/organizations/{}/roles/priority`          |                                 |
| `PUT /organizations/{}/audit_logs_retention`                  |                                 |
| `PUT /user_management/jwt_template`                           |                                 |

## In workos-node but NOT in Spec (20)

These are legacy, deprecated, or separate-product endpoints not present in the current OpenAPI spec.

| Endpoint                              | Notes                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `DELETE /fga/v1/resources/{}/{}`      | FGA v1 (separate product)                                                  |
| `DELETE /vault/v1/kv/{}`              | Vault v1 (separate product)                                                |
| `GET /fga/v1/resources/{}/{}`         | FGA v1 (separate product)                                                  |
| `GET /organizations/{}/roles`         | Different path pattern from spec's `/authorization/organizations/{}/roles` |
| `GET /vault/v1/kv/name/{}`            | Vault v1 (separate product)                                                |
| `GET /vault/v1/kv/{}`                 | Vault v1 (separate product)                                                |
| `GET /vault/v1/kv/{}/metadata`        | Vault v1 (separate product)                                                |
| `GET /vault/v1/kv/{}/versions`        | Vault v1 (separate product)                                                |
| `POST /fga/v1/check`                  | FGA v1 (separate product)                                                  |
| `POST /fga/v1/resources`              | FGA v1 (separate product)                                                  |
| `POST /fga/v1/resources/batch`        | FGA v1 (separate product)                                                  |
| `POST /fga/v1/warrants`               | FGA v1 (separate product)                                                  |
| `POST /passwordless/sessions`         | Deprecated passwordless API                                                |
| `POST /passwordless/sessions/{}/send` | Deprecated passwordless API                                                |
| `POST /vault/v1/keys/data-key`        | Vault v1 (separate product)                                                |
| `POST /vault/v1/keys/decrypt`         | Vault v1 (separate product)                                                |
| `POST /vault/v1/kv`                   | Vault v1 (separate product)                                                |
| `POST data-integrations/{}/token`     | Missing leading `/` — likely a source bug                                  |
| `PUT /fga/v1/resources/{}/{}`         | FGA v1 (separate product)                                                  |
| `PUT /vault/v1/kv/{}`                 | Vault v1 (separate product)                                                |

## Caveats

- **workos-node list endpoints**: Many list/paginated GET endpoints in workos-node are handled by a shared `fetchAndDeserialize` or `AutoPaginatable` helper that constructs the URL dynamically. Static grep analysis does not capture these, so the 134 count is a **lower bound**. The actual runtime coverage is likely closer to the spec's 154.
- **URL-construction-only endpoints**: Some spec endpoints (e.g., `GET /sso/authorize`, `GET /user_management/authorize`) are authorization URLs that the SDK constructs and returns as strings rather than making HTTP calls. These appear as "missing" from workos-node but are functionally present.
- **Path parameter normalization**: All path parameters are normalized to `{}` for comparison. The spec uses `<ID>`, the generated SDK uses `{paramName}`, and workos-node uses template literals like `${id}`.
