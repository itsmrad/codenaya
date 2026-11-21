# Moving env-var secrets to a new KMS key

Project secret env vars are sealed with a fresh data key (DEK) per value. The value is encrypted with that DEK, and the DEK is wrapped by an AWS KMS key. The KMS call binds the encryption context `{projectId, envKey, purpose: codenaya-project-env-v1}`. Moving to a new key (another key, region or AWS account) re-wraps the DEKs only. Values are never decrypted, and their ciphertext stays byte-identical.

This runbook is for the operator who owns the AWS account and the host configuration. Placeholders: `OLD_KEY_ARN` and `NEW_KEY_ARN` are full key ARNs (never aliases), `APP_PRINCIPAL` is the IAM principal whose access keys the Next.js host uses, and `BREAK_GLASS_ROLE` is the role allowed to disable keys.

## What the runner does and does not do

- It runs on the Next.js host as the Inngest function `rewrap-env-keys`. There is no HTTP route. Send the event `env-vars/kms.rewrap` (no data) from the Inngest dashboard. Only one run happens at a time.
- **Pass 1, rewrap.** Every secret row not yet on `ENV_VARS_KMS_KEY_ARN` is moved to it: legacy local-KEK rows, and rows on a previous ARN. The runner calls KMS Decrypt with the row's own context and Encrypt under the current key with the same context. It then writes the new wrap only if the row is exactly as it was read. A save or delete that lands first wins, and the row shows as `skipped`.
- **Pass 2, verify.** It checks wraps only: it unwraps every row's DEK under the current key and discards it. Values are not opened, so verify does not authenticate the value ciphertext. The move never touches that ciphertext; it stays byte-identical.
- It never changes a value, `updatedAt`, `recoveryEpoch` or `envGeneration`. Running previews keep running. Rows from an older recovery epoch that are still waiting for the owner's Restore/Delete review are moved too, so retiring a key never strands them.
- It is safe to re-run at any time. Rows already on the current key count as `alreadyCurrent` and cost no KMS call.
- It refuses to start until `ENV_VARS_SECRET_RUNTIME=on`, which is the activation stage that moves secret reads to the KMS sealer. Before that, previews read secrets through the legacy sealer, which cannot open a moved row.

The run's output has `rewrap` and `verify` reports. `byKey` holds counts per key id as read, using the outcomes `total`, `moved`, `alreadyCurrent`, `skipped`, `wrapVerified` and `failed`. `failures` names each failed row by its row id and key id only.

## 1. Add the new key to the set

1. Create `NEW_KEY_ARN`: symmetric, automatic rotation on. Apply the guards below before any data is wrapped with it.
2. Give `APP_PRINCIPAL` `kms:Encrypt` and `kms:Decrypt` on `NEW_KEY_ARN`. For a move to another account, the new principal also needs both actions on `OLD_KEY_ARN`, and that takes **both** a statement in the old key's key policy and the principal's own IAM policy. Scope every grant on the old key with `StringEquals` on `kms:EncryptionContext:purpose` = `codenaya-project-env-v1`. Encrypt on the old key is for the move window only. It keeps rollback able to save.
3. Check the grants with the AWS CLI and a dummy string such as `canary-not-secret`, never a real value. Encrypt it under the old key with context `purpose=codenaya-project-env-v1`. Decrypting it as the new principal must work, and decrypting it with a different context must fail. Then encrypt and decrypt a dummy under the new key.

## 2. Switch the writer key

Set the host configuration, then redeploy **every** live deployment, including preview and dev hosts that share the database:

- `ENV_VARS_KMS_KEY_ARN` = `NEW_KEY_ARN`
- `ENV_VARS_KMS_PREVIOUS_KEY_ARNS` = the existing list plus `OLD_KEY_ARN`, minus `NEW_KEY_ARN` (comma list, unwrap only). Keep every key that still has rows, or those rows stop opening.
- `ENV_VARS_KMS_ACCESS_KEY_ID` / `ENV_VARS_KMS_SECRET_ACCESS_KEY` = the principal from step 1
- `ENV_VARS_KMS_REGION` = the region in `NEW_KEY_ARN`, or unset it. If it differs from the current key's region, every secret save and read fails.

