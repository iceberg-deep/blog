---
layout: post
title: "TIL: AS-REP roasting in one line"
tags: [active-directory, kerberos, til]
---

Revisiting **Forest** reminded me how clean AS-REP roasting is when an account has *Kerberos pre-authentication* disabled (`DONT_REQ_PREAUTH`). You can ask the KDC for an AS-REP and crack the encrypted timestamp offline — no creds needed beyond a valid username.

### The one-liner

```bash
impacket-GetNPUsers domain.local/ -dc-ip 10.10.10.x -usersfile users.txt -no-pass -format hashcat
```

Then crack it:

```bash
hashcat -m 18200 asrep.hash rockyou.txt
```

### Why it works

If pre-auth is off, the KDC will hand out a TGT response whose timestamp is encrypted with the user's key. That's effectively an offline-crackable hash. The fix is just: **leave pre-authentication enabled** (it's on by default for a reason).

Small thing, but a great reminder that the easiest AD foothold is often a single misconfigured checkbox.
