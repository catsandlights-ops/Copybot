# Code-signing the Windows installer (optional)

Without a code signature, Windows SmartScreen warns people who download Copybot
("Windows protected your PC" → **More info → Run anyway**). Signing the installer with a
certificate Microsoft trusts removes that warning.

This is separate from Copybot's **update signature** (`UPDATE_SIGNING_KEY`), which stays in place
and keeps protecting automatic updates either way.

## What it costs

Copybot uses **Azure Artifact Signing** (formerly *Trusted Signing*), Microsoft's own signing
service. The Basic plan is about **$9.99/month** for up to 5,000 signatures. Check the current price
at <https://azure.microsoft.com/pricing/details/artifact-signing/> and who can sign up (identity
validation is required, and availability for individuals depends on your country) before subscribing.

## Setup (one time)

1. Create an Azure account and an **Artifact Signing account** (Azure portal → *Artifact Signing
   Accounts* → *Create*). Note its **endpoint** (for example `https://eus.codesigning.azure.net/`)
   and the **account name**.
2. In the signing account, complete **Identity validation** and create a **Certificate profile**
   (type *Public Trust*). Note the **profile name** and the exact **publisher name** shown on it
   (the "CN", usually your legal name).
3. Create an **App registration** (Microsoft Entra ID → *App registrations* → *New*), then a
   **client secret** for it. Note the **tenant ID**, **client (application) ID** and the secret value.
4. In the signing account → *Access control (IAM)*, give that app the role
   **Artifact Signing Certificate Profile Signer** (or *Trusted Signing Certificate Profile Signer*).
5. In GitHub → the Copybot repo → *Settings → Secrets and variables → Actions*, add:

   | Secret | Value |
   |---|---|
   | `AZURE_TENANT_ID` | Tenant ID |
   | `AZURE_CLIENT_ID` | App registration's client ID |
   | `AZURE_CLIENT_SECRET` | The client secret value |
   | `AZURE_SIGNING_ENDPOINT` | The signing account endpoint |
   | `AZURE_SIGNING_ACCOUNT` | The signing account name |
   | `AZURE_CERT_PROFILE` | The certificate profile name |
   | `AZURE_PUBLISHER_NAME` | The publisher name exactly as on the certificate |

The next release builds a signed installer automatically. If the secrets are missing, releases keep
working and are simply unsigned.

## Keep it going once you start

After a signed release, keep the subscription active. Installed copies remember the publisher
name, and the updater can refuse a later update that isn't signed by the same publisher. If you ever
stop signing, ask before releasing so it can be handled safely.
