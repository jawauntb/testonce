/-!
# Branches that change disjoint paths merge without a conflict

Model of the guarantee behind `testonce lane` (`src/addons/lane.mjs`). A *tree* `P → C` maps each
path to its content. A *branch* is the base tree plus new content on a finite list of changed
paths. Git's three-way merge decides each path on its own:

* only one side changed the path: take that side,
* both sides changed it to the same content: take it,
* both sides changed it to different content: conflict.

`merge_conflict_free`: if the two branches' changed-path lists are disjoint, no path conflicts.
`merge_keeps_both`: then the merged tree is ours on our changed paths, theirs on theirs, and the
base everywhere else.

What this is and is not. It is the per-path rule, over opaque paths. It does not model git's
rename detection, directory renames, or file/directory clashes (`lane` treats a path and everything
below it as one lease to cover those), and it says nothing about *semantic* conflicts: two changes
that merge cleanly and are still broken together. Nothing here proves the lease protocol itself
(that claims race safely, or that every agent claims first); it proves what disjointness buys.
-/

namespace Testonce.Merge

variable {P C : Type}

/-- A branch: the paths it changed and the content it gave them. Everything else is the base. -/
structure Branch (P C : Type) where
  changed : List P
  edit : P → C

/-- The tree a branch holds, given the base it started from. -/
def Branch.tree [DecidableEq P] (base : P → C) (b : Branch P C) : P → C :=
  fun p => if p ∈ b.changed then b.edit p else base p

/-- Three-way merge of one path's content; `none` is a conflict. -/
def merge3 [DecidableEq C] (base ours theirs : C) : Option C :=
  if ours = base then some theirs
  else if theirs = base then some ours
  else if ours = theirs then some ours
  else none

/-- The merge outcome at one path. -/
def mergePath [DecidableEq C] (base ours theirs : P → C) (p : P) : Option C :=
  merge3 (base p) (ours p) (theirs p)

/-- The merged tree, reading a conflict as the base (only used where there is none). -/
def mergeTree [DecidableEq C] (base ours theirs : P → C) : P → C :=
  fun p => (mergePath base ours theirs p).getD (base p)

/-- Sanity: the model does have conflicts. Both sides changing a path differently is one. -/
example : merge3 (0 : Nat) 1 2 = none := by decide

theorem merge3_ne_none [DecidableEq C] (b o t : C) (h : o = b ∨ t = b) :
    merge3 b o t ≠ none := by
  unfold merge3
  by_cases h1 : o = b
  · simp [h1]
  · have h2 : t = b := h.resolve_left h1
    simp [h1, h2]

theorem merge_conflict_free [DecidableEq P] [DecidableEq C] (base : P → C)
    (a b : Branch P C) (disj : ∀ p, p ∈ a.changed → p ∉ b.changed) (p : P) :
    mergePath base (a.tree base) (b.tree base) p ≠ none := by
  unfold mergePath
  apply merge3_ne_none
  by_cases ha : p ∈ a.changed
  · right
    have hb := disj p ha
    simp [Branch.tree, hb]
  · left
    simp [Branch.tree, ha]

theorem merge_keeps_both [DecidableEq P] [DecidableEq C] (base : P → C)
    (a b : Branch P C) (disj : ∀ p, p ∈ a.changed → p ∉ b.changed) :
    (∀ p ∈ a.changed, mergeTree base (a.tree base) (b.tree base) p = a.edit p) ∧
    (∀ p ∈ b.changed, mergeTree base (a.tree base) (b.tree base) p = b.edit p) ∧
    (∀ p, p ∉ a.changed → p ∉ b.changed → mergeTree base (a.tree base) (b.tree base) p = base p) := by
  refine ⟨?_, ?_, ?_⟩
  · intro p ha
    have hb := disj p ha
    by_cases h : a.edit p = base p
    · simp [mergeTree, mergePath, merge3, Branch.tree, ha, hb, h]
    · simp [mergeTree, mergePath, merge3, Branch.tree, ha, hb, h]
  · intro p hb
    have ha : p ∉ a.changed := fun h => disj p h hb
    simp [mergeTree, mergePath, merge3, Branch.tree, ha, hb]
  · intro p ha hb
    simp [mergeTree, mergePath, merge3, Branch.tree, ha, hb]

end Testonce.Merge
