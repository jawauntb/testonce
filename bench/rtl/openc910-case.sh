#!/usr/bin/env bash
# One openc910 smart_run case as one test, run from the openc910 checkout root:
# build the core with Verilator, build the case with the XuanTie toolchain, simulate,
# and pass only if the testbench wrote "TEST PASS" to run_case.report.
# smart_run keeps every case in one ./work directory, so each run copies smart_run into
# its own temp dir (cases can then run side by side). The copy's Makefile gets one edit:
# the unbounded `make -j` that compiles Verilator's C++ is capped at C910_JOBS, so a
# small runner does not run out of memory. smart_run's makefiles use bash redirections (>&), so
# make runs its recipes with SHELL=/bin/bash. Oracle and testonce runs use this same script.
set -u
case=$1
root=$PWD
w=$(mktemp -d "${TMPDIR:-/tmp}/c910-XXXXXX")
trap 'rm -rf "$w"' EXIT
cp -r "$root/smart_run" "$w/"
mkdir -p "$w/smart_run/work"
sed -i "s/make -j -C obj_dir/make -j${C910_JOBS:-4} -C obj_dir/" "$w/smart_run/Makefile"
cd "$w/smart_run"
export CODE_BASE_PATH="$root/C910_RTL_FACTORY"
make SHELL=/bin/bash runcase CASE="$case" SIM="${C910_SIM:-verilator}" THREADS=1 >"$w/run.log" 2>&1
code=$?
if grep -q "TEST PASS" work/run_case.report 2>/dev/null; then exit 0; fi
echo "openc910 case $case: no TEST PASS (make exit $code); last log lines:" >&2
tail -n 25 "$w/run.log" >&2
tail -n 15 work/*.case.log >&2 2>/dev/null
exit 1
