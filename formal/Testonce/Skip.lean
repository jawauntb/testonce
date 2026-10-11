/-!
# Skipping a test is safe under three stated assumptions

Model of the skip decision in `src/inputs.mjs` (`firstChanged`) and `src/cli.mjs` (`hit`).
A *world* `w : P → C` maps each path to its current content. A test is a function
`run : (P → C) → R` from the world to a result. When the test passed in world `w₀`,
testonce stored, for every recorded path `p`, the fingerprint `fp (w₀ p)`.

The skip decision recomputes each fingerprint and skips when all are equal.

The theorem `skip_sound` says a skipped test would have produced the recorded result,
**given**:

* (A1) `deps`: the test's result depends only on the recorded paths. This is the claim
  that the strace trace is complete. It is an assumption about strace, the kernel and
  the test (no clock, randomness, unread env vars or network): it is not proved here.
* (A2) `inj`: the fingerprint is injective. For SHA-256 this is collision resistance:
  an assumption, not a theorem.
* (A3) the stored entry was recorded from a real passing run in world `w₀`.

`audit_mismatch` is the converse use: if a skip-eligible test is re-run (an audit) and
gives a different result, at least one assumption failed. That is why testonce
quarantines such a test instead of trusting the cache again.
-/

namespace Testonce.Skip

variable {P C D R : Type}

/-- The stored manifest: recorded paths with their fingerprints, plus the result. -/
structure Entry (P D R : Type) where
  inputs : List (P × D)
  result : R

/-- Skip iff every recorded fingerprint matches today's. -/
def decide [DecidableEq D] (fp : C → D) (w : P → C) (e : Entry P D R) : Bool :=
  e.inputs.all (fun pd => fp (w pd.1) = pd.2)

/-- The entry testonce writes after a passing run in world `w₀`. -/
def record (fp : C → D) (paths : List P) (run : (P → C) → R) (w₀ : P → C) : Entry P D R :=
  ⟨paths.map (fun p => (p, fp (w₀ p))), run w₀⟩

theorem decide_spec [DecidableEq D] (fp : C → D) (w : P → C) (e : Entry P D R) :
    decide fp w e = true ↔ ∀ pd ∈ e.inputs, fp (w pd.1) = pd.2 := by
  unfold decide
  simp [List.all_eq_true]

theorem skip_sound [DecidableEq D] (fp : C → D) (paths : List P) (run : (P → C) → R)
    (w₀ w : P → C)
    (deps : ∀ w₁ w₂ : P → C, (∀ p ∈ paths, w₁ p = w₂ p) → run w₁ = run w₂)
    (inj : ∀ a b : C, fp a = fp b → a = b)
    (hskip : decide fp w (record fp paths run w₀) = true) :
    run w = (record fp paths run w₀).result := by
  have hall := (decide_spec fp w _).mp hskip
  apply deps
  intro p hp
  apply inj
  have := hall (p, fp (w₀ p)) (List.mem_map.mpr ⟨p, hp, rfl⟩)
  exact this

/-- An audit that disagrees with the cache refutes the assumptions together. -/
theorem audit_mismatch [DecidableEq D] (fp : C → D) (paths : List P) (run : (P → C) → R)
    (w₀ w : P → C)
    (hskip : decide fp w (record fp paths run w₀) = true)
    (hdiff : run w ≠ run w₀) :
    ¬ ((∀ w₁ w₂ : P → C, (∀ p ∈ paths, w₁ p = w₂ p) → run w₁ = run w₂) ∧
       (∀ a b : C, fp a = fp b → a = b)) := by
  intro ⟨deps, inj⟩
  exact hdiff (skip_sound fp paths run w₀ w deps inj hskip)

/-- With an empty trace, a skip says nothing: any `run` that ignores the world agrees,
    but `deps` is then the strong claim that the test is constant. This is why a run that
    records zero inputs is still only as good as (A1). -/
theorem decide_empty [DecidableEq D] (fp : C → D) (w : P → C) (r : R) :
    decide fp w (⟨[], r⟩ : Entry P D R) = true := by
  simp [decide]

end Testonce.Skip
