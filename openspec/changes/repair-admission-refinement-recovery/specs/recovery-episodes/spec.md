## ADDED Requirements

### Requirement: Recovery admission SHALL use applicable per-strategy bounds

Every scheduler and controller gate that decides whether a blocked item is recoverable SHALL use the same Recovery Episode authority as strategy selection: configured recipe order, diagnostic-specific applicability, attempts spent per strategy, Cooling eligibility, and candidate/evidence episode identity. A depleted legacy class-level budget SHALL remain a compatibility projection and SHALL NOT make the item ineligible while a later applicable strategy has unspent bound in the same episode.

Recovery admission SHALL reject exhausted strategies and SHALL NOT make an inapplicable strategy executable. When no applicable strategy has remaining bound, the episode SHALL remain finitely owned through the existing Cooling or wait contract. A Cooling or waiting item SHALL NOT suppress a proven-independent eligible sibling.

#### Scenario: Zero class projection does not suppress an unspent strategy

- **WHEN** a same-episode blocked item has a zero legacy class-budget projection
- **AND** earlier strategies are spent or inapplicable
- **AND** a later diagnostic-applicable strategy has remaining per-strategy bound
- **THEN** every outer recovery-eligibility gate SHALL admit the item
- **AND** strategy selection SHALL be able to claim that later strategy without resetting the episode or refunding prior attempts

#### Scenario: Exhausted or inapplicable strategies remain unavailable

- **WHEN** a strategy has spent its per-strategy bound or its diagnostic preconditions are false
- **THEN** recovery admission SHALL NOT make that strategy claimable
- **AND** an inapplicable skip SHALL NOT consume another strategy's bound

#### Scenario: No applicable unspent strategy remains bounded

- **WHEN** every diagnostic-applicable strategy in the current episode has spent its bound
- **THEN** the item SHALL enter or remain in owned Cooling or the applicable existing wait state
- **AND** it SHALL NOT tight-loop, fabricate human authority, or create an ownerless terminal

#### Scenario: Independent sibling remains eligible

- **WHEN** item P is Cooling or waiting with no currently claimable strategy
- **AND** item Q is proven independent and otherwise eligible to advance or recover
- **THEN** the scheduler SHALL keep Q eligible
- **AND** SHALL NOT whole-stop the run solely because of P
