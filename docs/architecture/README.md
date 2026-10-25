# Hosted MVP architecture

This is the approved design baseline dated 30 September 2026. Acceptance selects a design; it does not prove implementation, LinkedIn capabilities or free-tier capacity.

| Question | Source of truth |
| --- | --- |
| Where does it run; who owns each module? | [Overview](overview.md) |
| What is stored; how does a person progress? | [Data and lifecycle](data-lifecycle.md) |
| What can clients request; how is a send recovered? | [API and execution contracts](api-execution.md) |
| What must be measured; how is the pilot operated? | [NFR and operations](nfr-operations.md) |
| Proposed local database implementation | [Development database design](development-database.md) |
| Proposed product login and admission | [Product authentication](product-authentication.md) |
| Proposed export, deletion, backup, quota and operations gates | [Pilot operations](pilot-operations.md) |
| Why these choices? | [Accepted ADRs](../decisions/README.md) |

The [product brief](../product/brief.md) owns product scope; [feasibility](../product/feasibility.md) owns research labels and capability gaps. Provisional engineering defaults below are concrete starting settings to test, not claims of LinkedIn safety. Changing a material product boundary needs a recorded decision.
