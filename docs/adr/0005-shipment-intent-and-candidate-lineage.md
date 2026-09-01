# Shipment intent and candidate lineage are explicit

Shipment state uses a discriminated SemVer or Continuous intent and an authenticated Candidate Lineage rather than forcing every shipment through a version-shaped record or pretending one SHA survives every transformation. SemVer shipments own release, tag, publication, promotion, and deployment phases; Continuous shipments end when their frozen exact candidates are integrated into the configured base. Each lineage edge has its own authoritative observer and invalidation rule.
