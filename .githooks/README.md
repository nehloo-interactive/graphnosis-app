# Git hooks (committed)

Enable once per clone (or add to onboarding):

```bash
git config core.hooksPath .githooks
```

The pre-commit hook blocks staged smoketest source/dist paths and warns on known personal fixture strings under `apps/` and `packages/`.
