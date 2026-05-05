# Changelog

## [0.8.1](https://github.com/workos/oagen-emitters/compare/v0.8.0...v0.8.1) (2026-05-05)


### Bug Fixes

* **emitters:** repair regressions surfaced by shared-schema spec rev ([#84](https://github.com/workos/oagen-emitters/issues/84)) ([a04d317](https://github.com/workos/oagen-emitters/commit/a04d3170707adea21f19632f2a149b735be91d50))

## [0.8.0](https://github.com/workos/oagen-emitters/compare/v0.7.5...v0.8.0) (2026-05-05)


### Features

* **emitters:** dispatch field-level discriminated unions and drop dead request bodies ([#81](https://github.com/workos/oagen-emitters/issues/81)) ([4d38d24](https://github.com/workos/oagen-emitters/commit/4d38d249dcc7079e2a61d8faeabb681d6798618f))


### Bug Fixes

* **go:** stop SSO auth code leaking into request URL ([#83](https://github.com/workos/oagen-emitters/issues/83)) ([bc520e6](https://github.com/workos/oagen-emitters/commit/bc520e6a3d966abdf785262e5c49736b5e105b92))

## [0.7.5](https://github.com/workos/oagen-emitters/compare/v0.7.4...v0.7.5) (2026-05-03)


### Bug Fixes

* bump deps ([#79](https://github.com/workos/oagen-emitters/issues/79)) ([00ddbf7](https://github.com/workos/oagen-emitters/commit/00ddbf70e94323370b0915da0f877f332f82d146))

## [0.7.4](https://github.com/workos/oagen-emitters/compare/v0.7.3...v0.7.4) (2026-05-02)


### Bug Fixes

* update dep ([e6145b6](https://github.com/workos/oagen-emitters/commit/e6145b694b9cacaa086234ba97b48c6e4108c084))

## [0.7.3](https://github.com/workos/oagen-emitters/compare/v0.7.2...v0.7.3) (2026-05-02)


### Bug Fixes

* url-encode path parameters in php/node/python/kotlin emitters ([#75](https://github.com/workos/oagen-emitters/issues/75)) ([34c08fc](https://github.com/workos/oagen-emitters/commit/34c08fc10510db53f1f989edab5b4d0cead15aa9))

## [0.7.2](https://github.com/workos/oagen-emitters/compare/v0.7.1...v0.7.2) (2026-05-01)


### Bug Fixes

* **php:** wrap degenerate-union models in fromArray/toArray ([#72](https://github.com/workos/oagen-emitters/issues/72)) ([053d34a](https://github.com/workos/oagen-emitters/commit/053d34adcbbecbed6793c54c4fd48a03aef97f21))

## [0.7.1](https://github.com/workos/oagen-emitters/compare/v0.7.0...v0.7.1) (2026-05-01)


### Bug Fixes

* **python:** use explicit re-export form in service __init__.py ([#70](https://github.com/workos/oagen-emitters/issues/70)) ([5fcbb83](https://github.com/workos/oagen-emitters/commit/5fcbb83cc2c87278df2b6f055ccdcaa6efb97ad4))

## [0.7.0](https://github.com/workos/oagen-emitters/compare/v0.6.8...v0.7.0) (2026-04-30)


### Features

* thread modelHints through assignModelsToServices call sites ([#68](https://github.com/workos/oagen-emitters/issues/68)) ([1ad5acd](https://github.com/workos/oagen-emitters/commit/1ad5acdda7eeb6a0f24bdd26c6144a76e82157f2))

## [0.6.8](https://github.com/workos/oagen-emitters/compare/v0.6.7...v0.6.8) (2026-04-30)


### Bug Fixes

* **ruby:** emit typed variant classes for parameter groups ([#66](https://github.com/workos/oagen-emitters/issues/66)) ([7699417](https://github.com/workos/oagen-emitters/commit/7699417e27da719487bdaf3c74bee0a759c77705))

## [0.6.7](https://github.com/workos/oagen-emitters/compare/v0.6.6...v0.6.7) (2026-04-28)


### Bug Fixes

* cross-domain aliases and minor emitter fixes ([#65](https://github.com/workos/oagen-emitters/issues/65)) ([9f305ce](https://github.com/workos/oagen-emitters/commit/9f305ce68c008d4341b254eafa0e0d5c0ce59598))
* **dotnet:** mark discriminator property as internal set on base class ([#63](https://github.com/workos/oagen-emitters/issues/63)) ([dcd32bc](https://github.com/workos/oagen-emitters/commit/dcd32bcc327b54995e078f7a3767198a4d87fa5b))

## [0.6.6](https://github.com/workos/oagen-emitters/compare/v0.6.5...v0.6.6) (2026-04-28)


### Bug Fixes

* **dotnet:** prevent infinite recursion in discriminator converter WriteJson ([#59](https://github.com/workos/oagen-emitters/issues/59)) ([b2a2b7e](https://github.com/workos/oagen-emitters/commit/b2a2b7e1d18348423debb40ca6c331b4b7a34dc2))
* **go:** resolve test fixture paths through dedup rewrite map ([#58](https://github.com/workos/oagen-emitters/issues/58)) ([815750a](https://github.com/workos/oagen-emitters/commit/815750a9eef8d8c3883ab505848e585732a02a05))
* **python:** emit non-spec imports as plain imports instead of ignore block ([#60](https://github.com/workos/oagen-emitters/issues/60)) ([bf86e0c](https://github.com/workos/oagen-emitters/commit/bf86e0cfbb3ce7b48454be68d0f9fcfe5f6265c4))

## [0.6.5](https://github.com/workos/oagen-emitters/compare/v0.6.4...v0.6.5) (2026-04-28)


### Bug Fixes

* **python,kotlin,dotnet:** skip literal defaults for optional fields; fix dotnet JsonConverter nullability ([#56](https://github.com/workos/oagen-emitters/issues/56)) ([78d4c4c](https://github.com/workos/oagen-emitters/commit/78d4c4c303d67f7399d799dc37ad06d8e8997faa))

## [0.6.4](https://github.com/workos/oagen-emitters/compare/v0.6.3...v0.6.4) (2026-04-28)


### Bug Fixes

* **dotnet,kotlin:** restore fields on discriminated base models ([#54](https://github.com/workos/oagen-emitters/issues/54)) ([6928b8f](https://github.com/workos/oagen-emitters/commit/6928b8f5012d2dc77069950cb438a72963086277))
* **php,python:** use fallback defaults for literal fields during deserialization ([#55](https://github.com/workos/oagen-emitters/issues/55)) ([0affb47](https://github.com/workos/oagen-emitters/commit/0affb47296f14121e2797545edc0b6fa0f8ba30f))
* **ruby:** eagerly load configuration.rb to fix WorkOS.configure ([#52](https://github.com/workos/oagen-emitters/issues/52)) ([fc99d36](https://github.com/workos/oagen-emitters/commit/fc99d365fe14778fa3e000335ead369dfe7abec6))

## [0.6.3](https://github.com/workos/oagen-emitters/compare/v0.6.2...v0.6.3) (2026-04-27)


### Bug Fixes

* PHP grouped body params and Go discriminated union base fields ([#50](https://github.com/workos/oagen-emitters/issues/50)) ([b72ee16](https://github.com/workos/oagen-emitters/commit/b72ee166fd48ff0c20346f8603a7e70665a1ff8a))

## [0.6.2](https://github.com/workos/oagen-emitters/compare/v0.6.1...v0.6.2) (2026-04-26)


### Bug Fixes

* use per-operation mountOn in manifest service field ([#48](https://github.com/workos/oagen-emitters/issues/48)) ([f55bf72](https://github.com/workos/oagen-emitters/commit/f55bf72c9b3011785a060f079dd8fc0ed9984af4))

## [0.6.1](https://github.com/workos/oagen-emitters/compare/v0.6.0...v0.6.1) (2026-04-25)


### Bug Fixes

* **php:** exclude grouped body params from signature, PHPDoc, and body array ([#46](https://github.com/workos/oagen-emitters/issues/46)) ([7772c8a](https://github.com/workos/oagen-emitters/commit/7772c8a9c167155009fb81f48af67680287db93e))

## [0.6.0](https://github.com/workos/oagen-emitters/compare/v0.5.0...v0.6.0) (2026-04-24)


### Features

* extract plugin bundle and move manifest ownership to framework ([#44](https://github.com/workos/oagen-emitters/issues/44)) ([6a8c3a9](https://github.com/workos/oagen-emitters/commit/6a8c3a9897bf9952e83b7143037a97b0c5ecc508))

## [0.5.0](https://github.com/workos/oagen-emitters/compare/v0.4.0...v0.5.0) (2026-04-24)


### Features

* multi-language emitter improvements, parameter groups, and JSDoc fixes ([#40](https://github.com/workos/oagen-emitters/issues/40)) ([6d32479](https://github.com/workos/oagen-emitters/commit/6d3247911cbf39c66539a0cda441893fe8ef4748))
* **python:** add implicit discriminator detection with unknown fallback variant ([#42](https://github.com/workos/oagen-emitters/issues/42)) ([b7fec64](https://github.com/workos/oagen-emitters/commit/b7fec644b906a446bb6d8f98d04f8641131c4d2e))

## [0.4.0](https://github.com/workos/oagen-emitters/compare/v0.3.0...v0.4.0) (2026-04-14)


### Features

* add dotnet and kotlin emitters with shared generator fixes ([#35](https://github.com/workos/oagen-emitters/issues/35)) ([d84896f](https://github.com/workos/oagen-emitters/commit/d84896f8277f24e7a7800640fca8317e3d5479de))

## [0.3.0](https://github.com/workos/oagen-emitters/compare/v0.2.1...v0.3.0) (2026-04-09)


### Features

* Improve PHP and Python emitter generation ([#30](https://github.com/workos/oagen-emitters/issues/30)) ([9f4aa98](https://github.com/workos/oagen-emitters/commit/9f4aa981a35e125a6e9316bb91b666eaf0e2d2bd))
* oagen-emitter updates to handle Golang ([#33](https://github.com/workos/oagen-emitters/issues/33)) ([bf8b872](https://github.com/workos/oagen-emitters/commit/bf8b872a93f20c77f64e6cec9657adfd24d14871))

## [0.2.1](https://github.com/workos/oagen-emitters/compare/v0.2.0...v0.2.1) (2026-03-26)


### Bug Fixes

* enhance Node emitter ([#8](https://github.com/workos/oagen-emitters/issues/8)) ([e409025](https://github.com/workos/oagen-emitters/commit/e4090259784790aed0d4e9c1d98bb4bab3b6ce67))

## [0.2.0](https://github.com/workos/oagen-emitters/compare/v0.1.1...v0.2.0) (2026-03-25)


### Features

* **node:** resolve Node emitter generation correctness, typing, and test coverage gapsCorrections ([#5](https://github.com/workos/oagen-emitters/issues/5)) ([8061bb4](https://github.com/workos/oagen-emitters/commit/8061bb41c993d4a4db6df91e35721f87e476010a))

## [0.1.1](https://github.com/workos/oagen-emitters/compare/v0.1.0...v0.1.1) (2026-03-23)


### Bug Fixes

* add repository url to package.json for npm provenance ([b6ecff3](https://github.com/workos/oagen-emitters/commit/b6ecff3684721e4340d0748ed19ea7ec31dcab4f))
* force fixed oagen ([#4](https://github.com/workos/oagen-emitters/issues/4)) ([ede66c3](https://github.com/workos/oagen-emitters/commit/ede66c3e928c9e9c647755e47c741448bcfa7a2c))

## [0.1.0](https://github.com/workos/oagen-emitters/compare/v0.0.1...v0.1.0) (2026-03-23)


### Features

* add all the commands ([007fe1d](https://github.com/workos/oagen-emitters/commit/007fe1de39ed3a6805ad757040bf6bac8a8ce2a8))
* add foundational extractors and smoke tests ([0f637a3](https://github.com/workos/oagen-emitters/commit/0f637a330536e073ab6a926040bc10bcc6126848))
* client fixes ([#1](https://github.com/workos/oagen-emitters/issues/1)) ([3be4eaa](https://github.com/workos/oagen-emitters/commit/3be4eaa826dd6f0e0166fbdc60126814ec0c82d4))
* **node:** add full IR field parity for docs and annotations ([a6b1ce6](https://github.com/workos/oagen-emitters/commit/a6b1ce6bc80306d61b812008b077ab9a600cafea))
* **node:** emit [@throws](https://github.com/throws) JSDoc tags from operation error responses ([0ddab44](https://github.com/workos/oagen-emitters/commit/0ddab44365fcba7efd2ef81cdeab782e27471839))
* **node:** enhance generated test quality with body, field, and error assertions ([3029642](https://github.com/workos/oagen-emitters/commit/30296427eda26b3dd7c1b2ab2a236fe65581276e))
* **node:** handle multiline docstrings and [@deprecated](https://github.com/deprecated) across all IR types ([53c3bb2](https://github.com/workos/oagen-emitters/commit/53c3bb20d23faabd676fbb1ecfb7adb3eb64e9f5))
* **node:** remove file header and add [@param](https://github.com/param) tags to method docstrings ([8680da2](https://github.com/workos/oagen-emitters/commit/8680da28e42a7a18c0303622b6df2a1f8470ac58))
* **node:** use overlay-resolved service names across all emitter modules ([550d13f](https://github.com/workos/oagen-emitters/commit/550d13f50a9e83d5c7c9fbc8a7d2b7fbf01fed79))
* **smoke:** apply wave-based planning to Go/Rust/Kotlin/DotNet/Elixir runners ([7677831](https://github.com/workos/oagen-emitters/commit/7677831df5fd7933eca63371b7392650f35b2668))


### Bug Fixes

* add .prettierignore to exclude auto-generated CHANGELOG.md ([ee61899](https://github.com/workos/oagen-emitters/commit/ee6189965188b1e5ad2bcdb6c09d9828221eecb4))
* align test fixtures with current oagen EmitterContext and IR types ([ee85034](https://github.com/workos/oagen-emitters/commit/ee850341e7b132c1ea6df82d1ac8394811ac1e3c))
* change package name ([40d6a7d](https://github.com/workos/oagen-emitters/commit/40d6a7d93465f29bfc6ba0f6ea1a2982820b4452))
* lint ([4691e33](https://github.com/workos/oagen-emitters/commit/4691e33d8e181507c8871f14f018b61a08b7ed5b))
* **node:** avoid ResponseResponse stutter with wireInterfaceName helper ([7c1d2de](https://github.com/workos/oagen-emitters/commit/7c1d2de367177e10662308423b76d5627c06a0c3))
* **node:** fall through to non-paginated rendering when response has no named model ([1a6562e](https://github.com/workos/oagen-emitters/commit/1a6562edad5ea59ede95b8269d93fbaf3937fdba))
* **node:** fix paginated path params, duplicate returns, missing imports, and untyped payloads ([f57f5df](https://github.com/workos/oagen-emitters/commit/f57f5dfaaaae6e65166af27d5ffcd987411f2388))
* **node:** guard against null responseModel in paginated method generation ([5555023](https://github.com/workos/oagen-emitters/commit/55550234e076af604c9234a047c476c115501f18))
* **node:** mark scaffold-only files with integrateTarget: false ([546cd58](https://github.com/workos/oagen-emitters/commit/546cd5839a6a719690cec91694f162898e367272))
* rename ([d1bcf84](https://github.com/workos/oagen-emitters/commit/d1bcf84e6cffd6e6d509173a0e0631a402ca701d))
* simple fix for HTTP verbs ([1cbef9f](https://github.com/workos/oagen-emitters/commit/1cbef9f3b6cafc301c51aa1316c3596df02faae0))
* these were (temporarily) removed ([12c98d7](https://github.com/workos/oagen-emitters/commit/12c98d700507a4e921cf9c3769c7981c6c9942c4))
* update workflow to use proper token ([1074afc](https://github.com/workos/oagen-emitters/commit/1074afce953c565389cbb0d95c99d81e2b7aef2b))


### Reverts

* **node:** restore auto-generated file header ([32738ea](https://github.com/workos/oagen-emitters/commit/32738eababbd0fac903c2d7a68f5a59e24d39e6d))
