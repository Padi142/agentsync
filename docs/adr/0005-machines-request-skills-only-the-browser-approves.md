# Machines request Skills; only the browser approves

Agents are where people ask for Skills ("add these skills from t3dotgg/tstack"), but ADR 0002 lets only a signed-in browser change Skills. To keep that boundary, `agentsync skills add <owner/repo> [names…]` uses the Machine token only to create a Skill Request: the server resolves the Pin and audits at creation, and a signed-in user approves it on the dashboard, choosing which Skills to add and their Machines. The approval page names the Machine that asked, and Skills audited High or Critical, or not audited, start unticked. The waiting CLI then installs just the approved Skills on its Machine; that approval is the explicit ask ADR 0002 requires before code is downloaded. A stolen token can therefore only ask, and at most 5 open requests per account limit how much it can ask.

## Considered Options

- **Print a pre-filled dashboard link only**: rejected because the agent cannot tell when the user has added the Skills, so the user has to come back and say so; a server-side request lets the CLI wait and finish the install itself.
- **Let the Machine token add Skills scoped to its own Machine**: rejected because it breaks ADR 0002's rule that only the browser changes Skills, a single-Machine Skill is rarely what the user wants, and a prompt-injected agent could quietly add a lasting Skill with no one reviewing it.
