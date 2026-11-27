# Add our API keys to the Chainlink vault

Our two Chainlink workflows (`asset-feeds`, `stellar-feeds`) run on Chainlink's network. To use our Uniblock, FRED and
Massive API keys there, the keys have to be stored in Chainlink's encrypted vault. Chainlink only accepts this from a
person signed in through a browser, so it runs on **your own computer**. It takes about 10 minutes and you do it once.

You need:
- Your Chainlink account with the **CRE Admin** or **CRE Developer** role (check at https://app.chain.link → organization **Shadow Diamondz** → members).
- The three keys: **Uniblock** (from your Uniblock dashboard), **FRED** and **Massive** (the ones you already have).

Copy each grey box exactly as shown. Lines starting with `#` are notes; you can paste them too, the terminal ignores them.

---

## Step 1 — Open a terminal

- **Mac:** press `Cmd + Space`, type `Terminal`, press Enter.
- **Windows:** press the Windows key, type `PowerShell`, press Enter.

## Step 2 — Install the Chainlink CRE tool

**Mac:**
```bash
curl -sSfL https://cre.chain.link/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://cre.chain.link/install.ps1 | iex
```

Close the terminal and open a new one, then check it worked:
```bash
cre version
```
You should see `CRE CLI version v1.41.0` or newer.

## Step 3 — Sign in to Chainlink

```bash
cre login
```
Your browser opens. Sign in with your Chainlink account. Then confirm:
```bash
cre whoami
```
You should see **Organization Name: Shadow Diamondz** and **Deploy Access: Enabled**.

## Step 4 — Get this folder onto your computer

**With git** (Mac, or Windows with Git installed):
```bash
git clone https://github.com/DiamondzShadow/diamondz-tokenize.git
cd diamondz-tokenize/cre
```

**Without git:** on https://github.com/DiamondzShadow/diamondz-tokenize click the green **Code** button →
**Download ZIP**, unzip it, then in the terminal go to the `cre` folder inside it, for example:
```bash
cd ~/Downloads/diamondz-tokenize-main/cre
```
(Windows: `cd $HOME\Downloads\diamondz-tokenize-main\cre`)

## Step 5 — Put your keys in a private file

**Mac:**
```bash
cp vault-setup/vault.env.example vault-setup/vault.env
open -e vault-setup/vault.env
```

**Windows (PowerShell):**
```powershell
Copy-Item vault-setup\vault.env.example vault-setup\vault.env
notepad vault-setup\vault.env
```

The file opens. Paste each key right after its `=` sign, with no spaces or quotes:
```
UNIBLOCK_KEY_VAR=your-uniblock-key
FRED_KEY_VAR=your-fred-key
MASSIVE_KEY_VAR=your-massive-key
```
Save and close the file. Git ignores `vault.env`, so it never gets uploaded.

## Step 6 — Send the keys to the Chainlink vault

Still in the `cre` folder:

**Mac:**
```bash
cre secrets create vault-setup/secrets.yaml --target staging-settings --secrets-auth=browser -e vault-setup/vault.env
```

**Windows (PowerShell):**
```powershell
cre secrets create vault-setup\secrets.yaml --target staging-settings --secrets-auth=browser -e vault-setup\vault.env
```

Your browser opens a Chainlink sign-in. **Sign in right away** (the link expires after about a minute). When the
terminal shows success, you're done.

Check that all three are stored (it opens the browser once more):
```bash
cre secrets list --target staging-settings --secrets-auth=browser
```
You should see `UNIBLOCK_API_KEY_SECRET`, `FRED_API_KEY_SECRET` and `MASSIVE_API_KEY_SECRET`.

## Step 7 — Delete the key file and tell Claude

**Mac:** `rm vault-setup/vault.env`  ·  **Windows:** `Remove-Item vault-setup\vault.env`

Then tell Claude "vault done". Claude switches the workflows over to Uniblock, FRED and Massive and redeploys them.

---

## If something goes wrong

| What you see | What to do |
|---|---|
| `cre: command not found` | Close the terminal, open a new one, try again. |
| Browser shows **"Oops!, something went wrong"** | Run Step 6 again and sign in within a minute. If it keeps happening, check your role (top of this page), then ask your Chainlink contact. |
| `already exists` | A key was stored before. Run the same Step 6 command with `update` instead of `create`. |
| `environment variable ... not found` | A line in `vault.env` is empty or misspelled. Fix it and rerun Step 6. |

To change a key later (for example a new FRED key), edit `vault.env` and run Step 6 with `update` instead of `create`.