New saves now go to the new key, and rows on either key still open.

## 3. Run and verify

1. Send `env-vars/kms.rewrap`.
2. The move is done when the `verify` report lists **only** `NEW_KEY_ARN`, with `wrapVerified` equal to `total` and no failures. Look into every failure (an unknown ARN, a key outside the set, a tampered or corrupt wrap). Re-run after fixing the cause. Never delete rows to make the count reach zero.
3. Take a fresh Convex backup.

## Rollback (config only)

Until step 4 removes any grants:

1. Set `ENV_VARS_KMS_KEY_ARN` = `OLD_KEY_ARN`, `ENV_VARS_KMS_PREVIOUS_KEY_ARNS` = the existing list plus `NEW_KEY_ARN`, minus `OLD_KEY_ARN`, and `ENV_VARS_KMS_REGION` = the region in `OLD_KEY_ARN` (or unset it). Keep the credentials from step 2, which hold Encrypt and Decrypt on both keys. Then redeploy. Because both keys stay in the set, rows on either key still open and new saves go to the old key.
2. Optionally re-run `env-vars/kms.rewrap` to move rows back to the old key.

## 4. Retire the old key

Keep the old key **enabled** until step 3 shows every wrap verified and a fresh backup exists. A key leaves `ENV_VARS_KMS_PREVIOUS_KEY_ARNS` only through these steps, after its own recount shows zero rows. Then:

1. Freeze writes to it. Remove `kms:Encrypt` on the old key from every principal.
   - Same principal for both keys (a same-account move): do **not** deactivate its access keys. They are the credentials the host uses now.
   - A new principal: first confirm every serving deployment uses the new principal's credentials, then deactivate the old principal's access keys.
2. Re-run `env-vars/kms.rewrap`. The `verify` report must show zero rows on the old key.
3. Remove `OLD_KEY_ARN` from `ENV_VARS_KMS_PREVIOUS_KEY_ARNS` and redeploy. Remove the remaining grants on the old key.
4. **Disable** the old key (through `BREAK_GLASS_ROLE`) for a grace period, 30 days recommended, with an alarm on any attempted use.
5. **Never schedule deletion** without fresh approval from the owner and a recount showing zero rows on that key immediately before.

## AWS guard checklist (operator)

Apply these to every env-var key, including a newly created one, in that key's own account. They guard against accidents and outsiders, not against the account administrator.

- [ ] Add a key-policy statement with `Effect: Deny` on `kms:ScheduleKeyDeletion` and `kms:DisableKey` for `Principal: "*"`, with `Condition: StringNotEquals aws:PrincipalArn = <BREAK_GLASS_ROLE ARN>`. Do not use `NotPrincipal`. Do not include `kms:PutKeyPolicy`, and never set `BypassPolicyLockoutSafetyCheck`.
- [ ] Prove the deny with the IAM policy simulator (`simulate-principal-policy` with the key policy as the resource policy), not with a live `DisableKey`.
- [ ] Create a break-glass role in each key's account. Use it only for the retirement disable and any approved deletion.
- [ ] Alert (EventBridge on CloudTrail management events) on `ScheduleKeyDeletion`, `DisableKey`, `PutKeyPolicy` and `CreateGrant` for the env-var keys. This needs an enabled CloudTrail trail. A scheduled deletion waits 7–30 days and can be cancelled, so the alert makes it recoverable.
- [ ] Turn on root MFA, do not use the root user day to day, and keep the root recovery details current.
- [ ] Scope production KMS credentials to the production host environment only.

## Limits

- One run covers about 25,000 env-var rows, public ones included (Inngest's step cap over two passes of 50-row pages). A larger table needs the cursor carried into a follow-up run, which is not built yet.
