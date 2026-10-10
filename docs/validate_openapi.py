"""Validate docs/openapi.yaml: parse, $refs, operationIds, and route parity.

Run from webapp/:

    python docs/validate_openapi.py

Exits non-zero when the spec and server/src/routes disagree, so it can be
wired into CI.
"""
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).parent.parent
spec = yaml.safe_load((ROOT / "docs" / "openapi.yaml").read_text(encoding="utf-8"))

errors = []

# --- paths / operations -----------------------------------------------------
METHODS = {"get", "post", "put", "patch", "delete"}
spec_ops = set()
op_ids = []
for path, item in spec.get("paths", {}).items():
    for method, op in item.items():
        if method in METHODS:
            spec_ops.add((method.upper(), path))
            op_ids.append(op.get("operationId"))

dupes = {i for i in op_ids if op_ids.count(i) > 1 and i}
if dupes:
    errors.append(f"duplicate operationIds: {sorted(dupes)}")
if any(i is None for i in op_ids):
    errors.append("an operation is missing operationId")

# --- unresolved $refs -------------------------------------------------------
def walk(node):
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str):
            cur = spec
            for key in ref.lstrip("#/").split("/"):
                if not isinstance(cur, dict) or key not in cur:
                    errors.append(f"unresolved $ref: {ref}")
                    break
                cur = cur[key]
        for value in node.values():
            walk(value)
    elif isinstance(node, list):
        for value in node:
            walk(value)

walk(spec)

# --- tags -------------------------------------------------------------------
declared = {t["name"] for t in spec.get("tags", [])}
used = set()


def collect_tags(node):
    if isinstance(node, dict):
        if isinstance(node.get("tags"), list):
            used.update(node["tags"])
        for value in node.values():
            collect_tags(value)
    elif isinstance(node, list):
        for value in node:
            collect_tags(value)

collect_tags(spec.get("paths", {}))
if used - declared:
    errors.append(f"undeclared tags: {sorted(used - declared)}")

# --- source routes ----------------------------------------------------------
mounts = {}
app_src = (ROOT / "server" / "src" / "app.ts").read_text(encoding="utf-8")
for mount, factory in re.findall(r'app\.use\("([^"]+)",\s*create(\w+)Routes', app_src):
    mounts[factory] = mount

source_ops = set()
routes_dir = ROOT / "server" / "src" / "routes"
for route_file in routes_dir.glob("*.ts"):
    text = route_file.read_text(encoding="utf-8")
    # A file can export several routers (data.ts has three), so slice the
    # source on each factory declaration and attribute routes to the router
    # they are actually declared in.
    starts = list(re.finditer(r"export function create(\w+)Routes", text))
    for index, match in enumerate(starts):
        segment = text[match.end(): starts[index + 1].start() if index + 1 < len(starts) else len(text)]
        # The callback helper path is a module constant, not a literal.
        segment = segment.replace("router.get(CALLBACK_SCRIPT", 'router.get("/auth-callback.js"')
        prefix = mounts.get(match.group(1), "")
        for method, path in re.findall(
            r'router\.(get|post|put|patch|delete)\(\s*"([^"]*)"', segment
        ):
            full = (prefix + path).rstrip("/") or "/"
            # Express 5 params (:id) vs OpenAPI ({id})
            full = re.sub(r":(\w+)", r"{\1}", full)
            source_ops.add((method.upper(), full))

# healthz lives in app.ts itself
if re.search(r'app\.get\("/healthz"', app_src):
    source_ops.add(("GET", "/healthz"))

only_spec = sorted(spec_ops - source_ops)
only_source = sorted(source_ops - spec_ops)
if only_spec:
    errors.append(f"in spec but not in source: {only_spec}")
if only_source:
    errors.append(f"in source but not in spec: {only_source}")

print(f"spec operations : {len(spec_ops)}")
print(f"source routes   : {len(source_ops)}")
print(f"unique opIds    : {len(set(op_ids))}")

if errors:
    print("\nFAILED:")
    for error in errors:
        print(f"  - {error}")
    sys.exit(1)

print("\nopenapi.yaml OK: parses, all $refs resolve, operationIds unique, routes match source")
