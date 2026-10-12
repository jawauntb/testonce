import Testonce

/-!
Frozen statements. Each headline theorem is restated here verbatim and closed only by the
solution theorem of the same name. If a solution's statement is weakened, this file stops
compiling. Its sha256 is pinned in `.github/workflows/ci.yml`; never edit it to get green.
-/
open Testonce

theorem challenge_no_false_negative {α : Type} (h : α → List Nat) (m : Nat) (xs : List α) (x : α)
    (hx : x ∈ xs) : Bloom.query h m (Bloom.build h m xs) x = true :=
  Bloom.no_false_negative h m xs x hx

theorem challenge_absent_of_query_false {α : Type} (h : α → List Nat) (m : Nat) (xs : List α) (x : α)
    (hq : Bloom.query h m (Bloom.build h m xs) x = false) : x ∉ xs :=
  Bloom.absent_of_query_false h m xs x hq

theorem challenge_skip_sound {P C D R : Type} [DecidableEq D] (fp : C → D) (paths : List P)
    (run : (P → C) → R) (w₀ w : P → C)
    (deps : ∀ w₁ w₂ : P → C, (∀ p ∈ paths, w₁ p = w₂ p) → run w₁ = run w₂)
    (inj : ∀ a b : C, fp a = fp b → a = b)
    (hskip : Skip.decide fp w (Skip.record fp paths run w₀) = true) :
    run w = (Skip.record fp paths run w₀).result :=
  Skip.skip_sound fp paths run w₀ w deps inj hskip

theorem challenge_audit_mismatch {P C D R : Type} [DecidableEq D] (fp : C → D) (paths : List P)
    (run : (P → C) → R) (w₀ w : P → C)
    (hskip : Skip.decide fp w (Skip.record fp paths run w₀) = true)
    (hdiff : run w ≠ run w₀) :
    ¬ ((∀ w₁ w₂ : P → C, (∀ p ∈ paths, w₁ p = w₂ p) → run w₁ = run w₂) ∧
       (∀ a b : C, fp a = fp b → a = b)) :=
  Skip.audit_mismatch fp paths run w₀ w hskip hdiff

theorem challenge_merge_conflict_free {P C : Type} [DecidableEq P] [DecidableEq C] (base : P → C)
    (a b : Merge.Branch P C) (disj : ∀ p, p ∈ a.changed → p ∉ b.changed) (p : P) :
    Merge.mergePath base (a.tree base) (b.tree base) p ≠ none :=
  Merge.merge_conflict_free base a b disj p

theorem challenge_merge_keeps_both {P C : Type} [DecidableEq P] [DecidableEq C] (base : P → C)
    (a b : Merge.Branch P C) (disj : ∀ p, p ∈ a.changed → p ∉ b.changed) :
    (∀ p ∈ a.changed, Merge.mergeTree base (a.tree base) (b.tree base) p = a.edit p) ∧
    (∀ p ∈ b.changed, Merge.mergeTree base (a.tree base) (b.tree base) p = b.edit p) ∧
    (∀ p, p ∉ a.changed → p ∉ b.changed → Merge.mergeTree base (a.tree base) (b.tree base) p = base p) :=
  Merge.merge_keeps_both base a b disj

-- Definitions the statements use, pinned by `rfl`.
example (b : Nat → Bool) (i : Nat) : Bloom.setBit b i = fun j => if j = i then true else b j := rfl
example {α : Type} (h : α → List Nat) (m : Nat) (b : Nat → Bool) (x : α) :
    Bloom.query h m b x = (h x).all (fun i => b (i % m)) := rfl
example {α : Type} (h : α → List Nat) (m : Nat) (xs : List α) :
    Bloom.build h m xs = xs.foldl (Bloom.insert h m) (fun _ => false) := rfl
example {P C : Type} [DecidableEq P] (base : P → C) (b : Merge.Branch P C) :
    b.tree base = fun p => if p ∈ b.changed then b.edit p else base p := rfl
example {C : Type} [DecidableEq C] (base ours theirs : C) :
    Merge.merge3 base ours theirs =
      (if ours = base then some theirs else if theirs = base then some ours
       else if ours = theirs then some ours else none) := rfl
example {P C : Type} [DecidableEq C] (base ours theirs : P → C) (p : P) :
    Merge.mergePath base ours theirs p = Merge.merge3 (base p) (ours p) (theirs p) := rfl
example {P C : Type} [DecidableEq C] (base ours theirs : P → C) :
    Merge.mergeTree base ours theirs = fun p => (Merge.mergePath base ours theirs p).getD (base p) := rfl
