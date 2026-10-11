/-!
# Bloom filter: no false negatives

Model of `src/bloom.mjs`. A filter is a bit vector, modelled as its characteristic
function `Nat → Bool`; `m` is the number of bits and `h x` the list of raw hash values
for key `x` (in the code, `h1 + i*h2` for `i < k`). Every index is taken `% m`.

What this proves: for *any* hash family and any `m`, a key that was inserted is
always reported present. It says nothing about the false-positive rate.

Bridge to the code (not proved here): the JavaScript computes the same indices with
unsigned BigInt arithmetic, so every index is a natural number below `m`, and
`bits[i >> 3] >> (i & 7) & 1` reads bit `i`. `test/bloom.test.mjs` checks that
range and the no-false-negative property on random key sets.
-/

namespace Testonce.Bloom

def setBit (b : Nat → Bool) (i : Nat) : Nat → Bool :=
  fun j => if j = i then true else b j

/-- Set every index of one key. -/
def setAll (m : Nat) (b : Nat → Bool) (is : List Nat) : Nat → Bool :=
  is.foldl (fun acc i => setBit acc (i % m)) b

def insert {α : Type} (h : α → List Nat) (m : Nat) (b : Nat → Bool) (x : α) : Nat → Bool :=
  setAll m b (h x)

def build {α : Type} (h : α → List Nat) (m : Nat) (xs : List α) : Nat → Bool :=
  xs.foldl (insert h m) (fun _ => false)

def query {α : Type} (h : α → List Nat) (m : Nat) (b : Nat → Bool) (x : α) : Bool :=
  (h x).all (fun i => b (i % m))

theorem setBit_mono (b : Nat → Bool) (i j : Nat) (hb : b j = true) : setBit b i j = true := by
  unfold setBit
  split <;> simp_all

theorem setBit_self (b : Nat → Bool) (i : Nat) : setBit b i i = true := by
  simp [setBit]

/-- Setting bits never clears one. -/
theorem setAll_mono (m : Nat) (is : List Nat) :
    ∀ (b : Nat → Bool) (j : Nat), b j = true → setAll m b is j = true := by
  induction is with
  | nil => intro b j hb; simpa [setAll] using hb
  | cons i rest ih =>
    intro b j hb
    exact ih _ j (setBit_mono b (i % m) j hb)

/-- Every index of the key is set afterwards. -/
theorem setAll_sets (m : Nat) (is : List Nat) :
    ∀ (b : Nat → Bool) (i : Nat), i ∈ is → setAll m b is (i % m) = true := by
  induction is with
  | nil => intro b i hi; cases hi
  | cons a rest ih =>
    intro b i hi
    rcases List.mem_cons.mp hi with h | h
    · rw [h]; exact setAll_mono m rest _ _ (setBit_self b (a % m))
    · exact ih _ i h

theorem build_mono {α : Type} (h : α → List Nat) (m : Nat) (xs : List α) :
    ∀ (b : Nat → Bool) (j : Nat), b j = true → xs.foldl (insert h m) b j = true := by
  induction xs with
  | nil => intro b j hb; simpa using hb
  | cons y rest ih =>
    intro b j hb
    exact ih _ j (setAll_mono m (h y) b j hb)

theorem foldl_insert_sets {α : Type} (h : α → List Nat) (m : Nat) (xs : List α) :
    ∀ (b : Nat → Bool) (x : α), x ∈ xs → ∀ i ∈ h x, xs.foldl (insert h m) b (i % m) = true := by
  induction xs with
  | nil => intro b x hx; cases hx
  | cons y rest ih =>
    intro b x hx i hi
    rcases List.mem_cons.mp hx with hy | hr
    · rw [hy] at hi; exact build_mono h m rest _ _ (setAll_sets m (h y) b i hi)
    · exact ih _ x hr i hi

/-- **No false negatives.** Any key that was inserted is reported present. -/
theorem no_false_negative {α : Type} (h : α → List Nat) (m : Nat) (xs : List α) (x : α)
    (hx : x ∈ xs) : query h m (build h m xs) x = true := by
  unfold query build
  rw [List.all_eq_true]
  intro i hi
  exact foldl_insert_sets h m xs _ x hx i hi

/-- Contrapositive, the form `testonce affected` relies on: a `false` answer is certain. -/
theorem absent_of_query_false {α : Type} (h : α → List Nat) (m : Nat) (xs : List α) (x : α)
    (hq : query h m (build h m xs) x = false) : x ∉ xs := by
  intro hx
  rw [no_false_negative h m xs x hx] at hq
  cases hq

end Testonce.Bloom
