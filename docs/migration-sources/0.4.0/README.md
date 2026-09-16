# Original 0.4.0 migration sources

These files preserve the reviewed SQL from PR #1. They are an archive, not an executable migration directory. Do not apply them again.

Lovable applied the changes through its migration service and assigned the following versions in the production migration ledger. The executable copies remain unchanged in `supabase/migrations/` under those deployed versions:

| Reviewed source version | Deployed version |
| --- | --- |
| 20260915120000 | 20260915192121 |
| 20260915130000 | 20260915192154 |
| 20260915140000 | 20260915192213 |
| 20260915150000 | 20260915192237 |
| 20260915160000 | 20260915192302 |

The first deployed file adds a transaction-scoped table lock and a check that `profile_locks` is empty before applying its source SQL. The remaining four files match their reviewed sources exactly. Keeping both sets in the executable directory would repeat the same schema changes and fail on an existing column.

This reconciliation changes neither the deployed SQL nor production data or ledger records. Fresh database setup and subsequent deployments use only the files in `supabase/migrations/`.
