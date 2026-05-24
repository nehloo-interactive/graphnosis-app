# Contributing to Graphnosis App

Thanks for your interest in Graphnosis. Here's how engagement with this
project works.

## Bug reports and feature requests

Open a [GitHub Issue](https://github.com/nehloo-interactive/graphnosis-app/issues).
Good bug reports include the app version, OS, and the smallest sequence of
steps that reproduces the problem.

Feature requests are welcome too — no guarantee of roadmap placement, but
patterns across requests do influence direction.

## Documentation

PRs that fix or improve the docs (`apps/docs/`) are welcome. That includes:
typos, unclear phrasing, missing steps, outdated screenshots, or a guide
you wish existed.

## Code contributions

Graphnosis App is not accepting code pull requests at this stage.

This is a deliberate choice, not an oversight. The project is a
commercial product in active foundational development, with a security
model that requires careful, adversarial review of every change that
touches data paths — encryption, the op-log, the MCP consent gate, and
AI data exposure. Maintaining community contributions responsibly takes
more bandwidth than is available right now, and doing it poorly would be
worse than not doing it at all.

The source is published so you can read, audit, and verify the privacy
promises. That's the intent of source availability at this stage — not
pull requests.

This may change. A CLA process, a stable API surface, and clearly
bounded areas (connectors, integrations) are all things that could open
the door. For now: no, and thank you for understanding.

## Security issues

Please **do not** open a public issue for security vulnerabilities —
especially anything touching encryption, the op-log, or AI data exposure.

Email `security@graphnosis.com` with:
- A description of the issue
- Steps or a minimal reproducer
- Your assessment of severity and disclosure timing

We aim to acknowledge within 48 hours and have a fix in flight within
two weeks for high-severity issues.
