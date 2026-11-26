# Investigator eval

2026-11-26 · model `claude-sonnet-5-5` · Flagsmith MCP tools · **15/15 correct**

| Scenario | Run | Result | Claude proposed | Acted on (after guardrails) | Checks | Seconds |
| --- | --- | --- | --- | --- | --- | --- |
| New checkout bug | 1 | pass | turn_off_flag new_checkout | bug new_checkout | 5 | 5.5 |
| New checkout bug | 2 | pass | turn_off_flag new_checkout | bug new_checkout | 6 | 6.3 |
| New checkout bug | 3 | pass | turn_off_flag new_checkout | bug new_checkout | 5 | 5.8 |
| Attack from 3 accounts | 1 | pass | block_sources new_checkout | abuse new_checkout | 4 | 5.1 |
| Attack from 3 accounts | 2 | pass | block_sources new_checkout | abuse new_checkout | 4 | 4.9 |
| Attack from 3 accounts | 3 | pass | block_sources new_checkout | abuse new_checkout | 4 | 5.6 |
| Database outage (no flag at fault) | 1 | pass | escalate_no_flag | no_suspect | 4 | 5.9 |
| Database outage (no flag at fault) | 2 | pass | escalate_no_flag | no_suspect | 5 | 5.7 |
| Database outage (no flag at fault) | 3 | pass | escalate_no_flag | no_suspect | 4 | 4.9 |
| Bug and attack at once | 1 | pass | turn_off_flag new_checkout | bug new_checkout | 6 | 10.9 |
| Bug and attack at once | 2 | pass | turn_off_flag new_checkout | bug new_checkout | 6 | 10.3 |
| Bug and attack at once | 3 | pass | turn_off_flag new_checkout | bug new_checkout | 6 | 10.1 |
| Two flags changed, one broken | 1 | pass | turn_off_flag new_checkout | bug new_checkout | 6 | 7.4 |
| Two flags changed, one broken | 2 | pass | turn_off_flag new_checkout | bug new_checkout | 6 | 6.3 |
| Two flags changed, one broken | 3 | pass | turn_off_flag new_checkout | bug new_checkout | 6 | 7.0 |
