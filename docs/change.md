## Changing Guide

### API Routes
the routes are added to /Routes/ folder. For example tts-route.ts.  They are all registered in /Routes/index.ts. THis means that in app.ts I am only importing from Index.ts and don't have to grow it each time a route is added. 

### Key Vault Changes
When going live: set SECRETS_PROVIDER=azure-key-vault and KEY_VAULT_URL=https://<vault>.vault.azure.net/ â no code changes needed, DefaultAzureCredential picks up managed identity in Azure.

### Authorizations
auth.ts blocks all except the ones that are explicitly exempt such as health.
