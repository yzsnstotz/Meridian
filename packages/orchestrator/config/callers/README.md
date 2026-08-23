# Caller Registry

External callers are registered as one JSON file per caller in this directory.
HMAC caller files name the environment variable that contains the runtime
secret; the secret value itself must not be committed.

## HMAC Rotation

1. Generate a new secret for the caller's target environment.
2. Update the caller runtime, such as ADS local `.env.local` or the production
   secret store, with the new value.
3. Restart meridian-roles with the same env var name populated so the registry
   can validate the caller at boot.
4. Verify a signed request against the caller's allowed project endpoints.
5. Revoke the old runtime secret from the caller environment.
