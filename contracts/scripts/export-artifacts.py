#!/usr/bin/env python3
"""Copy ABI + creation bytecode of the browser-deployable contracts into web/src/contracts/artifacts.json.
Run after `forge build`."""
import json, pathlib
root = pathlib.Path(__file__).resolve().parents[1]
names = {"InvestorRegistry": "compliance", "PermissionedToken": "tokens", "PrimarySale": "sale", "TestUSD": "test-helpers", "AssetOracle": "oracle", "Distributor": "distribution", "PermissionedVault": "vaults"}
out = {}
for n in names:
    a = json.loads((root / "out" / f"{n}.sol" / f"{n}.json").read_text())
    out[n] = {"abi": a["abi"], "bytecode": a["bytecode"]["object"]}
dest = root.parent / "web" / "src" / "contracts" / "artifacts.json"
dest.write_text(json.dumps(out, separators=(",", ":")))
print(f"wrote {dest} ({dest.stat().st_size // 1024} KB)")
