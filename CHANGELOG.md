# Changelog

## [0.7.0](https://github.com/sirtimbly/coleo/compare/coleo-v0.6.0...coleo-v0.7.0) (2026-07-29)


### Features

* design for dense pages ([4a51b25](https://github.com/sirtimbly/coleo/commit/4a51b2588a7421a282d494413633b4c9da83c9b6))
* redesign tasks and other pages for accordion layout ([6929585](https://github.com/sirtimbly/coleo/commit/6929585155e8a4880da2a1e64229442ed7e76530))
* **setup:** expand project editor workflow ([0b384fc](https://github.com/sirtimbly/coleo/commit/0b384fc00a82fd9ec18c18b70bf27fb16b0fe97b))
* **web:** streamline task planning and section summaries ([94a6813](https://github.com/sirtimbly/coleo/commit/94a681391245329dca9534def53d44472ece40fe))


### Bug Fixes

* preserve filtered pagination and status history ([edfd99b](https://github.com/sirtimbly/coleo/commit/edfd99bab5a562fc6b2dfb86625138deb62e2544))
* **web:** restore dashboard progress and telemetry data ([9f52b89](https://github.com/sirtimbly/coleo/commit/9f52b893a55a9cd28c85f52419b579de66b64d36))


### Performance Improvements

* **web:** optimize task list rendering and updates ([3265c3c](https://github.com/sirtimbly/coleo/commit/3265c3c24e991bf002d05b42ab498656fb0e95e8))

## [0.6.0](https://github.com/sirtimbly/coleo/compare/coleo-v0.5.0...coleo-v0.6.0) (2026-07-28)


### Features

* arm usage stats and history ([2cdb05a](https://github.com/sirtimbly/coleo/commit/2cdb05a65f5210adb7889a02a159372a6d4010ae))
* **arms:** surface open-code model and message cost metadata ([864ad53](https://github.com/sirtimbly/coleo/commit/864ad539f9adceb0b8c592b11bf8646db5bba619))
* **arms:** surface open-code model and message cost metadata ([f6bcfe5](https://github.com/sirtimbly/coleo/commit/f6bcfe5d416ceb6285feb0e80099dd8b71293744))
* fetch simple data ([6fdc9da](https://github.com/sirtimbly/coleo/commit/6fdc9dad57058ffec9d913fb495f09529b039d14))
* manually complete tasks ([2d8ab57](https://github.com/sirtimbly/coleo/commit/2d8ab5765c5a7ad56ea38634aa4a5da169b0c2d3))
* pick stats on arms by datetime ([4914ba7](https://github.com/sirtimbly/coleo/commit/4914ba73bffbd425f025750aaa7ad117b5b7e4f6))
* **tasks:** add task preparation agent from discussions ([8123e0f](https://github.com/sirtimbly/coleo/commit/8123e0fdcabc14cdcaee12a9b67ae7a924bec56a))
* **tasks:** show live checklist progress ([cd18c58](https://github.com/sirtimbly/coleo/commit/cd18c5881708293b981dccc6cb5662f5a88398f7))
* **web:** add arm activity and efficiency visualization ([81e1d68](https://github.com/sirtimbly/coleo/commit/81e1d680553c18d07dd8fd607693860b154657a8))
* **web:** add context usage visualization with 80% threshold ([46101ac](https://github.com/sirtimbly/coleo/commit/46101ac9daf07239d3e81940c4af0c68e727d9fd))
* **web:** add cost visualization with $/hr rate and budget threshold ([487973c](https://github.com/sirtimbly/coleo/commit/487973ce62a804218e92e6173fe51b0df28515b5))
* **web:** add high-performance multi-tabbed grid view with virtualization ([3fbaaae](https://github.com/sirtimbly/coleo/commit/3fbaaaeaa9ed323327641cf2f60af40292516693))
* **web:** add statistics and cost graphs ([7fc1b3b](https://github.com/sirtimbly/coleo/commit/7fc1b3bf8a12262ca566018908f9eb3966be2627))
* **web:** pin context chart to dashboard arm activity section ([987e38f](https://github.com/sirtimbly/coleo/commit/987e38fcb09aa136ac815e80853686ee9378aa47))


### Bug Fixes

* **web:** align setup API client contracts ([c75840e](https://github.com/sirtimbly/coleo/commit/c75840e64acabf2b00001a2192182ea5f1379cb0))


### Code Refactoring

* **web:** deduplicate arm cost samples by message id and compute cumulative on the fly ([a6f01e2](https://github.com/sirtimbly/coleo/commit/a6f01e29f30cb6f8d17f5486d9b73989fc56a44d))
* **web:** sharpen cost helpers' types ([059fe3f](https://github.com/sirtimbly/coleo/commit/059fe3f3b3eeab66270e9bd0b770091426460e26))


### Continuous Integration

* upgrade actions and release notes ([528914a](https://github.com/sirtimbly/coleo/commit/528914a36312b8f645a88667540c7b6ab23aea4d))


### Documentation

* link hosted Coleo preview ([11ac7a8](https://github.com/sirtimbly/coleo/commit/11ac7a8445e64d8f4ca69bbf929f41aaa4333377))
* link hosted Coleo preview ([8238612](https://github.com/sirtimbly/coleo/commit/82386120176c501d2e6cea81b7bae35ab226f939))


### Tests

* **web:** cover arm activity chart classifier ([a3818ac](https://github.com/sirtimbly/coleo/commit/a3818ac2ab1681f87f855530e4d37c23a29e2267))
* **web:** cover mergeCostSamples deduplication behavior ([2ce5d91](https://github.com/sirtimbly/coleo/commit/2ce5d911e061dc0fc6312c8ec257c734ec7737b0))
* **web:** cover mergeCostSamples deduplication behavior ([88bf545](https://github.com/sirtimbly/coleo/commit/88bf545025fa60de6753f2613084f2f8c29d56ea))
* **web:** refine mergeCostSamples assertion style ([6d6c392](https://github.com/sirtimbly/coleo/commit/6d6c3925d84e8b6726d4bb679b1dc2b7e5e2cf50))
* **web:** refine mergeCostSamples assertion style ([d73de1d](https://github.com/sirtimbly/coleo/commit/d73de1d25e27cf27e28ad124e111cecfeda20ca7))

## [0.5.0](https://github.com/sirtimbly/coleo/compare/coleo-v0.4.1...coleo-v0.5.0) (2026-07-27)


### Features

* advanced grid ui tasks and bugs ([bc62679](https://github.com/sirtimbly/coleo/commit/bc62679b81e589ad7449a046f0e9d1af71f74836))
* manually complete tasks ([4af8d80](https://github.com/sirtimbly/coleo/commit/4af8d80805f2472986caa65947a69b73ffed9df1))


### Bug Fixes

* **web:** align setup API client contracts ([87ccad8](https://github.com/sirtimbly/coleo/commit/87ccad88ddd8a60cf592744face7f92eeee12438))


### Continuous Integration

* upgrade actions and release notes ([c350c7a](https://github.com/sirtimbly/coleo/commit/c350c7a0cf3b8dc8266d59071aee6aa49f56f5a6))
* upgrade actions and release notes ([7d24d85](https://github.com/sirtimbly/coleo/commit/7d24d853ed37c659c3912225eca2f035a3c1c99d))

## [0.4.1](https://github.com/sirtimbly/coleo/compare/coleo-v0.4.0...coleo-v0.4.1) (2026-07-22)


### Bug Fixes

* **release:** align release tags and changelog sections ([6df281a](https://github.com/sirtimbly/coleo/commit/6df281a8a271172143ddccffc28a627315d733d2))
* **release:** align release tags and changelog sections ([f56386e](https://github.com/sirtimbly/coleo/commit/f56386e91618e9bee3ff2fa3962e51c9f3322962))


### Code Refactoring

* **web:** mail ui selection and modals ([bfc4716](https://github.com/sirtimbly/coleo/commit/bfc4716c559aa30ef59136b549c04a529bb67c5a))

## [0.4.0](https://github.com/sirtimbly/coleo/compare/coleo-v0.3.0...coleo-v0.4.0) (2026-07-22)


### Features

* add brain model configuration and task coordination updates ([#36](https://github.com/sirtimbly/coleo/issues/36)) ([6f0d342](https://github.com/sirtimbly/coleo/commit/6f0d3425878307c5e7d5097f608b806456244079))
* **api:** add arm status history endpoint ([c1c4bd7](https://github.com/sirtimbly/coleo/commit/c1c4bd7969fd5a7eb37f036d562cfa5c11c34767))
* arm interrupt ([343e2d6](https://github.com/sirtimbly/coleo/commit/343e2d682078e20e4d5455909b7683c49f04a7dd))
* **brain:** apply bug priority responses ([bcfbe4d](https://github.com/sirtimbly/coleo/commit/bcfbe4dc5afa430bbd541491436c36c0e31eb071))
* **nats:** consume status history events ([8b1d07c](https://github.com/sirtimbly/coleo/commit/8b1d07cf9ee553417ae1020384e52fe670484922))
* **tasks:** add blocked task review workflow ([bbe82a1](https://github.com/sirtimbly/coleo/commit/bbe82a168e2b621da64a5979b3ab07cd7ed979d3))
* **tasks:** regenerate queue from project plan ([439a793](https://github.com/sirtimbly/coleo/commit/439a793f5e3f0b83db498c657de3bddeb1351b50))
* **tasks:** regenerate queue from project plan ([42497ae](https://github.com/sirtimbly/coleo/commit/42497aea9644610b6410775ed6c98e17a348e6f6))
* **vector:** backfill completed tasks ([a7d5c08](https://github.com/sirtimbly/coleo/commit/a7d5c089953796886286bf496ddd91548a4da89d))
* **vector:** embed complete status events ([aed0259](https://github.com/sirtimbly/coleo/commit/aed0259b96a8daf36d6db7b83371922aa8c8a571))
* **web:** add status history search page ([c8ac126](https://github.com/sirtimbly/coleo/commit/c8ac126d5cb6666f558422ad71cab0e35a577e9b))
* **web:** add task burndown analytics ([81fcd10](https://github.com/sirtimbly/coleo/commit/81fcd106c91ab1862d90a2300a58ceb61d7d7c7b))
* **web:** add task regeneration dialog ([3493049](https://github.com/sirtimbly/coleo/commit/3493049d1ef58261d96222604f0bb6b3681891f2))
* **web:** add task to arm in garden ([cda9de6](https://github.com/sirtimbly/coleo/commit/cda9de634bbbfdf9e74915e8a197827d2f3ac35f))
* **web:** expose task workflow controls ([0ce6345](https://github.com/sirtimbly/coleo/commit/0ce63457d5c098d49694d05d766d431d098ae296))
* **web:** link notable events to history search ([7cddf2d](https://github.com/sirtimbly/coleo/commit/7cddf2da1c6a03984c9932f1ba4015e786aecf93))


### Bug Fixes

* **brain:** advance past completing tasks ([3b89984](https://github.com/sirtimbly/coleo/commit/3b899848feccb28afa1fea15a7f6ffd0edacdce0))
* **brain:** default to gpt-5.6-luna ([31de47c](https://github.com/sirtimbly/coleo/commit/31de47cb81f18f1a65006ee3716876e1aa86395b))
* **brain:** route task approval mail correctly ([40b9d33](https://github.com/sirtimbly/coleo/commit/40b9d332c9ba964f865de9e95599df0cf6d0f435))
* exclude archived bugs from stats ([f7f8e6e](https://github.com/sirtimbly/coleo/commit/f7f8e6e3a1ef78ba47e9ce75e2ec3afc7e3c4f51))
* **release:** build package before publishing ([#30](https://github.com/sirtimbly/coleo/issues/30)) ([9067a8d](https://github.com/sirtimbly/coleo/commit/9067a8df550517893c2c2421bb50ec9f1d4654c8))
* **release:** match npm trusted repository ([#34](https://github.com/sirtimbly/coleo/issues/34)) ([a5deb3c](https://github.com/sirtimbly/coleo/commit/a5deb3cdfa551d274d9472e1b1f307426b686a46))
* **release:** normalize cli bin metadata ([#35](https://github.com/sirtimbly/coleo/issues/35)) ([778a2cf](https://github.com/sirtimbly/coleo/commit/778a2cfcc8243abe5bfa0256a94e9947ddba6b47))
* **release:** preserve executable cli bin ([#32](https://github.com/sirtimbly/coleo/issues/32)) ([4730f74](https://github.com/sirtimbly/coleo/commit/4730f7496b9c743104bb9c7db4c5c7d40d751b54))
* **release:** retain npm bin entry ([#33](https://github.com/sirtimbly/coleo/issues/33)) ([7ca9b12](https://github.com/sirtimbly/coleo/commit/7ca9b12b47a0f0c723cfacdc12e45f5d525d87d4))
* restore brain workflows and burndown timestamps ([002a9a1](https://github.com/sirtimbly/coleo/commit/002a9a1027003372124a3d8ea3d3caf8a755d3f2))
* **tasks:** preserve phase context in descriptions ([a633a8a](https://github.com/sirtimbly/coleo/commit/a633a8a6a7b00859c407d6e563bdcb1d21f04d65))
* **tasks:** preserve resumable and completed work ([38965c0](https://github.com/sirtimbly/coleo/commit/38965c02a8e34c4b0f9c3ad122a073e43a6a2738))
* **web:** preserve task editor theme on focus ([054eff7](https://github.com/sirtimbly/coleo/commit/054eff77355b623f1a4ee9efceb92f3de19c6d48))

## [0.3.0](https://github.com/sirtimbly/coleo/compare/coleo-v0.2.0...coleo-v0.3.0) (2026-07-17)


### Features

* Adapt messaging page style to Viewer and Tasks pages ([096b36d](https://github.com/sirtimbly/coleo/commit/096b36dbc7a4cc1694a476c3ed2eb22ce047538a))
* Add arm configuration templates and preset loading ([93006c0](https://github.com/sirtimbly/coleo/commit/93006c046d2ff0fd51b9a0dc0fb141d0a4d1c840))
* add bug archiving/filtering feature ([fc4e7f7](https://github.com/sirtimbly/coleo/commit/fc4e7f715be46a2cb91d851ca90546e57efd51bc))
* Add bug tracking system with priority escalation and resolution workflow ([476ee70](https://github.com/sirtimbly/coleo/commit/476ee70dc91d0edb096c0f925c779a79844ebfa8))
* Add comprehensive infrastructure health tracking and monitoring ([4f7cc6e](https://github.com/sirtimbly/coleo/commit/4f7cc6ee11f9e453855c627986be4677d8cc25d7))
* Add documentation sync and email-to-docs workflow ([8bc7d99](https://github.com/sirtimbly/coleo/commit/8bc7d9938757ac8642b06bad5dbae4b9475f2103))
* add embedding generation service with OpenAI and local model support ([8073569](https://github.com/sirtimbly/coleo/commit/8073569b1fd10a0f2458be9edd690491418da042))
* Add exploration-first workflow, discovery summarization, and debug CLI ([81ddee8](https://github.com/sirtimbly/coleo/commit/81ddee80b72b65e3f669b7df597abda562c03080))
* Add file watching system for arms ([7554583](https://github.com/sirtimbly/coleo/commit/75545834636fb7f5a02016e28c5766685f17975f))
* Add JetStream migration plan and prepare for event sourcing ([6176faf](https://github.com/sirtimbly/coleo/commit/6176faf3e2f6f7fe4751441108fd507fbce6c9af))
* add NATS JetStream status events consumer ([a566585](https://github.com/sirtimbly/coleo/commit/a566585908a775d9271d68d4b3a594ae4e2f0e65))
* add Qdrant integration for vector storage ([82b675f](https://github.com/sirtimbly/coleo/commit/82b675f76c312c57b8a053ad3d337a08d9b963dc))
* **api:** add status-reports routes and enhance mail tracking ([3f794fe](https://github.com/sirtimbly/coleo/commit/3f794fe9d72a19a3bba5006f2d71bd1a528b6a1a))
* **api:** notify brain when task is deleted and update confirmation dialog ([00443ea](https://github.com/sirtimbly/coleo/commit/00443ea886c9d31b24736e0ac4a3f361c76036b8))
* **api:** use config defaults for harness, provider, and model when creating/spawning arms ([5bcb963](https://github.com/sirtimbly/coleo/commit/5bcb9637672208e90890c189ca0586a21153dbe9))
* arm viewer shows messages ([9c22926](https://github.com/sirtimbly/coleo/commit/9c22926916fe678c6a874b05012a80008e31dc68))
* **brain:** add automations config with refactor large files deduplication ([5e627a2](https://github.com/sirtimbly/coleo/commit/5e627a2a3ff9df306102e0a8936a02996703d758))
* **brain:** add event-window based arm health monitoring ([96b9024](https://github.com/sirtimbly/coleo/commit/96b9024bdba87f1761ee3f6633e302b4f442a99f))
* **brain:** Add grace period for autonomous arms and document state machine ([3b4b60b](https://github.com/sirtimbly/coleo/commit/3b4b60b4cb259d95210de9ee9d2d2b36482304f2))
* **brain:** Add smart status report forwarding logic ([6c5cced](https://github.com/sirtimbly/coleo/commit/6c5cced2541129bac917a0736f701f074d0ba69f))
* **brain:** auto-create commit task when tasks are completed ([d1f9776](https://github.com/sirtimbly/coleo/commit/d1f9776bcdc1042551b2d8c14685cf29d7ed9b21))
* **brain:** create skeleton modules for brain.ts extraction ([#9](https://github.com/sirtimbly/coleo/issues/9)) ([1b81ddf](https://github.com/sirtimbly/coleo/commit/1b81ddfc6de596ad0f8a07bc2642aa36de453618))
* **brain:** detect and handle silent task completions ([b2a0eff](https://github.com/sirtimbly/coleo/commit/b2a0eff99a3853ac8cce1ceeb5dcdfb079a38580))
* **brain:** detect and handle silent task completions ([b127f61](https://github.com/sirtimbly/coleo/commit/b127f612cd19e305ed468aef0650dbd6496a181e))
* **brain:** detect and handle silent task completions ([#8](https://github.com/sirtimbly/coleo/issues/8)) ([92c540e](https://github.com/sirtimbly/coleo/commit/92c540ed236e435c62db590a5e6234da99930bf8))
* **brain:** implement stopping point detection and automated branch/PR workflow ([3f449c9](https://github.com/sirtimbly/coleo/commit/3f449c93e15750ba8ed21099d38e42e4aa2a6c8f))
* **brain:** integrate claims system to prevent file conflicts ([162c38c](https://github.com/sirtimbly/coleo/commit/162c38c6f16244d805d5923b9f30990562f72a51))
* **brain:** Subscribe to arm events for real-time activity tracking ([a5d277a](https://github.com/sirtimbly/coleo/commit/a5d277a16f2dfefc03b4ddbe60ff9f5e3ad7219f))
* **cli,brain:** arms dashboard enhancements and test improvements ([5574707](https://github.com/sirtimbly/coleo/commit/557470794568e681c4a7d089edde57ff38077285))
* **cli:** add arms dashboard help and focused controls ([40cbe78](https://github.com/sirtimbly/coleo/commit/40cbe78d1af249b498ea1dbfa589148b78e34488))
* **cli:** add arms dashboard TUI ([89a9de9](https://github.com/sirtimbly/coleo/commit/89a9de99eb95558356961c4865227256c3669b25))
* **cli:** add bugs CSV export/import commands and enhance arms dashboard ([fe9e837](https://github.com/sirtimbly/coleo/commit/fe9e8374533a5056106eaac7677efaae04275f3d))
* **cli:** improve arms dashboard sidebar UI layout ([b85c399](https://github.com/sirtimbly/coleo/commit/b85c3991f547291d9931eb048e1ffa7fdd39dc76))
* **db:** Add SQLite state migration - replaces JSON file storage ([f4b6d94](https://github.com/sirtimbly/coleo/commit/f4b6d949511a0322b0273380bf06b6c6ec13ad71))
* default arm templates with names ([6c7c6f4](https://github.com/sirtimbly/coleo/commit/6c7c6f4e63d77c394ebb431975b3b75afc0f1bbc))
* discovery grid ([567059e](https://github.com/sirtimbly/coleo/commit/567059e6dbfac23b7beef38be378c4e9f07f1a35))
* Enhanced messaging interface with real-time alerts, keyboard shortcuts, and bulk operations ([ebd8337](https://github.com/sirtimbly/coleo/commit/ebd83376a530faeef9e0c708d2c5cb52c3aa1341))
* escalation logic when bugs block tasks ([0cf4a9b](https://github.com/sirtimbly/coleo/commit/0cf4a9bdb902f8624702e11f62bf65db2480a4ca))
* extract MCP resources and add task progress visualization ([364b566](https://github.com/sirtimbly/coleo/commit/364b566a50be1667e36b930f874f27d0f9da70ee))
* **garden:** add 3d scene explorer ([b55e9ed](https://github.com/sirtimbly/coleo/commit/b55e9ed866ee4f07713af9cbe1b1c390a21e734f))
* **harness:** add model resolver with automatic fallback ([9307e5f](https://github.com/sirtimbly/coleo/commit/9307e5f870c59f302f794b2f7b94986f305f785c))
* **harness:** enhance arm-agent and OpenCode API integration ([dd35330](https://github.com/sirtimbly/coleo/commit/dd3533075f2cc2402bfb710b8dc4dcfb5b9c061c))
* **harness:** implement smart session recovery for TUI harness ([a42fbb3](https://github.com/sirtimbly/coleo/commit/a42fbb3bd8e4396071e8747025b2b9a088c38e84))
* Implement core JetStream event sourcing infrastructure ([5919ca2](https://github.com/sirtimbly/coleo/commit/5919ca2235b29d7bd9ffeb5e964fffe69b3cb3ad))
* Implement JetStream event publishing in harnesses ([be89d7e](https://github.com/sirtimbly/coleo/commit/be89d7eba59d502d7e22eefd08ebfa9829ceae33))
* implement Qdrant status history search for Phase 2.8 ([7abc54e](https://github.com/sirtimbly/coleo/commit/7abc54e45e97fdd9960856b2b9d618f9600f2a89))
* implement robust fractional indexing for task ordering ([26bf045](https://github.com/sirtimbly/coleo/commit/26bf04571ab81b4fe48e170367137925c9bfe048))
* implement Search API with hybrid query support ([7aa8dff](https://github.com/sirtimbly/coleo/commit/7aa8dffcb751c8a346af2adbfc732606765d8333))
* Implement state reconstruction functions for event sourcing ([62c92a9](https://github.com/sirtimbly/coleo/commit/62c92a9ed8b32b359a0840d76af0f85c383f35dc))
* implement task deletion handler for project plan cleanup ([57b7ae4](https://github.com/sirtimbly/coleo/commit/57b7ae484093acf6d760fee50212e59f336f3190))
* Interactive arm spawn with template selection ([ce959f4](https://github.com/sirtimbly/coleo/commit/ce959f4dfc9ba479de029957e55497331d224133))
* **mcp:** improve arm onboarding workflow and add debug logging ([1eabed6](https://github.com/sirtimbly/coleo/commit/1eabed6c176a3d9a2b14fda7543d599407087751))
* messages reload after sending ([1ab28d0](https://github.com/sirtimbly/coleo/commit/1ab28d03b1c3d881d5ab0a4c437e5d68a09ea202))
* **messaging:** Add reply support and fix messaging issues ([49e8fc1](https://github.com/sirtimbly/coleo/commit/49e8fc1e6137ad1d4b1e2e8751cbfb200b9a4edd))
* **messaging:** Add sent and archive message support ([2b07b34](https://github.com/sirtimbly/coleo/commit/2b07b3410c6bc0185c62f841d7481be2ed6d25df))
* new tasks grid ([907f9ea](https://github.com/sirtimbly/coleo/commit/907f9ea243c5602304c0433c11be7a6d98f81ffb))
* notify on blocking bugs ([a95a1df](https://github.com/sirtimbly/coleo/commit/a95a1dfc14a84d641540f21f833e0e09f614267d))
* **observatory:** Add Mail page and navigation for human-agent email communication ([6dbb07f](https://github.com/sirtimbly/coleo/commit/6dbb07fb2bd6fdbcabf7ce92012bd41026f50b20))
* Reduce API server verbosity ([07272d8](https://github.com/sirtimbly/coleo/commit/07272d856034b1dc68f3a96fe9f27a99e0076794))
* **regression:** add arm-recovery scenario ([34a2eba](https://github.com/sirtimbly/coleo/commit/34a2eba0d4d95f0f8820f2519651f20f6ece81d4))
* **regression:** improve test cleanup and add integration script ([0ea95ec](https://github.com/sirtimbly/coleo/commit/0ea95ec6255c844b4742a7657896238b297ebb93))
* **release:** automate npm publishing ([#29](https://github.com/sirtimbly/coleo/issues/29)) ([9d3e53a](https://github.com/sirtimbly/coleo/commit/9d3e53aff0c0b174c64f169e4b4ec4e3cc1e0b6e))
* screenshots ([c8dc5fd](https://github.com/sirtimbly/coleo/commit/c8dc5fdf27dafdd6bf1e4c9dfd581313608f1a03))
* task progress and blocking ([1763d1a](https://github.com/sirtimbly/coleo/commit/1763d1a86fdd69b93300cae06d6f09041f551dbd))
* **tools:** add custom OpenCode tools for dev server and test control ([9294902](https://github.com/sirtimbly/coleo/commit/9294902a79773fa3020669f6849cbfa13b0dda34))
* unified grid page ([6c479fe](https://github.com/sirtimbly/coleo/commit/6c479fe1b554b177e6e58e55f2008161f9a44e35))
* **web:** adapt mail and viewer for workspace panes ([1e5d868](https://github.com/sirtimbly/coleo/commit/1e5d86882b6876039aee276741d8267379f44032))
* **web:** add golden workspace shell ([6270e15](https://github.com/sirtimbly/coleo/commit/6270e15d6508f401cf9e80c3cf6aa8119726a916))
* **web:** add StatusReportsPage and refactor TasksPage ([cdfe1a3](https://github.com/sirtimbly/coleo/commit/cdfe1a3145046ff4565c51d1fc67efe190afb640))


### Bug Fixes

* activity tracking matches better ([90acf68](https://github.com/sirtimbly/coleo/commit/90acf687edb45357ca9f1794da9fb8a22f8dc423))
* add missing MessageType variants for task_acknowledge and task_validate ([7590a48](https://github.com/sirtimbly/coleo/commit/7590a4849b6c05de31d64d0907914755058e0d5c))
* Allow spawn endpoint to auto-create arm records ([bf6c8e0](https://github.com/sirtimbly/coleo/commit/bf6c8e04d12eb5f8ee9ee5a1495b99e1f7f09b75))
* **api:** update sort_order when reordering tasks ([01a1b08](https://github.com/sirtimbly/coleo/commit/01a1b08fd0636f8de36c38a839ffd4f95e251aae))
* arm status ([c95c1cc](https://github.com/sirtimbly/coleo/commit/c95c1ccb5d40fd183e8261b0e7d1a7f792981445))
* brain arm spawn model templates ([bde3f36](https://github.com/sirtimbly/coleo/commit/bde3f36817922befc2d05bbce5d1cb18c71c2daa))
* Brain status now reports accurate arm count from database ([42c1b5c](https://github.com/sirtimbly/coleo/commit/42c1b5c407f239fb73d54ec8b439759c9366d7f2))
* brain status tracking ([5076ff1](https://github.com/sirtimbly/coleo/commit/5076ff1a78cdd65faee149294eebce02aae5554e))
* **brain:** remove misleading 'unverified' error messages when /api/status times out ([a514a62](https://github.com/sirtimbly/coleo/commit/a514a6297900e3782bb25f6f377cd5a4d38cd866))
* **brain:** Respect state machine when determining arm idle/busy ([696133c](https://github.com/sirtimbly/coleo/commit/696133cf159397d71f67dac2f5887a82bc3ad2f5))
* change default dir add templates ([ff7ec4a](https://github.com/sirtimbly/coleo/commit/ff7ec4a50795ee0e36239a8947b1fb7c3f3d4124))
* **cli:** preserve arm detail buffers when switching views ([95037f7](https://github.com/sirtimbly/coleo/commit/95037f77523a652ed2b3aee0d2d30a7b8ec63ded))
* **db:** remove invalid indexes from FTS search migration ([2fbef17](https://github.com/sirtimbly/coleo/commit/2fbef179d5a65da96ca275e08eabdc09d16439e1))
* dupe db ([e2fce15](https://github.com/sirtimbly/coleo/commit/e2fce150eb65982e4f9338e1abe03969a9f8f9ae))
* email processor llm ([922b2e8](https://github.com/sirtimbly/coleo/commit/922b2e80e420b5a6f738576f39521908a460e547))
* Handle archive subdirectories when listing archived messages ([f259895](https://github.com/sirtimbly/coleo/commit/f259895ecf5f3ddb491f03085860b5c035901906))
* **harness:** enforce fresh isolated opencode sessions per arm ([cd99162](https://github.com/sirtimbly/coleo/commit/cd991628c09137a62eca7dd9a4c376600e265607))
* **harness:** prevent NATS payload exceeded errors in arm logs ([b4b16fa](https://github.com/sirtimbly/coleo/commit/b4b16faf43af27cfe8a4b7544f59e676abf5f938))
* **harness:** prune only stale sessions for the same arm ([b9c98e3](https://github.com/sirtimbly/coleo/commit/b9c98e34e5b81bfa3858db142edcdb82ec89fc16))
* **harness:** select session immediately after creation ([49c1ba8](https://github.com/sirtimbly/coleo/commit/49c1ba88f63d0ffa4eec66b4b850883a58d89ec8))
* Include port in arm API responses ([5975a42](https://github.com/sirtimbly/coleo/commit/5975a42e6a9cdbd2d0bcb8a9293d46847ab22d44))
* **mcp:** add heartbeat tool and fix TypeScript errors ([8b44e50](https://github.com/sirtimbly/coleo/commit/8b44e50641505809f862e536cd34df24c4a58a3d))
* **mcp:** notify brain when bug is resolved/closed ([9f9412a](https://github.com/sirtimbly/coleo/commit/9f9412a988630373945f48307b3bd937b9a1fd3d))
* migration tasks ([a6e7a6f](https://github.com/sirtimbly/coleo/commit/a6e7a6f85592fc85f7f29bea1bc84fdaa218ebd9))
* Prevent CLI commands from hanging ([5653710](https://github.com/sirtimbly/coleo/commit/5653710dee665087920d960c1dd9273c1e6b1146))
* prevent infinite validation task loops and modularize MCP tools ([77ff325](https://github.com/sirtimbly/coleo/commit/77ff32583c608110bbaf99bd4dbff6847788173b))
* Reload messages after archiving ([b2ee53d](https://github.com/sirtimbly/coleo/commit/b2ee53d5b2ca9aa998f4444d7cf283d17a7d6323))
* Resolve JetStream and event stream connection issues ([a3534a2](https://github.com/sirtimbly/coleo/commit/a3534a2f447242651eb948945ce45f64809f6eda))
* Resolve TypeScript compilation error in arms routes ([392404f](https://github.com/sirtimbly/coleo/commit/392404fbba3b956af326e7d2131121f949c720e1))
* Session isolation test and README documentation ([e37f6e3](https://github.com/sirtimbly/coleo/commit/e37f6e330c8eec186037558725ab9d233b8e33ba))
* task creation column mismatch ([62b5c2e](https://github.com/sirtimbly/coleo/commit/62b5c2ea0fc23656fb2b2b7316dd9a6ba4a556ef))
* task tests and initial prompts ([c66b71b](https://github.com/sirtimbly/coleo/commit/c66b71ba07927edb4e0c2fb42344e8fe40c4d24f))
* **tasks:** reorder using neighbor-based order keys ([36e7d3b](https://github.com/sirtimbly/coleo/commit/36e7d3b47ecdd732b6a3c95daa9e92d9ba91e363))
* template files ([f494e6c](https://github.com/sirtimbly/coleo/commit/f494e6cf6ef992b8a5e4cbcabf24375d2421e627))
* templates and init process fixed ([d73e8e3](https://github.com/sirtimbly/coleo/commit/d73e8e31b47033a67c3366ae3769ec0bac4b4f79))
* tests ([c9c3d85](https://github.com/sirtimbly/coleo/commit/c9c3d850f08a8b9111f02b0dffb1f1b64ac497e4))
* **tests:** Use non-dev API key in auth tests ([8e2c061](https://github.com/sirtimbly/coleo/commit/8e2c061d639b4d4ca41f5bc8d897d644cf40586b))
* typecheck warnings and errors ([5acabb5](https://github.com/sirtimbly/coleo/commit/5acabb51256291eb9848c61daaa4c0833d1cfbce))
* **web:** minor TasksPage improvements ([55c5968](https://github.com/sirtimbly/coleo/commit/55c5968afb03fb6323e74cc63427384713feba37))
* **web:** restore task and bug creation modals ([701f92c](https://github.com/sirtimbly/coleo/commit/701f92c9bcc81ae1e6d14ec7d1805edc4e276827))
* **web:** stabilize discussion markdown keys ([3a53cd7](https://github.com/sirtimbly/coleo/commit/3a53cd7c152da6767548ee2ad5e8b26d4277bef1))
* Wire up archive API and show archive count ([6ceccc1](https://github.com/sirtimbly/coleo/commit/6ceccc1048f02b020516673ee6c7af9809224fe4))

## License Change Dates

| Version | Change Date | Change License |
|---------|-------------|----------------|
