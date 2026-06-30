---
layout: writeup
title: "The Service Account That Owned the Forest"
date: 2020-03-22
description: "Forest is an Easy-rated AD box that hits like a hard one. AS-REP roast a service account that skipped its own pre-auth, ride an Exchange group's ACL to grant yourself replication rights, then DCSync every hash in the domain."
image: /assets/og/forest.png
tags: [hackthebox, activedirectory, asreproast, dcsync, windows, writeup]
---

# The Service Account That Owned the Forest

**HTB Forest — roast an account that skipped its own ID check, then ride an Exchange group's permissions until you can ask the domain controller to read you every password it owns**

Forest is rated Easy, and that rating is a small lie. The front door is one specific Active Directory misconfiguration, and the path from foothold to Domain Admin is not an exploit at all. It is a chain of permissions that each look reasonable on their own and add up to one ugly sentence: this low service account can rewrite the locks on the entire domain. I rooted it while it was active, and it sent me down a multi-week road trying to actually understand why each step worked. This is that road, paved.

```
        F O R E S T
        ===========
        null session    ->  the directory reads you the staff list
                   |
        as-rep roast    ->  svc-alfresco skipped pre-auth, crack it at home
                   |
        evil-winrm      ->  foothold as the service account
                   |
        bloodhound      ->  a path: you can edit a group that can edit the domain
                   |
        write your name ->  into a group that holds WriteDacl on the domain
                   |
        dcsync          ->  ask the DC, politely, for every hash it owns
                   |
                   v
        you never cracked the administrator's password.
        you earned the right to be told it.
                                                            森
```

## 0x01 · the directory answers anyone

The scan is a Windows domain controller wearing every hat at once. Kerberos on 88, LDAP on 389, SMB on 445, WinRM on 5985, DNS on 53, and a swarm of RPC ports. The LDAP banner hands over the domain name, `htb.local`.

```
PORT     STATE SERVICE       VERSION
53/tcp   open  domain
88/tcp   open  kerberos-sec  Microsoft Windows Kerberos
389/tcp  open  ldap          Active Directory LDAP (Domain: htb.local)
445/tcp  open  microsoft-ds  Windows Server 2016
5985/tcp open  http          WinRM 2.0
```

A domain controller's whole job is to answer questions about the domain, and this one does not check who is asking. RPC accepts a null session, which is a login with no username and no password, and that is enough to read the entire user list:

```
# rpcclient -U "" -N 10.10.10.161
rpcclient $> enumdomusers
user:[Administrator]   user:[svc-alfresco]
user:[sebastien]       user:[lucinda]
user:[andy]   user:[mark]   user:[santi]   ...
```

A null session is a front desk that reads you the entire staff directory the moment you ask, no badge required. Most of these are normal people. One stands out, `svc-alfresco`, a service account, the kind created for software and then forgotten by humans.

## 0x02 · the account that skipped its ID

Kerberos normally makes you prove who you are before it hands you a ticket, and that proof step is called pre-authentication. Some accounts get it switched off, usually so old software that cannot do pre-auth can still log in. An account with pre-auth disabled is a gift. You can ask the domain controller for that account's login ticket without proving anything, and the ticket comes back encrypted with the account's own password. Take it home and crack it at your leisure.

That attack is AS-REP roasting. `GetNPUsers.py` asks Kerberos for any ticket it will hand over without pre-auth, and `svc-alfresco` answers:

```
# GetNPUsers.py htb.local/svc-alfresco -no-pass -dc-ip 10.10.10.161
$krb5asrep$23$svc-alfresco@HTB.LOCAL:e6ca8328a5e6...   (truncated)
```

It is a locked box whose key is the account's password, and the domain just handed you the box. `hashcat` with `rockyou.txt` opens it in seconds. The password is `s3rvice`, and those creds log straight into WinRM:

```
# evil-winrm -u svc-alfresco -p s3rvice -i 10.10.10.161
*Evil-WinRM* PS C:\Users\svc-alfresco\Documents> type ..\Desktop\user.txt
████████████████████████████████
```

