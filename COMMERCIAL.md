Draft: owner to confirm.

# testonce pricing and terms

The CLI is free for any use (see `LICENSE`). Paid features are free for personal, education,
non-profit and public open-source projects. Inside a for-profit organization they need one seat
per person who uses them; CI runners and bots don't need seats.

| Plan | Price | What it covers |
|---|---|---|
| Team | $5 per user per month, $100 per user per year, or $200 per user once (lifetime) | The shared cache: `testonce share` |
| Flaky Shield | +$20 per user per month | `testonce flaky` |
| Smart Shards | +$20 per user per month | `testonce shard` |
| Fail-Fast Order | +$20 per user per month | `testonce order` |
| Savings Report | +$20 per user per month | `testonce report` |
| Fix Brief | +$20 per user per month | `testonce fix` (bring your own agent) |
| Connectors | $49 per month per organization, flat | `testonce mcp` (local MCP server) and `testonce api` (JSON) for your agents and scripts |
| Everything | $100 per user per month | Team plus all five add-ons |

- Billed by Stripe. Monthly and yearly plans cancel anytime, effective at the end of the period.
- Lifetime covers Team (the shared cache), including future versions, for as long as testonce
  is distributed. It doesn't include add-ons.
- A seat is a license to use the feature. It doesn't promise support or an SLA.
- Buy: https://testonce-production.up.railway.app/#price
- Seat changes, cancellation, questions: jawaun.brown95@gmail.com

## Open questions for the owner and counsel

- Is a custom license enough, or should section 2 build on a standard such as PolyForm Perimeter
  or the Functional Source License?
- What does "lifetime" promise if the product is discontinued? This draft says "for as long as
  testonce is distributed".
- Does a company's own public open-source repository count as open-source use? This draft says yes.
