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

-- Definitions the statements use, pinned by `rfl`.
example (b : Nat → Bool) (i : Nat) : Bloom.setBit b i = fun j => if j = i then true else b j := rfl
example {α : Type} (h : α → List Nat) (m : Nat) (b : Nat → Bool) (x : α) :
    Bloom.query h m b x = (h x).all (fun i => b (i % m)) := rfl
example {α : Type} (h : α → List Nat) (m : Nat) (xs : List α) :
    Bloom.build h m xs = xs.foldl (Bloom.insert h m) (fun _ => false) := rfl
