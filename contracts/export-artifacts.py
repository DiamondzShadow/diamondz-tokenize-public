#!/usr/bin/env python3
"""Write web/src/contracts/artifacts.json (abi + creation bytecode) from forge's out/. Run `forge build` first."""
import json, pathlib
root = pathlib.Path(__file__).resolve().parent
NAMES = {  # contract -> source file
    "InvestorRegistry": "InvestorRegistry.sol", "PermissionedToken": "PermissionedToken.sol", "PrimarySale": "PrimarySale.sol",
    "TestUSD": "TestUSD.sol", "AssetOracle": "AssetOracle.sol", "Distributor": "Distributor.sol",
    "PermissionedVault": "PermissionedVault.sol", "PermissionedMultiToken": "PermissionedMultiToken.sol",
    "PrimarySale1155": "PrimarySale1155.sol", "PermissionedNFT": "PermissionedNFT.sol", "PrimarySale721": "PrimarySale721.sol",
    "PrimarySale3643": "PrimarySale3643.sol", "OfferingRules": "OfferingRules.sol", "AssetRegistry": "AssetRegistry.sol", "LicenseRegistry": "LicenseRegistry.sol",
}
# Audited ERC-3643 suite (T-REX 4.1.6 / OnchainID 2.2.1, GPL-3.0). Server-side ONLY (api/), never the web bundle:
# the platform relayer deploys these, browsers never need their bytecode.
TREX = ["Token", "IdentityRegistry", "IdentityRegistryStorage", "ClaimTopicsRegistry", "TrustedIssuersRegistry",
        "ModularCompliance", "TREXFactory", "TREXImplementationAuthority", "IAFactory", "Identity", "ClaimIssuer",
        "IdFactory", "ImplementationAuthority", "OfferingRulesModule"]
out = {}
for name, src in NAMES.items():
    a = json.loads((root / "out" / src / f"{name}.json").read_text())
    out[name] = {"abi": a["abi"], "bytecode": a["bytecode"]["object"]}
dst = root.parent / "web/src/contracts/artifacts.json"
dst.write_text(json.dumps(out) + "\n")
print(f"wrote {dst} ({len(out)} contracts)")

trex = {}
for name in TREX:
    a = json.loads((root / "out" / f"{name}.sol" / f"{name}.json").read_text())
    assert a["metadata"]["compiler"]["version"].startswith("0.8.17"), f"{name} must be the audited 0.8.17 build"
    trex[name] = {"abi": a["abi"], "bytecode": a["bytecode"]["object"]}
tdst = root.parent / "api/src/contracts/trex-artifacts.json"
tdst.parent.mkdir(parents=True, exist_ok=True)
tdst.write_text(json.dumps(trex) + "\n")
print(f"wrote {tdst} ({len(trex)} audited T-REX/OnchainID contracts, GPL-3.0, server-side only)")
