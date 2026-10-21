# Legacy ACP harness (not run)

`capture.mjs`, `mock-openai.mjs` and `pi-launch.mjs` drive pi-acp against pi 0.84.x for the 0.1.0
admission evidence in `evidence/`. They speak the v1 envelope, which 0.2.0 no longer emits, and
are kept only so that evidence can be reproduced against a 0.1.x checkout. Nothing in `npm test`
runs them.
