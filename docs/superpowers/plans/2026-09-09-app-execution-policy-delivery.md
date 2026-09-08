# App execution-policy delivery repair

> Execute with test-driven-development and verification-before-completion. This is the Meridian-owned portion of the owner's authorized automatic resolver repair, not a native permission setter.

**Goal:** Stop dropping registered execution-policy intent between Hub routing and the native App controller's durable request.

**Architecture:** Carry a strict, optional `executionPolicy` object containing the existing optional `autoApprove` and `sandboxMode` fields through router -> executor argv -> durable queue. Absence remains absence for old requests; false is not coerced into true. The object records requested policy, never claims effective permissions or grants them. Native create/send cannot apply it today; the controller must disclose that limitation and verify actual turn evidence. No executor fallback, Codex state edit, validator weakening, or active-owner release.

**Scope:** Two unrelated worker identities use the same typed path. Independent read-only validation retains its existing CLI routing. Preserve legacy requests, exact request identity, and cancellation ownership. Do not restart while any real worker/validator/PM owns execution.

## Plan

Implementation and verification completed locally: all three original field-loss tests failed before the repair, then passed. Added a failing legacy-upgrade retry test before preserving immutable old requests, and a failing invalid-argument test before tightening the argv boundary. Final full Hub suite: 926 passed, zero failed/skipped; TypeScript compilation and diff whitespace checks pass. Independent review found no blocking defects; its strict invalid-value recommendation is implemented and tested. Shipping/deployment are tracked in the resolver recovery record, not inferred from these tests. Native automatic permission application remains unsupported.

- [ ] Write failing queue tests: `executionPolicy: {autoApprove:false,sandboxMode:"workspace-write"}` survives durable read; changed policy with the same request ID throws content conflict; unsupported policy keys are rejected. Also test an unrelated identity with autoApprove true.
- [ ] Write failing router assertions for both `auto_approve:false` and true, decoding `JSON.parse(args[args.indexOf("--execution-policy")+1])`; keep the existing read-only route assertion.
- [ ] Extend the real source-mode child-process test to pass policy through `buildCodexAppArgs` and assert the child-created queue record contains it.
- [ ] Run those three test files and record the expected field-loss failures before implementation.
- [ ] Export strict `AppExecutionPolicySchema = z.object({autoApprove:z.boolean().optional(),sandboxMode:z.enum(["read-only","workspace-write"]).optional()}).strict()` from queue; add optional policy to Input, allowing existing idempotency comparison to bind it.
- [ ] Add optional typed policy to AppExecutorOptions; validate and JSON-encode the `--execution-policy` argument; parse it in the child process and pass to queue.create.
- [ ] Pass existing instance auto_approve/sandbox_mode from router without inventing defaults. Update the controller document with requested-vs-effective semantics and the unsupported native setter boundary.
- [ ] Run focused tests, full Hub tests, TypeScript build and git diff --check. Review exact diff, commit and push the existing matching topic branch without merge/tag/force push.
- [ ] Record shipped SHA and deployment state. This patch does not close the automatic native permission-provisioning requirement; that remains blocked on a supported native API. Preserve ongoing canonical validation and do not label metadata delivery as effective-policy enforcement.
