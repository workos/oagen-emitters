# Changelog

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