## 0x03 · drawing the map

A foothold in AD is not the same as knowing what your foothold is worth. To find that out you map the domain's permissions, and the tool for that is BloodHound. SharpHound collects the raw data, every user, group, and access-control entry, and BloodHound graphs it so you can ask one question: is there a path from where I am to Domain Admin?

BloodHound is the property-records office for the whole domain. On its own, each entry is dull. Drawn as a graph, it shows that the boring service account you own is three handshakes from the master keys. Forest's path reads like this:

```
svc-alfresco                  -(MemberOf)->    Account Operators
Account Operators             -(can manage)->  Exchange Windows Permissions
Exchange Windows Permissions  -(WriteDacl)->   htb.local   (the domain object)
```

Each arrow is a real, intended permission. The chain of them is the bug.

## 0x04 · writing your own name on the roster

`svc-alfresco` sits in **Account Operators**, a group that can manage most other groups. So the first move is to add yourself to a group that actually matters. **Exchange Windows Permissions** matters, because Exchange installs with the right to edit the access-control list on the domain object itself, the permission called `WriteDacl`.

```
*Evil-WinRM* PS> net group "Exchange Windows Permissions" svc-alfresco /add /domain
```

Being a junior clerk who is allowed to edit the permission list is the same as being the boss, because you can simply write yourself onto the list. Holding `WriteDacl` on the domain, you grant your own account the two replication rights a domain controller uses to sync the password database:

```
# grant svc-alfresco the DS-Replication-Get-Changes rights on htb.local
```

You did not steal a key. You gave yourself the right to a key, in writing, with the pen they left on the desk.

## 0x05 · pretending to be a domain controller

Those replication rights exist so that one domain controller can ask another for "all the password hashes, please" and stay in sync. Granted to you, they let you make the same request from your own laptop. That is DCSync. You impersonate a domain controller and ask the real one to replicate its secrets to you:

```
# secretsdump.py htb.local/svc-alfresco@10.10.10.161 -just-dc-user Administrator
htb.local\Administrator:500:aad3b435...:32693b11e6aa90eb43d3...:::
```

DCSync is a brand-new bank branch phoning head office to say "sync me the full customer database," and head office, trusting the branch, doing it. With the Administrator NTLM hash you never need the cleartext. Pass the hash straight into a login for a shell on the domain controller:

```
# evil-winrm -u Administrator -H 32693b11e6aa90eb43d3... -i 10.10.10.161
*Evil-WinRM* PS C:\Users\Administrator\Desktop> type root.txt
████████████████████████████████
```

## 0x06 · the honest caveat

Nothing in Forest was unpatched. Every link was a permission working exactly as designed. Pre-authentication was disabled on `svc-alfresco` on purpose, probably for some integration that needed it years ago. Account Operators can manage groups by design. Exchange really does install with `WriteDacl` on the domain, by design. The vulnerability is the *chain*, and chains like this are invisible unless you graph them, which is the entire reason BloodHound exists.

The lesson is the one AD keeps teaching. Membership is power, and nested membership is power you cannot see by reading a single group. "Account Operators" sounds like middle management and functions, two hops later, like a domain administrator. Audit your AS-REP-disabled accounts, audit who can edit privileged groups, and run BloodHound against your own domain before someone else does. The fix is not a patch. It is reading your own org chart the way an attacker reads it.

## 0x07 · outro

```
a directory that read its staff list to a stranger.
an account that skipped the ID check and got cracked at home.
a clerk who was allowed to edit the very list that named the bosses.
a controller that synced its secrets to anyone holding the right slip of paper.

nothing here was unpatched. every door was a permission doing its job.
you never guessed the administrator's password. you earned the right to be handed it.

ask for the list. roast the ticket. edit the roster. sync the vault. wear black.

                                                            EOF
```

---

*HTB: Forest — an Easy-rated Windows domain controller retired in March 2020 that teaches Active Directory privilege escalation better than most Hard boxes. AS-REP roasting for the foothold, a nested-group ACL path to WriteDacl, and DCSync for the crown. The only thing actually broken was the org chart.*
