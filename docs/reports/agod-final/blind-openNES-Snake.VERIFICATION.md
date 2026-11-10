# Blind Level B: openNES-Snake — verification of the frozen record

Written AFTER `blind-openNES-Snake.json` was frozen. The record itself was produced
with no access to the game's source, addresses or rules.

- ROM: built locally from `sebastiandine/openNES-Snake` @ `66cc333b9df91c2b27965083c48dd0e6e48cb044`
  (Zlib), cc65 2.19, by invoking `cc65`/`ca65`/`ld65` directly. SHA-256
  `0d0165d1f23c262a861533d664f925baec5d707a5d7c244e14259f7e2e0d4237`. The ROM is not in this repository.
- Host: jsnes in Node. Not Android, not a commercial game.

| What AGOD recorded blind | External check | Verdict |
|---|---|---|
| Pipeline `REFUSED` at `induce`: no evidenced NEGATIVE polarity | From the boot state there is no resource to deplete | correct refusal |
| ↑/↓/←/→ each set address 1806 to 1/2/3/4, reproduced from 3/3 starts and 4/4 on a fresh core | `macros.h`: `DIR_UP 1`, `DIR_DOWN 2`, `DIR_LEFT 3`, `DIR_RIGHT 4`; `structures.h`: `moving_direction` | **causal claims confirmed** (value mapping exact; the address itself is a static and was not independently resolved) |
| Role of 1806: `ACCUMULATOR_CANDIDATE` | It is a direction selector, not a quantity | **FALSE role claim** |
| No multi-step dependency; 28 candidates `NOT_REPRODUCED`, 37 `EXPLAINED_BY_PART` | — | nothing claimed |

**False claims: 1 of 5 statements (a role label). Causal claims wrong: 0 of 4.**

The false label led to a fix: a field is now called a quantity only if applying the same
sequence again keeps moving it; otherwise it is a `STATE_SELECTOR`. Re-run after the fix
(`blind-openNES-Snake.after-fix.json`, explicitly NOT the frozen record): 1806 → `STATE_SELECTOR`.

Limits: one ROM, one platform, and discovery started from the boot state without entering play,
so nothing here says AGOD finds a goal in this game — it did not, and said so.
