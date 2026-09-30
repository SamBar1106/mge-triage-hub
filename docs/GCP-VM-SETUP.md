# MGE Scraper: Google Cloud e2-micro VM Setup Guide

This guide provides step-by-step instructions to set up an always-on, low-cost virtual machine (VM) in **Google Cloud Platform (GCP)** to run the MGE triage data collection pipeline. It targets **Samuel** on an **Intel Mac** (macOS x86_64, using official installers without Homebrew) and provides exact terminal commands to copy and paste, the expected output for each command, and Cloud Console (web UI) alternatives for every cloud step.

---

## 0. Architectural Reality: What Must Be Built First

> [!IMPORTANT]
> **There is currently NO standalone Linux scraper in this repository.**
> Today, the scraper is a Chrome Manifest V3 browser extension located in `extension/` that runs inside a desktop Google Chrome profile on a Windows PC where NetSuite is already logged in. Chrome extensions cannot run headless on a bare Linux server.

Before this VM can collect data, a **headless Python scraper must be built as a separate future task**. The VM setup instructions in this document describe the server environment where that future scraper will run.

### The Headless Port Specification (Future Task)
The future Python scraper will live in `scripts/scraper/` and must replicate the extension pipeline:
1. **Headless Engine**: Python 3.11+ using [Playwright](https://playwright.dev/python/) (`playwright install chromium --with-deps`).
2. **Saved Search Extraction**: Hit `https://3940793.app.netsuite.com` saved search ID `72` (Active Client List), extract paginated results, and map headers identically to [`extension/scrapers/clientList.js`](file:///Users/samuelbarrios/mge-triage-hub/extension/scrapers/clientList.js).
3. **PDF Schedules**: Query the Suitelet URLs and extract doctor-owner schedule rows and valid consultation dates identically to [`extension/scrapers/pdfSchedule.js`](file:///Users/samuelbarrios/mge-triage-hub/extension/scrapers/pdfSchedule.js).
4. **Unscheduled Backlog**: Scrape backlog records identically to [`extension/scrapers/backlog.js`](file:///Users/samuelbarrios/mge-triage-hub/extension/scrapers/backlog.js).
5. **Triage Classification**: Port [`extension/lib/buckets.js`](file:///Users/samuelbarrios/mge-triage-hub/extension/lib/buckets.js) to Python (`mge_buckets.py`) to categorize clients into `pending`, `incomplete`, and `complete`.
6. **Encryption Standard**: Port [`extension/lib/crypto.js`](file:///Users/samuelbarrios/mge-triage-hub/extension/lib/crypto.js) to Python (`mge_crypto.py`) using `cryptography`:
   - Algorithm: **AES-GCM-256**
   - Key Derivation: **PBKDF2-HMAC-SHA256** with 250,000 iterations and a 16-byte random salt
   - Initialization Vector (IV): 12-byte random IV
   - Additional Authenticated Data (AAD): `"mge:" + filename` (e.g., `mge:clients_directory.csv`)
   - Compression: Standard gzip before encryption (`z: "gzip"`)
   - Envelope: JSON structure `{ v: 1, name, alg: "AES-GCM-256", kdf: "PBKDF2-SHA256", iter: 250000, z: "gzip", salt, iv, ct, createdAt }`
7. **Output Contract**: Write encrypted files to `data/enc/` and write execution metadata to `data/enc/last_run.json`, then commit and push to `main` via Git or the GitHub REST API.

---

## 1. Google Cloud Project Setup & Intel Mac CLI Installation

Follow these steps on your Intel Mac to install the Google Cloud CLI (without Homebrew), create the GCP project, attach billing, set a safety budget alert, and enable Compute Engine.

### 1.1 Install the Google Cloud CLI on Intel Mac (Official Installer)
Run these commands in Terminal on your Mac:

```bash
# 1. Verify you are on an Intel Mac (returns i386 or x86_64)
uname -m
```
*Expected output:*
```
x86_64
```

```bash
# 2. Check Python 3 version (3.10 to 3.12 supported by gcloud)
python3 --version
```
*Expected output:*
```
Python 3.11.x
```

```bash
# 3. Download the official Google Cloud CLI archive for macOS x86_64
cd ~
curl -O https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-darwin-x86_64.tar.gz

# 4. Extract archive
tar -xf google-cloud-cli-darwin-x86_64.tar.gz

# 5. Run official install script
./google-cloud-sdk/install.sh --quiet --path-update true --command-completion true

# 6. Apply PATH update to current shell session (zsh is default on macOS)
source ~/.zshrc

# 7. Verify gcloud binary
gcloud version
```
*Expected output:*
```
Google Cloud SDK 510.x.x
...
```

*Official Reference:* [Google Cloud CLI Install Documentation](https://cloud.google.com/sdk/docs/install)

---

### 1.2 Initialize gcloud and Create the Project
Replace `mge-triage-scraper` with your desired globally unique project ID if needed.

```bash
# 1. Authenticate with your Google account
gcloud auth login
```
*A browser window opens. Sign in with your Google account and grant permissions.*
*Expected output:*
```
You are now logged in as [your-email@gmail.com].
```

```bash
# 2. Create the project
gcloud projects create mge-triage-scraper --name="MGE Triage Scraper"
```
*Expected output:*
```
Create in progress for [https://cloudresourcemanager.googleapis.com/v1/projects/mge-triage-scraper].
Waiting for [operations/cp.1234567890] to finish...done.
Enabling service [cloudapis.googleapis.com] on project [mge-triage-scraper]...done.
```

```bash
# 3. Set the active project in gcloud
gcloud config set project mge-triage-scraper
```
*Expected output:*
```
Updated property [core/project].
```

---

### 1.3 Link a Billing Account
Google Cloud requires a billing account to activate Compute Engine, even for Always Free tier resources.

```bash
# 1. List billing accounts to find your billing account ID
gcloud billing accounts list
```
*Expected output:*
```
ACCOUNT_ID            NAME                OPEN  MASTER_ACCOUNT_ID
012345-6789AB-CDEF01  My Billing Account  True
```

```bash
# 2. Link your billing account to the project
gcloud billing projects link mge-triage-scraper --billing-account=012345-6789AB-CDEF01
```
*Expected output:*
```
billingAccountName: billingAccounts/012345-6789AB-CDEF01
billingEnabled: true
name: projects/mge-triage-scraper/billingInfo
projectId: mge-triage-scraper
```

---

### 1.4 Set a $1.00 Budget Alert
To guarantee you receive an immediate alert if any billable services run beyond the free allowances, configure a $1 budget with email thresholds.

```bash
gcloud billing budgets create \
  --billing-account=012345-6789AB-CDEF01 \
  --display-name="MGE Scraper Free-Tier Guard" \
  --budget-amount=1.00USD \
  --threshold-rule=percent=0.50 \
  --threshold-rule=percent=0.90 \
  --threshold-rule=percent=1.00
```
*Expected output:*
```
Created [MGE Scraper Free-Tier Guard].
```

---

### 1.5 Enable the Compute Engine API

```bash
gcloud services enable compute.googleapis.com
```
*Expected output:*
```
Waiting for completed jobs...done.
Operation "operations/acat.p2-1234567890-..." finished successfully.
```

---

### Alternative: Console Instructions for Section 1
If you prefer using the web console:
1. **Sign In**: Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. **Create Project**: Click the project dropdown at the top > **New Project** > Name: `MGE Triage Scraper` > **Create**.
3. **Link Billing**: Go to **Billing** > **Account Management** > Link `MGE Triage Scraper` to your billing account.
4. **Create Budget**: Go to **Billing** > **Budgets & alerts** > **Create Budget**:
   - Scope: Projects = `MGE Triage Scraper`.
   - Amount: Target amount = `$1.00`.
   - Actions: Trigger alerts at 50%, 90%, and 100% of budget.
5. **Enable API**: In the top search bar, search for `Compute Engine API`, click it, and click **Enable**.

---

## 2. Provisioning the Free-Tier e2-micro VM Instance

The Google Cloud Always Free tier includes **one non-preemptible `e2-micro` instance** per month, provided it is located in one of three US regions:
- `us-central1` (Iowa) — *Recommended*
- `us-east1` (South Carolina)
- `us-west1` (Oregon)

### 2.1 Create a Minimal Service Account
Do not use the default Compute Engine service account with editor scopes. Create a dedicated service account with zero cloud permissions:

```bash
gcloud iam service-accounts create mge-vm-sa \
  --description="Minimal service account for MGE Scraper VM with no GCP roles" \
  --display-name="mge-vm-sa"
```
*Expected output:*
```
Created service account [mge-vm-sa].
```

---

### 2.2 Launch the VM Instance (CLI)

> [!WARNING]
> You **must** specify `--boot-disk-type=pd-standard`. The console default is often `pd-balanced`, which is **not** covered by the Always Free 30 GB allowance and will incur monthly disk charges.

```bash
gcloud compute instances create mge-scraper-vm \
  --project=mge-triage-scraper \
  --zone=us-central1-a \
  --machine-type=e2-micro \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --boot-disk-size=30GB \
  --boot-disk-type=pd-standard \
  --network-interface=network-tier=STANDARD \
  --service-account=mge-vm-sa@mge-triage-scraper.iam.gserviceaccount.com \
  --no-scopes \
  --tags=mge-scraper-vm
```
*Expected output:*
```
Created [https://www.googleapis.com/compute/v1/projects/mge-triage-scraper/zones/us-central1-a/instances/mge-scraper-vm].
NAME            ZONE           MACHINE_TYPE  PREEMPTIBLE  INTERNAL_IP  EXTERNAL_IP    STATUS
mge-scraper-vm  us-central1-a  e2-micro                   10.128.0.2   34.xxx.xxx.xxx RUNNING
```

**Parameters Explained:**
- `--machine-type=e2-micro`: 2 vCPUs, 1 GB RAM (Always Free).
- `--zone=us-central1-a`: Free tier eligible region.
- `--boot-disk-size=30GB`: Maximum standard disk size covered by Always Free.
- `--boot-disk-type=pd-standard`: Standard magnetic persistent disk (free tier eligible).
- `--network-interface=network-tier=STANDARD`: Uses standard routing. An ephemeral external IPv4 address is assigned.
- `--no-scopes`: Removes all GCP API access privileges from the VM.

*Official Reference:* [Google Cloud Free Program Features](https://cloud.google.com/free/docs/free-cloud-features#compute)

---

### Alternative: Console Instructions for Section 2
1. Go to **Compute Engine > VM instances** and click **Create Instance**.
2. **Name**: `mge-scraper-vm`.
3. **Region / Zone**: Select `us-central1 (Iowa)` and `us-central1-a`.
4. **Machine Configuration**:
   - Machine family: `General-purpose`.
   - Series: `E2`.
   - Machine type: `e2-micro (2 vCPU, 1 core, 1 GB memory)`.
5. **Boot Disk** (Click **Change**):
   - Operating System: `Debian`.
   - Version: `Debian GNU/Linux 12 (bookworm)`.
   - Boot disk type: Select **Standard persistent disk** *(DO NOT leave on Balanced)*.
   - Size: `30` GB.
   - Click **Select**.
6. **Identity and API access**:
   - Service account: Select `mge-vm-sa` (created in Step 2.1).
   - Access scopes: Select **Set access for each API** and leave all disabled, or select **No API access**.
7. **Networking** (Expand **Advanced options > Networking**):
   - Network interfaces: Click `default`.
   - External IPv4 address: Ensure `Ephemeral` is selected.
   - Network Service Tier: `Standard` (or `Premium`).
8. **Firewalls**: Uncheck both "Allow HTTP traffic" and "Allow HTTPS traffic" (inbound web ports are not needed).
9. Click **Create**.

---

## 3. OS Selection: Debian 12 vs. Ubuntu 24.04 LTS

| Evaluation Metric | Debian 12 (Bookworm) — **Recommended** | Ubuntu 24.04 LTS |
|---|---|---|
| **Base RAM Footprint** | **~60 MB – 80 MB** upon boot | ~220 MB – 320 MB upon boot |
| **Background Daemons** | Minimal systemd baseline | Runs `snapd`, `multipathd`, `canonical-livepatch`, telemetry |
| **Impact on `e2-micro`** | Leaves **>900 MB RAM** available for Playwright | Consumes ~30% of total memory before launching browser |
| **Stability & Lifecycle** | Rock-solid Debian stable; 5-year security updates | 5-year LTS support; frequent snap updates |
| **Package Manager** | Standard `apt` with native binary packages | Pushes `snap` packages for common tools (e.g., Chromium) |

**Why Debian 12 is chosen:**
An `e2-micro` VM has only **1 GB of physical memory**. Headless Chromium requires 500 MB to 900 MB when rendering dynamic NetSuite tables and compiling PDF schedules. Debian 12 provides the leanest OS runtime without background snap daemons competing for memory.

---

## 4. VM Hardening, Firewall, Swap & System Setup

### 4.1 Connect via SSH with Identity-Aware Proxy (IAP)
Use `gcloud compute ssh`. By enabling `--tunnel-through-iap`, connections tunnel through Google's secure Identity-Aware Proxy, eliminating the need to expose port 22 to the public internet.

```bash
gcloud compute ssh mge-scraper-vm --zone=us-central1-a --tunnel-through-iap
```
*Expected output:*
```
Updating project ssh metadata...
Linux mge-scraper-vm 6.1.0-xx-cloud-amd64 #1 SMP PREEMPT_DYNAMIC Debian 6.1.xx (bookworm)
samuel@mge-scraper-vm:~$
```

---

### 4.2 Restrict Inbound Firewall to IAP Only
Run this from your **Mac terminal** (or Cloud Shell) to lock down the SSH port so internet bots cannot scan or brute-force port 22:

```bash
# 1. Allow SSH strictly from Google's IAP netblock (35.235.240.0/20)
gcloud compute firewall-rules create allow-ssh-ingress-from-iap \
  --direction=INGRESS \
  --action=ALLOW \
  --rules=tcp:22 \
  --source-ranges=35.235.240.0/20 \
  --target-tags=mge-scraper-vm

# 2. Delete the default open-to-world SSH rule if present in the default VPC
gcloud compute firewall-rules delete default-allow-ssh --quiet || true
```
*Expected output:*
```
Created [https://www.googleapis.com/compute/v1/projects/mge-triage-scraper/global/firewallRules/allow-ssh-ingress-from-iap].
```

*Official Reference:* [Google Cloud IAP TCP Forwarding Documentation](https://cloud.google.com/iap/docs/using-tcp-forwarding)

---

### 4.3 System Updates & Unattended Upgrades
Perform the following steps **inside the VM SSH shell**:

```bash
# 1. Update package lists and upgrade existing packages
sudo apt update && sudo apt upgrade -y

# 2. Install unattended-upgrades to automatically apply security patches
sudo apt install -y unattended-upgrades

# 3. Enable unattended-upgrades non-interactively
echo unattended-upgrades unattended-upgrades/enable_auto_updates boolean true | sudo debconf-set-selections
sudo dpkg-reconfigure -f noninteractive unattended-upgrades
```
*Expected output:*
```
Replacing config file /etc/apt/apt.conf.d/20auto-upgrades with new version
```

---

### 4.4 Create a 2 GB Swap File (Essential for 1 GB RAM)
Because the `e2-micro` VM has only 1 GB RAM, headless Chromium will crash with an **Out Of Memory (OOM) error** unless swap memory is active.

```bash
# 1. Allocate 2 GB file
sudo fallocate -l 2G /swapfile

# 2. Set strict permissions (read/write root only)
sudo chmod 600 /swapfile

# 3. Format as swap
sudo mkswap /swapfile
```
*Expected output:*
```
Setting up swapspace version 1, size = 2 GiB (2147479552 bytes)
no label, UUID=...
```

```bash
# 4. Activate swap
sudo swapon /swapfile

# 5. Persist swap in /etc/fstab across reboots
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# 6. Configure swappiness to 10 (prefers RAM, uses swap when memory pressure hits)
sudo sysctl vm.swappiness=10
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.d/99-swap.conf

# 7. Verify memory and swap status
free -h
```
*Expected output:*
```
               total        used        free      shared  buff/cache   available
Mem:           961Mi       112Mi       620Mi       1.0Mi       229Mi       732Mi
Swap:          2.0Gi          0B       2.0Gi
```

---

### 4.5 Create the Dedicated `mge` Service User
To maintain least privilege, the scraper and scheduled timers run under a dedicated system user `mge` rather than `root`:

```bash
# Create mge user with home directory and bash shell
sudo useradd -m -s /bin/bash mge

# Create application, configuration, and log directories
sudo mkdir -p /opt/mge /etc/mge /var/log/mge
sudo chown -R mge:mge /opt/mge /etc/mge /var/log/mge
```

---

### 4.6 Install Python 3, venv, and Base Tools

```bash
sudo apt install -y python3 python3-venv python3-pip git curl jq

# Create the dedicated Python virtual environment for mge
sudo -u mge python3 -m venv /opt/mge/venv

# Verify venv Python version
sudo -u mge /opt/mge/venv/bin/python3 --version
```
*Expected output:*
```
Python 3.11.2
```

---

## 5. Repository Retrieval & Authentication

The VM requires access to `https://github.com/SamBar1106/mge-triage-hub` to push encrypted updates to `main`. Choose **Option A (Deploy Key, Recommended)** or **Option B (Fine-Grained Token)**.

### Option A: GitHub Deploy Key with Write Access (Recommended)
A deploy key is scoped strictly to this single repository and cannot access your personal GitHub account.

```bash
# 1. Generate an ED25519 SSH keypair as the mge user
sudo -u mge ssh-keygen -t ed25519 -C "mge-scraper-vm" -f /home/mge/.ssh/id_ed25519 -N ""

# 2. Print the public key
sudo cat /home/mge/.ssh/id_ed25519.pub
```
*Expected output:*
```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... mge-scraper-vm
```

**Add the key to GitHub:**
1. Open your browser and navigate to: https://github.com/SamBar1106/mge-triage-hub/settings/keys
2. Click **Add deploy key**.
3. **Title**: `GCP e2-micro VM Scraper`.
4. **Key**: Paste the output from `sudo cat /home/mge/.ssh/id_ed25519.pub`.
5. Check **Allow write access** *(Required to commit encrypted CSVs to main)*.
6. Click **Add key**.

**Clone the repository:**
```bash
# 3. Add github.com to known_hosts
sudo -u mge ssh-keyscan -t ed25519 github.com | sudo -u mge tee /home/mge/.ssh/known_hosts

# 4. Clone the repository into /opt/mge/mge-triage-hub
sudo -u mge git clone git@github.com:SamBar1106/mge-triage-hub.git /opt/mge/mge-triage-hub
```
*Expected output:*
```
Cloning into '/opt/mge/mge-triage-hub'...
remote: Enumerating objects: ...
Resolving deltas: 100% ... done.
```

---

### Option B: HTTPS with a Fine-Grained Personal Access Token (PAT)
If using HTTPS:
1. Go to **GitHub > Settings > Developer Settings > Personal access tokens > Fine-grained tokens > Generate new token**.
2. **Token name**: `mge-gcp-vm-uploader`.
3. **Repository access**: *Only select repositories* > `SamBar1106/mge-triage-hub`.
4. **Permissions**: *Repository permissions* > **Contents: Read and write**.
5. Copy the generated token (`github_pat_...`).

**Store the token securely on the VM:**
```bash
# Read token without saving to bash history
read -s -p "Paste GitHub Fine-Grained Token: " GH_TOKEN; echo ""

# Store in /home/mge/.git-credentials with 600 permissions
echo "https://oauth2:${GH_TOKEN}@github.com" | sudo -u mge tee /home/mge/.git-credentials > /dev/null
sudo chmod 600 /home/mge/.git-credentials
sudo -u mge git config --global credential.helper store
unset GH_TOKEN

# Clone the repository
sudo -u mge git clone https://github.com/SamBar1106/mge-triage-hub.git /opt/mge/mge-triage-hub
```

---

## 6. Secure Secrets Management (`/etc/mge/scraper.env`)

Secrets must **never** be placed in code, commit history, systemd command lines, cron files, or shell history.

### 6.1 Interactive Secret Creation (Shell History Safe)
Run this interactive block inside the VM SSH session. The `read -s` command suppresses terminal echoing and prevents values from appearing in `~/.bash_history`:

```bash
read -p "NetSuite Account ID [3940793]: " NS_ACCOUNT
NS_ACCOUNT=${NS_ACCOUNT:-3940793}
read -p "NetSuite Login Email: " NS_EMAIL
read -s -p "NetSuite Password: " NS_PASSWORD; echo ""
read -s -p "MGE Team Passphrase (for AES-GCM): " MGE_PASSPHRASE; echo ""
read -s -p "GitHub Token (Fine-grained PAT): " GITHUB_TOKEN; echo ""

sudo tee /etc/mge/scraper.env > /dev/null <<EOF
# MGE Scraper Environment Variables
NETSUITE_ACCOUNT=${NS_ACCOUNT}
NETSUITE_EMAIL=${NS_EMAIL}
NETSUITE_PASSWORD=${NS_PASSWORD}
MGE_PASSPHRASE=${MGE_PASSPHRASE}
GITHUB_TOKEN=${GITHUB_TOKEN}
GITHUB_OWNER=SamBar1106
GITHUB_REPO=mge-triage-hub
GITHUB_BRANCH=main
NETSUITE_SAVED_SEARCH_ID=72
NETSUITE_ORIGIN=https://3940793.app.netsuite.com
EOF

# Lock down file permissions immediately
sudo chown mge:mge /etc/mge/scraper.env
sudo chmod 600 /etc/mge/scraper.env

# Clean memory
unset NS_PASSWORD MGE_PASSPHRASE GITHUB_TOKEN
```

### 6.2 Verify File Security
```bash
ls -l /etc/mge/scraper.env
```
*Expected output:*
```
-rw------- 1 mge mge 324 Sep 29 22:30 /etc/mge/scraper.env
```
*Only `mge` and `root` can read this file. Regular users and world cannot access it.*

---

### 6.3 Alternative: Google Secret Manager (and Quotas)
Google Secret Manager can store these secrets in the cloud:
- **Free Tier Allowance**: **6 active secret versions** per month, and **10,000 API access operations** per month.
- Running the scraper 3 times per day accesses 3 secrets 90 times per month (~270 operations/month), which falls safely within the 10,000 free operations limit.
- **Why `/etc/mge/scraper.env` is preferred here**: A local `600` file requires zero cloud IAM permissions, incurs $0 risk of accidental secret operation charges, works completely offline from Google APIs, and aligns with standard Linux `systemd EnvironmentFile` best practices.

*Official Reference:* [Google Secret Manager Pricing](https://cloud.google.com/secret-manager/pricing)

---

## 7. NetSuite Authentication, 2FA Limits & IP Restrictions

### 7.1 NetSuite 2FA Requirements & "Trust This Device" Durations
Oracle NetSuite enforces mandatory Two-Factor Authentication (2FA) for all Administrator and highly privileged roles. **2FA cannot be disabled for these roles.**

**Configuring Trusted Device Duration in NetSuite:**
1. Sign into NetSuite as an Administrator.
2. Navigate to: **Setup > Users/Roles > Two-Factor Authentication Roles**.
3. In the **Duration of Trusted Device** column for the scraper user's role:
   - Available options: `Per session`, `4 hours`, `6 hours`, `8 hours`, `12 hours`, or `1 to 30 days`.
   - Select **30 days** *(the maximum duration allowed by Oracle NetSuite)*.
4. When logging in interactively from the browser, check **"Trust this device for 30 days"**.

> [!WARNING]
> **The 30-Day Boundary:** NetSuite strictly invalidates trusted device tokens after **30 days**. At the end of 30 days, NetSuite forces a new 2FA verification challenge. Furthermore, if browser cookies clear, the user-agent string changes, or IP reputation changes occur, NetSuite prompts for 2FA immediately.

*Official Reference:* [Oracle NetSuite 2FA Roles & Permissions](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1508861214.html)

---

### 7.2 NetSuite IP Address Restrictions & The Ephemeral IP Conflict
NetSuite allows restricting logins to authorized IP addresses at the company or employee level:
- **Navigation**: **Setup > Company > Enable Features > Company tab > Access section > check "IP Address Rules"**.
- **Employee-Specific Whitelist**: Go to **Lists > Employees > Employees > [Select Scraper User] > Edit > Access tab > uncheck "Inherit IP Rules From Company" > enter allowed IPv4 in "IP Address Restriction"**.

#### The IP vs. Cost Conflict Explained:
1. **The Cost Dilemma**: A reserved static external IPv4 address in Google Cloud costs **$0.005 per hour (~$3.65/month)** while in use, and **$0.010 per hour (~$7.30/month)** if unattached.
2. **The Ephemeral IP Behavior**: An ephemeral IP address is allocated to the VM at creation.
   - **Reboots**: If the VM reboots (`sudo reboot`), the ephemeral external IP **does not change**.
   - **Stop / Start**: If the VM is stopped via GCP (`gcloud compute instances stop`) and restarted, Google **releases the ephemeral IP and assigns a completely new IP address**.
   - **The Failure Mode**: If the IP changes, NetSuite's IP whitelist will reject all scraper logins until an administrator manually logs into NetSuite from an exempt account and updates the whitelist with the new IP address.
3. **The Stability Rule**: To keep your ephemeral external IP stable without paying for a static reservation, **never stop the VM instance**. Keep it running continuously (covered 100% by the Always Free e2-micro compute allowance).

---

### 7.3 The Preferred Sanctioned Route: Token-Based Authentication (TBA)
Instead of password scraping through headless browser emulation, **Token-Based Authentication (TBA)** using NetSuite's official **SuiteTalk REST API / SuiteQL** is the sanctioned enterprise architecture.

**Why TBA / SuiteQL is Recommended:**
- **No 2FA Interruptions**: Programmatic TBA requests do not invoke interactive 2FA login challenges.
- **No 30-Day Expiration**: Tokens remain valid indefinitely until explicitly revoked.
- **DOM Independence**: Programmatic SuiteQL queries (`SELECT id, entityid, email FROM customer`) never break when NetSuite updates its HTML stylesheets or table layouts.
- **IP Resilience**: TBA works across changing IP addresses unless specific token restrictions are configured.

**Setting up TBA in NetSuite (For Future Implementation):**
1. **Enable Feature**: **Setup > Company > Enable Features > SuiteCloud > Token-based Authentication** (check and save).
2. **Create Integration Record**: **Setup > Integration > Manage Integrations > New**:
   - Name: `MGE Triage Hub Scraper`.
   - Token-based Authentication: Checked.
   - Note down: `Consumer Key` and `Consumer Secret`.
3. **Issue Access Token**: **Setup > Users/Roles > Access Tokens > New**:
   - Select the Application, User, and Role.
   - Note down: `Token ID` and `Token Secret`.

*Official Reference:* [Oracle NetSuite Token-based Authentication](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4223126742.html)

---

## 8. Automated Scheduling: Systemd Service, Timer & Task 003 Skip Logic

The scraper runs on a **three-times-daily staggered schedule**: **10:00 AM, 12:00 PM, and 4:00 PM (16:00)** America/Chicago time.

### 8.1 Configure the Server Timezone
NetSuite and the MGE office operate in `America/Chicago`. Set the VM clock to Chicago time so cron expressions and logs align:

```bash
sudo timedatectl set-timezone America/Chicago

# Verify timezone
timedatectl
```
*Expected output:*
```
               Local time: Tue 2026-09-29 22:35:10 CDT
           Universal time: Wed 2026-09-30 03:35:10 UTC
                 RTC time: Wed 2026-09-30 03:35:10
                Time zone: America/Chicago (CDT, -0500)
System clock synchronized: yes
              NTP service: active
          RTC in local TZ: no
```

---

### 8.2 Create the Systemd Runner Script with Task 003 Skip Logic
Create the runner script `/opt/mge/run-scraper.sh`. This script implements the exact **Task 003 skip logic**:
- **At 10:00 AM**: Always runs.
- **At 12:00 PM and 4:00 PM**: Fetches `data/enc/last_run.json` from GitHub. If the status is `success` and the timestamp matches today's date in `America/Chicago`, the run is skipped. If today's run failed, yesterday's run was the last success, or GitHub is unreachable, the scraper runs.

```bash
sudo tee /opt/mge/run-scraper.sh > /dev/null <<'EOF'
#!/bin/bash
set -euo pipefail

ENV_FILE="/etc/mge/scraper.env"
if [ -f "$ENV_FILE" ]; then
    # Export variables from env file
    set -a
    source "$ENV_FILE"
    set +a
fi

REPO_DIR="/opt/mge/mge-triage-hub"
PYTHON_BIN="/opt/mge/venv/bin/python3"
TODAY=$(date +%Y-%m-%d)
CURRENT_HOUR=$(date +%H)

echo "[$(date -Iseconds)] Initiating MGE scraper runner (Hour: ${CURRENT_HOUR}, Date: ${TODAY})..."

# Task 003 Rule: 10:00 always runs. 12:00 and 16:00 check last_run.json first.
if [ "$CURRENT_HOUR" -ne "10" ]; then
    echo "Checking latest status from GitHub repository..."
    LAST_RUN_URL="https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/data/enc/last_run.json"
    
    LAST_STATUS=$(curl -sSL --max-time 15 -H "Authorization: token ${GITHUB_TOKEN}" \
      -H "Cache-Control: no-cache" "$LAST_RUN_URL" || echo "")

    if [ -n "$LAST_STATUS" ]; then
        STATUS_VALUE=$(echo "$LAST_STATUS" | jq -r '.status // empty' 2>/dev/null || echo "")
        TIMESTAMP_VALUE=$(echo "$LAST_STATUS" | jq -r '.timestamp // empty' 2>/dev/null || echo "")
        RUN_DATE=$(echo "$TIMESTAMP_VALUE" | cut -d'T' -f1)

        if [ "$STATUS_VALUE" = "success" ] && [ "$RUN_DATE" = "$TODAY" ]; then
            echo "[$(date -Iseconds)] Skipped: Scraper has already succeeded today ($RUN_DATE at $TIMESTAMP_VALUE)."
            exit 0
        fi
        echo "Prior run was either unsuccessful or from an earlier date ($RUN_DATE). Proceeding with run."
    else
        echo "Unable to retrieve last_run.json from GitHub. Proceeding with run as safety fallback."
    fi
else
    echo "10:00 AM primary run window. Executing unconditionally."
fi

# Execute scraper within the repo directory
cd "$REPO_DIR"

if [ -f "scripts/scraper/main.py" ]; then
    "$PYTHON_BIN" scripts/scraper/main.py
else
    echo "[SIMULATION MODE] Standalone scraper scripts/scraper/main.py not yet implemented."
    echo "Headless port must be built before active scraping begins. Exiting cleanly."
    exit 0
fi
EOF

sudo chmod 755 /opt/mge/run-scraper.sh
sudo chown mge:mge /opt/mge/run-scraper.sh
```

---

### 8.3 Define the Systemd Service (`/etc/systemd/system/mge-scraper.service`)

```bash
sudo tee /etc/systemd/system/mge-scraper.service > /dev/null <<'EOF'
[Unit]
Description=MGE NetSuite Scheduled Scraper
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=mge
Group=mge
WorkingDirectory=/opt/mge/mge-triage-hub
EnvironmentFile=/etc/mge/scraper.env
ExecStart=/bin/bash /opt/mge/run-scraper.sh
TimeoutStartSec=14400
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
```

---

### 8.4 Define the Systemd Timer (`/etc/systemd/system/mge-scraper.timer`)
Configured for **10:00, 12:00, and 16:00** daily:

```bash
sudo tee /etc/systemd/system/mge-scraper.timer > /dev/null <<'EOF'
[Unit]
Description=Timer for MGE NetSuite Scraper (10:00, 12:00, 16:00 America/Chicago)

[Timer]
OnCalendar=*-*-* 10:00:00
OnCalendar=*-*-* 12:00:00
OnCalendar=*-*-* 16:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
```

---

### 8.5 Activate and Verify Timers

```bash
# 1. Reload systemd daemon
sudo systemctl daemon-reload

# 2. Enable and start the timer
sudo systemctl enable --now mge-scraper.timer

# 3. Verify timer scheduling
systemctl list-timers mge-scraper.timer
```
*Expected output:*
```
NEXT                         LEFT          LAST PASSED UNIT              ACTIVATES
Wed 2026-09-30 10:00:00 CDT  11h left      n/a  n/a    mge-scraper.timer mge-scraper.service

1 timers listed.
```

```bash
# 4. View service logs
journalctl -u mge-scraper.service -n 20 --no-pager
```

---

### 8.6 Configure Systemd Journal Log Retention
Prevent logs from filling the 30 GB disk:

```bash
sudo mkdir -p /etc/systemd/journald.conf.d
sudo tee /etc/systemd/journald.conf.d/mge-limit.conf > /dev/null <<EOF
[Journal]
SystemMaxUse=100M
SystemKeepFree=1G
MaxRetentionSec=1month
EOF

sudo systemctl restart systemd-journald
```

---

## 9. Output Persistence, Dashboard Synchronization & Migration Safety

### 9.1 Encrypted Outputs & Contract Compliance
The VM scraper pushes encrypted outputs to `SamBar1106/mge-triage-hub` on branch `main` at `data/enc/`:
- `clients_directory.csv.enc`
- `pdf_directory.csv.enc`
- `unscheduled_backlog.csv.enc`
- `doctor_owner_zero_dates_summary.csv.enc`
- `last_run.json` *(Unencrypted operational status metadata)*

#### Metadata Schema (`data/enc/last_run.json`):
```json
{
  "timestamp": "2026-09-30T10:18:42-05:00",
  "status": "success",
  "clients": 748,
  "pending": 354,
  "contacts": null,
  "pdf": 2835,
  "backlog": 14571
}
```

#### Safeguards Before Pushing:
Like [`extension/background.js`](file:///Users/samuelbarrios/mge-triage-hub/extension/background.js), the scraper must validate row counts against the previous run before uploading:
- **Shrinkage Guard (`SKIPPED_SHRUNK`)**: Do not upload if client rows drop below 50% of the previous run count.
- **Empty Guard (`SKIPPED_EMPTY`)**: Do not upload zero-byte or empty CSV outputs.

---

### 9.2 GitHub Actions Alert Workflow Compatibility
When `data/enc/last_run.json` is committed to `main`, GitHub Actions triggers `.github/workflows/scraper-notify.yml`:
1. **On Success**: The workflow closes any open `scraper-failure` issues, deletes `ANTIGRAVITY_ALERT.md` if present, and dispatches a success confirmation email.
2. **On Failure**: The workflow opens a `scraper-failure` issue, generates `ANTIGRAVITY_ALERT.md` in the repo root to notify coding agents, and emails an alert.
3. **The Static Dashboard**: The live dashboard hosted on GitHub Pages decrypts `data/enc/*.csv.enc` entirely client-side using the team passphrase. It operates identically whether updated by Windows or GCP.

---

### 9.3 Resolving Schedule Conflicts: PC vs. VM Migration
> [!CAUTION]
> **DO NOT RUN BOTH THE WINDOWS EXTENSION AND THE GCP VM ON THE SAME SCHEDULE.**
> If both run concurrently, they will race to push commits to `main` (causing Git push rejections `GH_PUT_409`), spawn duplicate NetSuite sessions (triggering concurrent login security alerts), and generate duplicate email alerts.

#### Migration Checklist:
When you are ready to switch scraping from the Windows PC to the GCP VM:
1. **On the Windows PC**:
   - Open PowerShell:
     ```powershell
     cd C:\MGE\mge-triage-hub-main\scripts\windows
     .\Register-MGEChromeTask.ps1 -Unregister
     ```
   - In Google Chrome, go to `chrome://extensions` and toggle **MGE Nightly NetSuite Scraper** to **OFF** (or remove it).
2. **On the GCP VM**:
   - Verify the systemd timer is active:
     ```bash
     sudo systemctl status mge-scraper.timer
     ```
   - To trigger an immediate test scrape:
     ```bash
     sudo systemctl start mge-scraper.service
     journalctl -u mge-scraper.service -f
     ```

---

## 10. Cost Breakdown & Billing Realities

### 10.1 Comprehensive Monthly Cost Table

| Resource | GCP Configuration | Free Tier Allowance | Unit Rate | Expected Monthly Cost |
|---|---|---|---|---|
| **Compute Instance** | `e2-micro` (2 vCPU, 1 GB RAM) in `us-central1` | 720–744 hours/month (100% of 1 VM) | Free within limits | **$0.00** |
| **Boot Disk** | 30 GB **Standard Persistent Disk** (`pd-standard`) | 30 GB-months per account | Free within limits | **$0.00** |
| **Network Egress** | North America outbound to internet | 1 GB / month free | $0.12 / GB thereafter | **$0.00** (~30 MB/mo used) |
| **External IPv4 Address** | Ephemeral or Static in-use IPv4 | 1 hour free per month | **$0.005 / hour** | **~$3.60 – $3.72** |
| **Network Ingress** | Inbound HTTP/HTTPS from NetSuite/GitHub | Unlimited free | Free | **$0.00** |
| **Snapshots** | Persistent disk snapshots | None included in Always Free | $0.026 / GB / month | **$0.00** (Snapshots disabled) |
| **Secret Manager** | Optional cloud secret storage | 6 active versions, 10,000 accesses | Free within limits | **$0.00** (Local file used) |
| **Total Expected Cost** | | | | **~$3.60 – $3.72 / month** |

---

### 10.2 The External IPv4 Pricing Reality ($0.005/hr, Not $0)
> [!IMPORTANT]
> **Why this VM is not $0.00:**
> Many online guides claim an `e2-micro` VM is "100% completely free forever." **This is outdated and inaccurate.**
> Google Cloud charges for all in-use external IPv4 addresses (both static and ephemeral) at **$0.005 per hour** across standard VMs.
> - Hours in a 30-day month: `720 * $0.005 = $3.60`
> - Hours in a 31-day month: `744 * $0.005 = $3.72`
>
> You will see a small monthly charge of approximately **$3.65** on your Google Cloud invoice for the external IPv4 address.

#### Why Not Remove the External IP?
If you launch the VM without an external IP (`--no-address`), the VM cannot reach NetSuite or GitHub over the internet unless you deploy **Cloud NAT**. However, Cloud NAT charges an hourly gateway fee of **$0.045/hour (~$32.40/month)**. Using a standard ephemeral external IPv4 address at **$0.005/hour (~$3.65/month)** is by far the most economical configuration.

*Official Reference:* [Google Cloud VPC Network Pricing Table](https://cloud.google.com/vpc/network-pricing#ipaddress)

---

### 10.3 Cost Pitfalls to Avoid
1. **Never choose `pd-balanced` or `pd-ssd`**: The Always Free allowance applies **only to `pd-standard`**. Balanced persistent disks will bill ~$3.00/month.
2. **Never leave an unattached static IP**: An unused static IP is billed at the penalty rate of **$0.010/hour (~$7.30/month)**.
3. **Never launch in other regions**: Regions like `us-east4` (Virginia) or European regions are **not** eligible for the Always Free `e2-micro` tier and will bill ~$7.00/month for compute. Stay strictly in `us-central1`, `us-east1`, or `us-west1`.
4. **Never create disk snapshots**: Snapshots incur regional storage charges. The VM is stateless; the entire configuration is preserved in this guide and in GitHub.

*Official Reference:* [Google Cloud Compute Engine Pricing](https://cloud.google.com/compute/all-pricing)

---

## 11. Maintenance & Updates

### Updating Repository Code on the VM
When changes are merged into `main`:

```bash
# 1. Connect to the VM
gcloud compute ssh mge-scraper-vm --zone=us-central1-a --tunnel-through-iap

# 2. Pull the latest commits
cd /opt/mge/mge-triage-hub
sudo -u mge git pull origin main

# 3. If Python dependencies changed, update venv
# sudo -u mge /opt/mge/venv/bin/pip install -r requirements.txt

# 4. Restart the timer to refresh unit configuration
sudo systemctl daemon-reload
sudo systemctl restart mge-scraper.timer

# 5. Verify timer status
systemctl list-timers mge-scraper.timer
```

---

## 12. Troubleshooting Guide

| Issue / Error Code | Root Cause | Exact Resolution |
|---|---|---|
| **Chromium crash / `SIGKILL` / `TargetClosedError`** | VM ran out of memory (1 GB RAM exhausted). Swap was not configured. | Verify swap is active: `free -h` and `swapon --show`. Re-run Step 4.4 if swap is 0. |
| **`NOT_LOGGED_IN` / 2FA Challenge** | NetSuite 30-day "Trust this device" token expired, or password was changed. | Re-authenticate interactively, check "Trust this device for 30 days", or migrate to TBA (Section 7.3). |
| **`NETSUITE_IP_BLOCKED`** | VM was stopped and restarted, causing the ephemeral IP to change. | Log in from an exempt NetSuite account, check current IP (`curl -s ifconfig.me`), and update NetSuite's IP Address Restriction table. |
| **`GH_PUT_401` / `GH_PUT_403`** | GitHub Deploy Key lacks write access, or PAT has expired / lacks `Contents: Read and write`. | Re-check key at `github.com/SamBar1106/mge-triage-hub/settings/keys` and ensure "Allow write access" is ticked. |
| **`SKIPPED_SHRUNK:clients_directory.csv`** | NetSuite returned significantly fewer client rows than yesterday. Safeguard engaged. | Inspect NetSuite saved search 72 manually. Run scraper manually once confirmed: `sudo systemctl start mge-scraper.service`. |
| **Timer did not fire at 10:00 AM** | VM timezone is not set to `America/Chicago`. | Run `sudo timedatectl set-timezone America/Chicago` and `sudo systemctl restart mge-scraper.timer`. |
| **`SSH: connect to host ... port 22: Connection refused`** | Firewall rule blocks external SSH. | Always use IAP: `gcloud compute ssh mge-scraper-vm --zone=us-central1-a --tunnel-through-iap`. |

---

## 13. Decommissioning: Clean Teardown to Stop All Billing

If you ever wish to retire the VM and ensure Google Cloud bills exactly **$0.00**:

```bash
# 1. Delete the VM instance and its attached boot disk
gcloud compute instances delete mge-scraper-vm --zone=us-central1-a --quiet

# 2. Confirm no orphaned persistent disks remain
gcloud compute disks list

# 3. Confirm no static IP reservations remain
gcloud compute addresses list

# 4. (Optional) Delete the entire GCP project to wipe all cloud resources
gcloud projects delete mge-triage-scraper --quiet
```
*Deleting the project releases all IP allocations, destroys all storage, and immediately stops all billing.*
