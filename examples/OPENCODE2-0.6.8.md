# OpenCode Loop 0.6.8

## exFAT/FAT project volume lock compatibility (#172)

When `fs.link()` cannot claim a Loop session lock because hard links are unsupported (`EISDIR` on the reported Windows exFAT case, or `ENOTSUP`/`EOPNOTSUPP`/`ENOSYS`/`EPERM`/`EACCES`), Loop attempts an atomic `wx` exclusive-file claim instead.

The fallback also applies to dead-owner cleanup elections. A different live owner always wins; malformed lock owner metadata remains fail-closed, and unexpected I/O errors are not ignored. Short empty-owner publication windows get bounded retries instead of false corruption reports.

Tests exercise synthetic exFAT-style errors in independent Node processes, concurrent updates, abandoned locks and broken metadata. Windows/Linux, real OpenCode 2 and production artifact validation remain release gates. **Physical Windows exFAT and Desktop GUI behavior require separate field verification.**

## Independent installation

```powershell
npx -y @bybrawe/opencode-loop@0.6.8
npx -y @bybrawe/opencode-goal@1.3.49
```

Fully exit and restart OpenCode. From the affected exFAT project, verify `/loop-status`, `/loop-doctor`, a short `/loop` job, and `/goal status`. Dedicated Goal remains a separately installed plugin; `/loop-goal*` compatibility commands are opt-in.
