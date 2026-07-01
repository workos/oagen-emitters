# Changelog

## [0.19.7](https://github.com/workos/oagen-emitters/compare/v0.19.6...v0.19.7) (2026-07-01)


### Bug Fixes

* **php,dotnet:** serialize date-time request-body params correctly ([#180](https://github.com/workos/oagen-emitters/issues/180)) ([ae75374](https://github.com/workos/oagen-emitters/commit/ae7537463594505a533e980305ac50cd9a4bbdb8))
* two more scoped-generation orphan classes (rust unions + ruby inflections) ([#178](https://github.com/workos/oagen-emitters/issues/178)) ([8798fa6](https://github.com/workos/oagen-emitters/commit/8798fa6a909f4c0854d8a30af461140dcbd4d289))

## [0.19.6](https://github.com/workos/oagen-emitters/compare/v0.19.5...v0.19.6) (2026-07-01)


### Bug Fixes

* minimal scoped generation across all languages (fixtures + round-trip/forward-compat tests) ([#176](https://github.com/workos/oagen-emitters/issues/176)) ([25b943c](https://github.com/workos/oagen-emitters/commit/25b943cb398176aaa4ff2ff2c199e36f476a7238))

## [0.19.5](https://github.com/workos/oagen-emitters/compare/v0.19.4...v0.19.5) (2026-07-01)


### Bug Fixes

* **node:** scope the WorkOS client to the emit surface ([#173](https://github.com/workos/oagen-emitters/issues/173)) ([05016ba](https://github.com/workos/oagen-emitters/commit/05016ba1f43ae42436b6c84a97e9de7c84b1aaa4))
* **scoped:** complete the scoped-generation orphan fixes (rust client/manifest, ruby rbi/manifest) ([#172](https://github.com/workos/oagen-emitters/issues/172)) ([976f0d5](https://github.com/workos/oagen-emitters/commit/976f0d5a5d55240ecba40910cbfbbbae2a760c86))

## [0.19.4](https://github.com/workos/oagen-emitters/compare/v0.19.3...v0.19.4) (2026-07-01)


### Bug Fixes

* **rust:** barrel must list the emit surface, not the full spec ([#170](https://github.com/workos/oagen-emitters/issues/170)) ([4206282](https://github.com/workos/oagen-emitters/commit/4206282f9fcdd278d359d3c07c654a9b26c99fba))

## [0.19.3](https://github.com/workos/oagen-emitters/compare/v0.19.2...v0.19.3) (2026-06-30)


### Bug Fixes

* **python:** no empty models barrel for out-of-scope new services ([#168](https://github.com/workos/oagen-emitters/issues/168)) ([60e2cbb](https://github.com/workos/oagen-emitters/commit/60e2cbb17b8a67c312f4186ed9bb92946a9d104f))

## [0.19.2](https://github.com/workos/oagen-emitters/compare/v0.19.1...v0.19.2) (2026-06-30)


### Bug Fixes

* emitter compile failures in Go enums and PHP unions ([#166](https://github.com/workos/oagen-emitters/issues/166)) ([d1ae232](https://github.com/workos/oagen-emitters/commit/d1ae232650b499c55e26527dee287f965a906307))

## [0.19.1](https://github.com/workos/oagen-emitters/compare/v0.19.0...v0.19.1) (2026-06-25)


### Bug Fixes

* scope shared aggregates to emitted items in --services runs ([#164](https://github.com/workos/oagen-emitters/issues/164)) ([c137c6f](https://github.com/workos/oagen-emitters/commit/c137c6ffa16ae36237911b9778b85ca3a48e547e))

## [0.19.0](https://github.com/workos/oagen-emitters/compare/v0.18.4...v0.19.0) (2026-06-22)


### Features

* **emitters:** scope per-service emission for `--services` (all 8 emitters) ([#162](https://github.com/workos/oagen-emitters/issues/162)) ([651591b](https://github.com/workos/oagen-emitters/commit/651591bd0492b3160a12503e0a48a95b1d7ebbd7))

## [0.18.4](https://github.com/workos/oagen-emitters/compare/v0.18.3...v0.18.4) (2026-06-19)


### Bug Fixes

* comment correction ([f961fd1](https://github.com/workos/oagen-emitters/commit/f961fd138b79c29c379e4964a7ba313d82c30a36))
* cross-emitter domainName, Node owned-service fixes, Rust unions ([#161](https://github.com/workos/oagen-emitters/issues/161)) ([67e17ec](https://github.com/workos/oagen-emitters/commit/67e17ecb611e76303d49bd7ff724ee694ed121ef))
* cut patch release for refactor in [#159](https://github.com/workos/oagen-emitters/issues/159) ([4c4250b](https://github.com/workos/oagen-emitters/commit/4c4250bc2f2b82089f19c2b925de347dd40b9472))

## [0.18.3](https://github.com/workos/oagen-emitters/compare/v0.18.2...v0.18.3) (2026-06-17)


### Bug Fixes

* **dotnet:** emit envelope fixture for list-wrappers returned by non-paginated ops ([#157](https://github.com/workos/oagen-emitters/issues/157)) ([76e89b5](https://github.com/workos/oagen-emitters/commit/76e89b58592cfab9af07bdfc34f93d8569c9d220))
* **node:** only adopt named request interface for pure object-literal params ([#156](https://github.com/workos/oagen-emitters/issues/156)) ([50116e3](https://github.com/workos/oagen-emitters/commit/50116e320a9faa67691b89f97dc732f8b66405c5))

## [0.18.2](https://github.com/workos/oagen-emitters/compare/v0.18.1...v0.18.2) (2026-06-17)


### Bug Fixes

* **node:** adopt spec request interface for owned inline-literal params; dedupe common enums ([#154](https://github.com/workos/oagen-emitters/issues/154)) ([71e2d4f](https://github.com/workos/oagen-emitters/commit/71e2d4f4e05441a41217286b92a555237c3fd794))

## [0.18.1](https://github.com/workos/oagen-emitters/compare/v0.18.0...v0.18.1) (2026-06-17)


### Bug Fixes

* **node:** support owning services with hand-owned generic types ([#152](https://github.com/workos/oagen-emitters/issues/152)) ([aa8223d](https://github.com/workos/oagen-emitters/commit/aa8223dbb6b56f5c2ab12ac42e5a1fc9f9e99943))

## [0.18.0](https://github.com/workos/oagen-emitters/compare/v0.17.0...v0.18.0) (2026-06-16)


### Features

* **node:** emit discriminated unions for pure oneOf token response ([#150](https://github.com/workos/oagen-emitters/issues/150)) ([1433bcc](https://github.com/workos/oagen-emitters/commit/1433bcc2f61db52aeadd7b947b79bb90c184c0a1))

## [0.17.0](https://github.com/workos/oagen-emitters/compare/v0.16.1...v0.17.0) (2026-06-15)


### Features

* **node:** honor urlBuilder operation hint ([#146](https://github.com/workos/oagen-emitters/issues/146)) ([96bea6c](https://github.com/workos/oagen-emitters/commit/96bea6ca9807bca3ddeb96e1d7d20447c69bab97))


### Bug Fixes

* **go,kotlin,node:** preserve all variant fields on discriminated-union fields ([#148](https://github.com/workos/oagen-emitters/issues/148)) ([a4bd537](https://github.com/workos/oagen-emitters/commit/a4bd53769ef650b1df5dbd7d795760be0ecb3be3))
* **rust:** correct inline-envelope list decoding and empty inferred fields ([#145](https://github.com/workos/oagen-emitters/issues/145)) ([0a2b357](https://github.com/workos/oagen-emitters/commit/0a2b357788ebdd92b69534309c723beadb9b4240))

## [0.16.1](https://github.com/workos/oagen-emitters/compare/v0.16.0...v0.16.1) (2026-06-12)


### Bug Fixes

* **node:** emitter correctness fixes from SDK ownership rebuilds ([#139](https://github.com/workos/oagen-emitters/issues/139)) ([30010eb](https://github.com/workos/oagen-emitters/commit/30010eb8fa9882f5a731870d2d26a486f74dfe4e))

## [0.16.0](https://github.com/workos/oagen-emitters/compare/v0.15.2...v0.16.0) (2026-06-03)


### Features

* **snippets:** add snippet emitter family for seven languages ([#137](https://github.com/workos/oagen-emitters/issues/137)) ([1b4ee64](https://github.com/workos/oagen-emitters/commit/1b4ee640d47e8353726005b3fc953ffa0d160973))


### Bug Fixes

* **node:** improve test generation for owned services with hand-owned types ([#136](https://github.com/workos/oagen-emitters/issues/136)) ([3307621](https://github.com/workos/oagen-emitters/commit/3307621fbdfc3e719893a7691997fcbfc4a107d4))

## [0.15.2](https://github.com/workos/oagen-emitters/compare/v0.15.1...v0.15.2) (2026-06-01)


### Bug Fixes

* **node:** align AutoPaginatable type param with serialized runtime shape ([#134](https://github.com/workos/oagen-emitters/issues/134)) ([43ddd64](https://github.com/workos/oagen-emitters/commit/43ddd64d5d56b4ff2e7ae19bfa1ee895d24cb60d))

## [0.15.1](https://github.com/workos/oagen-emitters/compare/v0.15.0...v0.15.1) (2026-06-01)


### Bug Fixes

* **node:** resolve emitter bugs blocking service ownership migration ([#132](https://github.com/workos/oagen-emitters/issues/132)) ([e63cc06](https://github.com/workos/oagen-emitters/commit/e63cc06f948657965563a0d582ebbd9bedb1eb5f))

## [0.15.0](https://github.com/workos/oagen-emitters/compare/v0.14.4...v0.15.0) (2026-06-01)


### Features

* owned services, URL builders, unions, and fixes ([#131](https://github.com/workos/oagen-emitters/issues/131)) ([146113f](https://github.com/workos/oagen-emitters/commit/146113f440359e9648dae4a41bb5359784649b7e))


### Bug Fixes

* **renovate:** explicitly enable minor and patch updates ([#129](https://github.com/workos/oagen-emitters/issues/129)) ([4d5df35](https://github.com/workos/oagen-emitters/commit/4d5df35e2e4314acbbfb61f3b409fe88a9e404bf))

## [0.14.4](https://github.com/workos/oagen-emitters/compare/v0.14.3...v0.14.4) (2026-05-26)


### Bug Fixes

* **ruby:** avoid double-wrapping T.nilable and skip T.untyped ([#127](https://github.com/workos/oagen-emitters/issues/127)) ([e42083f](https://github.com/workos/oagen-emitters/commit/e42083f77773f3ae96b750577db36cde01b65f4f))

## [0.14.3](https://github.com/workos/oagen-emitters/compare/v0.14.2...v0.14.3) (2026-05-22)


### Bug Fixes

* include discriminator fields in generated fixtures ([#125](https://github.com/workos/oagen-emitters/issues/125)) ([6a3633e](https://github.com/workos/oagen-emitters/commit/6a3633e0e3f0497146bf89fc31a5dabc1152cce1))

## [0.14.2](https://github.com/workos/oagen-emitters/compare/v0.14.1...v0.14.2) (2026-05-22)


### Bug Fixes

* emit ListMetadata-shape models referenced by surviving wrappers ([#124](https://github.com/workos/oagen-emitters/issues/124)) ([8d8efe1](https://github.com/workos/oagen-emitters/commit/8d8efe148f3665fc9de92cc6aea0e08e77e0fe78))
* **node:** stop emitting duplicate Response-suffixed interfaces ([#123](https://github.com/workos/oagen-emitters/issues/123)) ([2077d25](https://github.com/workos/oagen-emitters/commit/2077d250d1dc7968245e9ec31d5ef5f75441fc68))
* **node:** use toBeNull() when example is null on date-time fields ([#121](https://github.com/workos/oagen-emitters/issues/121)) ([0f5029f](https://github.com/workos/oagen-emitters/commit/0f5029f38d2dafc63df09f49a4562e3ffeeb7558))

## [0.14.1](https://github.com/workos/oagen-emitters/compare/v0.14.0...v0.14.1) (2026-05-22)


### Bug Fixes

* emit non-paginated list wrappers, dotnet member/class collisions, rust glob ambiguity ([#120](https://github.com/workos/oagen-emitters/issues/120)) ([6df9822](https://github.com/workos/oagen-emitters/commit/6df98221dfa707800babce0d6a4cf1a653923743))
* **node:** carry forward prior-manifest paths so prune diffs stay accurate ([#117](https://github.com/workos/oagen-emitters/issues/117)) ([a03e4db](https://github.com/workos/oagen-emitters/commit/a03e4dbf2733e33ae4c31be568c2a12ea8361be1))
* **shared:** prevent synthetic-enum collision with IR enums ([#119](https://github.com/workos/oagen-emitters/issues/119)) ([0211f66](https://github.com/workos/oagen-emitters/commit/0211f669b51da3a14717dfa61941c954dc7edaa6))

## [0.14.0](https://github.com/workos/oagen-emitters/compare/v0.13.0...v0.14.0) (2026-05-21)


### Features

* discriminated-union output across Node, Ruby, PHP, Rust ([#115](https://github.com/workos/oagen-emitters/issues/115)) ([1ff5fbf](https://github.com/workos/oagen-emitters/commit/1ff5fbf4f1ce0dcdce0bf8691aa9d0d00e6f94b1))

## [0.13.0](https://github.com/workos/oagen-emitters/compare/v0.12.5...v0.13.0) (2026-05-20)


### Features

* **shared:** standardize Service suffix for class-name collisions ([#113](https://github.com/workos/oagen-emitters/issues/113)) ([15be2e5](https://github.com/workos/oagen-emitters/commit/15be2e52adeb634108f192b16c95d5b1c18e4584))

## [0.12.5](https://github.com/workos/oagen-emitters/compare/v0.12.4...v0.12.5) (2026-05-19)


### Bug Fixes

* **node:** skip dead deserializers and strengthen all-optional body tests ([#111](https://github.com/workos/oagen-emitters/issues/111)) ([632bd82](https://github.com/workos/oagen-emitters/commit/632bd8257d4139ab53895b5225fffd6913702e3b))

## [0.12.4](https://github.com/workos/oagen-emitters/compare/v0.12.3...v0.12.4) (2026-05-19)


### Bug Fixes

* **node:** emit serializers/index.ts barrel for owned and adopted services ([#109](https://github.com/workos/oagen-emitters/issues/109)) ([e176552](https://github.com/workos/oagen-emitters/commit/e17655296de50c9df759b84273b104ae828cd08e))

## [0.12.3](https://github.com/workos/oagen-emitters/compare/v0.12.2...v0.12.3) (2026-05-18)


### Bug Fixes

* **node:** generate tests for adopted services and fix related bugs ([#107](https://github.com/workos/oagen-emitters/issues/107)) ([abe877b](https://github.com/workos/oagen-emitters/commit/abe877bd6489365d0f145a1739a7c449b15760c2))

## [0.12.2](https://github.com/workos/oagen-emitters/compare/v0.12.1...v0.12.2) (2026-05-15)


### Bug Fixes

* **deps:** update minor and patch updates ([#101](https://github.com/workos/oagen-emitters/issues/101)) ([84bf149](https://github.com/workos/oagen-emitters/commit/84bf149ca176c0c7fa3d7a5bd7a38c3f108fbc75))

## [0.12.1](https://github.com/workos/oagen-emitters/compare/v0.12.0...v0.12.1) (2026-05-13)


### Bug Fixes

* align rust sdk better with other languages ([0fc7cdc](https://github.com/workos/oagen-emitters/commit/0fc7cdcfc5493bfc402fe8411bb398646b6e69a9))

## [0.12.0](https://github.com/workos/oagen-emitters/compare/v0.11.0...v0.12.0) (2026-05-11)


### Features

* **rust:** add Rust emitter ([#97](https://github.com/workos/oagen-emitters/issues/97)) ([363942e](https://github.com/workos/oagen-emitters/commit/363942e977cf540538af266f8132495b02e18f22))


### Bug Fixes

* **python:** emit request path as tuple of segments ([#98](https://github.com/workos/oagen-emitters/issues/98)) ([64f4f6f](https://github.com/workos/oagen-emitters/commit/64f4f6fb5481bdcee328403d1cf7a31cab7126d8))

## [0.11.0](https://github.com/workos/oagen-emitters/compare/v0.10.0...v0.11.0) (2026-05-07)


### ⚠ BREAKING CHANGES

* code that previously caught a TypeError from a typed property assignment, or that read $data passthrough from an unmatched union variant, will instead need to handle \UnexpectedValueException at the fromArray() call site. Every generated PHP SDK with a discriminated union model is affected.

### Bug Fixes

* surface schema/SDK drift across PHP, Python, Go, Ruby emitters ([#94](https://github.com/workos/oagen-emitters/issues/94)) ([558c55c](https://github.com/workos/oagen-emitters/commit/558c55cc851e16f27a6a2e7eb577442557827be7))


### Miscellaneous Chores

* release as 0.11.0 ([a448006](https://github.com/workos/oagen-emitters/commit/a448006a0a20674bd91971de1f4b56e81ffcb76d))

## [0.10.0](https://github.com/workos/oagen-emitters/compare/v0.9.1...v0.10.0) (2026-05-06)


### Features

* **dotnet:** honor enum default as zero variant ([#92](https://github.com/workos/oagen-emitters/issues/92)) ([3fbb5d5](https://github.com/workos/oagen-emitters/commit/3fbb5d5f53fa66f1a3b4f2cb08c069e9d2d2a1fc))

## [0.9.1](https://github.com/workos/oagen-emitters/compare/v0.9.0...v0.9.1) (2026-05-06)


### Bug Fixes

* oagen bump ([1ab0a55](https://github.com/workos/oagen-emitters/commit/1ab0a551ca567b09dec22cd3f75adda33d2cb550))

## [0.9.0](https://github.com/workos/oagen-emitters/compare/v0.8.2...v0.9.0) (2026-05-06)


### Features

* **kotlin:** improve emitter output for SDK review feedback ([#90](https://github.com/workos/oagen-emitters/issues/90)) ([14180eb](https://github.com/workos/oagen-emitters/commit/14180eb7919a89a9b08406bc6bc06a35df887e65))


### Bug Fixes

* **kotlin:** make ktlintFormat actually run after generation ([#88](https://github.com/workos/oagen-emitters/issues/88)) ([6082a45](https://github.com/workos/oagen-emitters/commit/6082a45ab2b247bbf4630cd0acc6dba5238f5d26))

## [0.8.2](https://github.com/workos/oagen-emitters/compare/v0.8.1...v0.8.2) (2026-05-05)


### Bug Fixes

* **kotlin:** improve emitter output quality ([#86](https://github.com/workos/oagen-emitters/issues/86)) ([6dd9b2a](https://github.com/workos/oagen-emitters/commit/6dd9b2ad6904ebb088cba65801d4987a2af61482))

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
