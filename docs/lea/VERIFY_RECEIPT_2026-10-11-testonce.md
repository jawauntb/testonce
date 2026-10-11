# SafeVerify receipt, 2026-10-11 (Testonce namespace)

Replay of `formal/Testonce/*.lean` after the rename from `Singularity` to `Testonce`. Method, toolchains and grading rule as in `VERIFY_RECEIPT_2026-10-11.md`: repo pin Lean 4.34.1; scratch build and SafeVerify on Lean 4.29.0; Lea commit 8fc9a74; no scratch proof edits; "verified" only when SafeVerify passed and every axiom is in {propext, Quot.sound}.

Command: `bash docs/lea/replay/replay.sh <work-dir>`

| File | Declaration | Kind | SafeVerify | Axioms | Grade |
|---|---|---|---|---|---|
| Bloom.lean | `Testonce.Bloom.absent_of_query_false` | theorem | passed | propext, Quot.sound | verified |
| Bloom.lean | `Testonce.Bloom.build` | definition | passed | none | verified |
| Bloom.lean | `Testonce.Bloom.build_mono` | theorem | passed | propext | verified |
| Bloom.lean | `Testonce.Bloom.foldl_insert_sets` | theorem | passed | propext | verified |
| Bloom.lean | `Testonce.Bloom.insert` | definition | passed | none | verified |
| Bloom.lean | `Testonce.Bloom.no_false_negative` | theorem | passed | propext, Quot.sound | verified |
| Bloom.lean | `Testonce.Bloom.query` | definition | passed | none | verified |
| Bloom.lean | `Testonce.Bloom.setAll` | definition | passed | none | verified |
| Bloom.lean | `Testonce.Bloom.setAll_mono` | theorem | passed | propext | verified |
| Bloom.lean | `Testonce.Bloom.setAll_sets` | theorem | passed | propext | verified |
| Bloom.lean | `Testonce.Bloom.setBit` | definition | passed | none | verified |
| Bloom.lean | `Testonce.Bloom.setBit_mono` | theorem | passed | propext | verified |
| Bloom.lean | `Testonce.Bloom.setBit_self` | theorem | passed | propext | verified |
| Skip.lean | `Testonce.Skip.Entry` | inductive | passed | none | verified |
| Skip.lean | `Testonce.Skip.Entry._sizeOf_1` | definition | passed | none | verified |
| Skip.lean | `Testonce.Skip.Entry._sizeOf_inst` | definition | passed | none | verified |
| Skip.lean | `Testonce.Skip.Entry.casesOn` | definition | passed | none | verified |
| Skip.lean | `Testonce.Skip.Entry.ctorIdx` | definition | passed | none | verified |
| Skip.lean | `Testonce.Skip.Entry.inputs` | definition | passed | none | verified |
| Skip.lean | `Testonce.Skip.Entry.mk` | constructor | passed | none | verified |
| Skip.lean | `Testonce.Skip.Entry.mk._flat_ctor` | definition | passed | none | verified |
| Skip.lean | `Testonce.Skip.Entry.mk.inj` | theorem | passed | none | verified |
| Skip.lean | `Testonce.Skip.Entry.mk.injEq` | theorem | passed | propext | verified |
| Skip.lean | `Testonce.Skip.Entry.mk.noConfusion` | definition | passed | none | verified |
| Skip.lean | `Testonce.Skip.Entry.mk.sizeOf_spec` | theorem | passed | none | verified |
| Skip.lean | `Testonce.Skip.Entry.noConfusion` | definition | passed | none | verified |
| Skip.lean | `Testonce.Skip.Entry.noConfusionType` | definition | passed | none | verified |
| Skip.lean | `Testonce.Skip.Entry.recOn` | definition | passed | none | verified |
| Skip.lean | `Testonce.Skip.Entry.result` | definition | passed | none | verified |
| Skip.lean | `Testonce.Skip.audit_mismatch` | theorem | passed | propext, Quot.sound | verified |
| Skip.lean | `Testonce.Skip.decide` | definition | passed | none | verified |
| Skip.lean | `Testonce.Skip.decide_empty` | theorem | passed | propext | verified |
| Skip.lean | `Testonce.Skip.decide_spec` | theorem | passed | propext, Quot.sound | verified |
| Skip.lean | `Testonce.Skip.record` | definition | passed | none | verified |
| Skip.lean | `Testonce.Skip.skip_sound` | theorem | passed | propext, Quot.sound | verified |

`formal/Challenge.lean` restates the four headline theorems under the new names; its sha256 is pinned in `.github/workflows/ci.yml`.
